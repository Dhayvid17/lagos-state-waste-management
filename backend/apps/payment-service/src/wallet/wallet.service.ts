import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import * as crypto from 'crypto';
import type { JwtPayload } from '@app/shared';
import { NatsEvents, UserRole } from '@app/shared';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentProviderInterface } from '../interfaces/payment-provider.interface';
import { FLUTTERWAVE_PROVIDER, PAYSTACK_PROVIDER } from '../interfaces/payment-provider.interface';
export interface RedeemPointsDto {
  pointsAmount: number; // How many points to convert to cash
  idempotencyKey: string;
}
export interface VerifyBankAccountDto {
  accountNumber: string;
  bankCode: string;
  provider?: 'FLUTTERWAVE' | 'PAYSTACK';
}
export interface WithdrawalRequestDto {
  amountNgn: number; // Amount in naira
  bankCode: string;
  accountNumber: string;
  provider?: 'FLUTTERWAVE' | 'PAYSTACK';
  idempotencyKey: string; // Client must send this to prevent duplicate withdrawals
}
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly pointsToNairaRate: number;
  private readonly minimumWithdrawalNgn: number;
  private readonly maximumWithdrawalNgn: number;
  private readonly withdrawalFeePercent: number;
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    @Inject(FLUTTERWAVE_PROVIDER)
    private readonly flutterwave: PaymentProviderInterface,
    @Inject(PAYSTACK_PROVIDER)
    private readonly paystack: PaymentProviderInterface,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {
    this.pointsToNairaRate = this.configService.get<number>('payment.wallet.pointsToNairaRate')!;
    this.minimumWithdrawalNgn = this.configService.get<number>(
      'payment.wallet.minimumWithdrawalNgn',
    )!;
    this.maximumWithdrawalNgn = this.configService.get<number>(
      'payment.wallet.maximumWithdrawalNgn',
    )!;
    this.withdrawalFeePercent = this.configService.get<number>(
      'payment.wallet.withdrawalFeePercent',
    )!;
  }
  // ============================================================
  // AWARD POINTS — Called via NATS when report.completed fires
  // ============================================================
  async awardPoints(
    authId: string,
    points: number,
    reportId: string,
    reference: string,
  ): Promise<void> {
    // ── Idempotency check — if this reference already processed, skip
    const existing = await this.prisma.walletTransaction.findUnique({
      where: { reference },
    });
    if (existing) {
      this.logger.warn(`Points already awarded for reference: ${reference} — skipping`);
      return;
    }
    try {
      // ── Get or Create wallet (Atomic Upsert to prevent race conditions)
      const wallet = await this.prisma.wallet.upsert({
        where: { authId },
        update: {}, // If exists, don't change anything
        create: { authId },
      });
      // ── Append ledger entry — points credit (not yet cash)
      await this.prisma.$transaction(async (tx) => {
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'POINTS_CREDIT',
            status: 'SUCCESS',
            amountKobo: 0, // Points credit has no kobo value yet
            pointsAmount: points,
            reference,
            description: `Points awarded for report ${reportId}`,
            reportId,
            metadata: { reportId, pointsAwarded: points } as any,
          },
        });
        // ── Update lifetime points on wallet (cached stat)
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { totalPointsEarned: { increment: points } },
        });
        // ── Write audit log
        await tx.paymentAuditLog.create({
          data: {
            actorId: 'system',
            actorRole: 'SYSTEM',
            action: 'POINTS_AWARDED',
            targetId: wallet.id,
            targetType: 'WALLET',
            metadata: { reportId, pointsAwarded: points, reference } as any,
          },
        });
      });
      this.logger.log(`${points} points awarded to ${authId} for report ${reportId}`);
    } catch (error) {
      this.logger.error(
        `Failed to award points to ${authId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error; // Rethrow for NATS handler to catch and retry
    }
  }
  // ============================================================
  // REDEEM POINTS → WALLET BALANCE
  // Converts points to naira and credits internal wallet
  // ============================================================
  async redeemPoints(user: JwtPayload, dto: RedeemPointsDto) {
    if (dto.pointsAmount <= 0) {
      throw new BadRequestException('Points amount must be greater than zero');
    }
    const wallet = await this.prisma.wallet.findUnique({
      where: { authId: user.sub },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    // ── Check available points balance
    const pointsBalance = await this.getPointsBalance(wallet.id);
    if (pointsBalance < dto.pointsAmount) {
      throw new BadRequestException(
        `Insufficient points. Available: ${pointsBalance}, requested: ${dto.pointsAmount}`,
      );
    }
    // ── Calculate naira value
    const amountNgn = dto.pointsAmount / this.pointsToNairaRate;
    const amountKobo = Math.floor(amountNgn * 100);
    const reference = dto.idempotencyKey;
    // ── Idempotency check
    const existing = await this.prisma.walletTransaction.findUnique({
      where: { reference },
    });
    if (existing) {
      throw new ConflictException('Redemption already processed');
    }
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Points debit entry
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'POINTS_CREDIT',
            status: 'SUCCESS',
            amountKobo: 0,
            pointsAmount: -dto.pointsAmount, // Negative = points consumed
            reference: `${reference}_debit`,
            description: `Points redeemed: ${dto.pointsAmount} points → â‚¦${amountNgn}`,
            metadata: { redemptionReference: reference } as any,
          },
        });
        // Wallet credit entry
        const creditEntry = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'WALLET_CREDIT',
            status: 'SUCCESS',
            amountKobo,
            pointsAmount: dto.pointsAmount,
            reference,
            description: `Wallet credited: ${dto.pointsAmount} points = â‚¦${amountNgn}`,
            metadata: { pointsRedeemed: dto.pointsAmount, amountKobo } as any,
          },
        });
        // Update cached balance
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { cachedBalanceKobo: { increment: amountKobo } },
        });
        // Audit log
        await tx.paymentAuditLog.create({
          data: {
            actorId: user.sub,
            actorRole: user.role,
            action: 'POINTS_REDEEMED',
            targetId: wallet.id,
            targetType: 'WALLET',
            metadata: { pointsRedeemed: dto.pointsAmount, amountKobo, reference } as any,
          },
        });
        return creditEntry;
      });
      return {
        message: 'Points redeemed successfully',
        pointsRedeemed: dto.pointsAmount,
        amountCredited: amountNgn,
        reference,
      };
    } catch (error) {
      this.logger.error(`Points redemption failed for ${user.sub}: ${(error as Error).message}`);
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw new InternalServerErrorException('Points redemption failed');
    }
  }
  // ============================================================
  // GET WALLET BALANCE
  // ============================================================
  async getMyWallet(user: JwtPayload) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { authId: user.sub },
    });
    if (!wallet) {
      // Auto-create wallet on first access
      const newWallet = await this.prisma.wallet.create({
        data: { authId: user.sub },
      });
      return this.formatWalletResponse(newWallet, 0, 0);
    }
    const [balanceKobo, pointsBalance] = await Promise.all([
      this.getWalletBalance(wallet.id),
      this.getPointsBalance(wallet.id),
    ]);
    return this.formatWalletResponse(wallet, balanceKobo, pointsBalance);
  }
  // ============================================================
  // REQUEST WITHDRAWAL
  // Uses row lock to prevent double-spend
  // ============================================================
  async requestWithdrawal(user: JwtPayload, dto: WithdrawalRequestDto) {
    try {
      // ── Minimum/maximum check
      if (dto.amountNgn < this.minimumWithdrawalNgn) {
        throw new BadRequestException(`Minimum withdrawal is â‚¦${this.minimumWithdrawalNgn}`);
      }
      if (dto.amountNgn > this.maximumWithdrawalNgn) {
        throw new BadRequestException(`Maximum withdrawal is â‚¦${this.maximumWithdrawalNgn}`);
      }
      const amountKobo = Math.floor(dto.amountNgn * 100);
      const feeKobo = Math.floor(amountKobo * (this.withdrawalFeePercent / 100));
      const netKobo = amountKobo - feeKobo;
      // ── Idempotency — if same idempotencyKey seen before, return existing
      const existing = await this.prisma.withdrawalRequest.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.warn(`Duplicate withdrawal request: ${dto.idempotencyKey}`);
        return existing;
      }
      // ── Select provider (default: Flutterwave)
      const provider = dto.provider ?? 'FLUTTERWAVE';
      const providerService = provider === 'PAYSTACK' ? this.paystack : this.flutterwave;
      // ── Verify bank account before locking funds
      const verified = await providerService.verifyBankAccount(dto.accountNumber, dto.bankCode);
      if (!verified.isValid) {
        throw new BadRequestException('Bank account verification failed');
      }
      // ── Database transaction with balance check + row lock
      const result = await this.prisma.$transaction(async (tx) => {
        // Find wallet with raw row lock — prevents concurrent withdrawals
        const wallets = await tx.$queryRawUnsafe<any[]>(
          `SELECT * FROM "payments"."wallets" WHERE "authId" = $1 FOR UPDATE`,
          user.sub,
        );
        const wallet = wallets[0];
        if (!wallet) throw new NotFoundException('Wallet not found');
        // ── Daily limit check (Lagos timezone WAT = UTC+1)
        const nowUtc = new Date();
        const lagosOffsetMs = 60 * 60 * 1000;
        const lagosNow = new Date(nowUtc.getTime() + lagosOffsetMs);
        const lagosStartOfDay = new Date(lagosNow);
        lagosStartOfDay.setUTCHours(0, 0, 0, 0);
        const utcStartOfDay = new Date(lagosStartOfDay.getTime() - lagosOffsetMs);
        const todayWithdrawals = await tx.withdrawalRequest.aggregate({
          where: {
            authId: user.sub,
            status: { in: ['PENDING', 'PROCESSING', 'SUCCESS'] },
            createdAt: { gte: utcStartOfDay },
          },
          _sum: { amountKobo: true },
        });
        const todayTotalKobo = todayWithdrawals._sum.amountKobo ?? 0;
        const dailyMaxKobo = this.maximumWithdrawalNgn * 100;
        if (todayTotalKobo + amountKobo > dailyMaxKobo) {
          const remainingNgn = (dailyMaxKobo - todayTotalKobo) / 100;
          throw new BadRequestException(
            `Daily withdrawal limit of â‚¦${this.maximumWithdrawalNgn} exceeded. ` +
              `Remaining today: â‚¦${Math.max(0, remainingNgn)}`,
          );
        }
        // Recalculate balance inside transaction (source of truth)
        const balanceResult = await tx.walletTransaction.aggregate({
          where: { walletId: wallet.id, status: { in: ['SUCCESS', 'PENDING', 'PROCESSING'] } },
          _sum: { amountKobo: true },
        });
        const currentBalance = balanceResult._sum.amountKobo ?? 0;
        // ── Balance check inside transaction — prevents double-spend
        if (currentBalance < amountKobo) {
          throw new BadRequestException(
            `Insufficient balance. Available: â‚¦${currentBalance / 100}, requested: â‚¦${dto.amountNgn}`,
          );
        }
        // ── Create withdrawal request
        const withdrawal = await tx.withdrawalRequest.create({
          data: {
            walletId: wallet.id,
            authId: user.sub,
            amountKobo,
            feeKobo,
            netAmountKobo: netKobo,
            bankCode: dto.bankCode,
            bankName: verified.bankName,
            accountNumber: dto.accountNumber,
            accountName: verified.accountName,
            provider: provider as any,
            status: 'PENDING',
            idempotencyKey: dto.idempotencyKey,
          },
        });
        // ── Debit wallet immediately (pending debit)
        const reference = `withdrawal_${withdrawal.id}`;
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'WALLET_DEBIT',
            status: 'PENDING', // Becomes SUCCESS when transfer succeeds
            amountKobo: -amountKobo, // Negative = debit
            reference,
            description: `Withdrawal request: â‚¦${dto.amountNgn} to ${verified.accountName}`,
            withdrawalId: withdrawal.id,
            metadata: { withdrawalId: withdrawal.id, provider } as any,
          },
        });
        // ── Fee entry
        if (feeKobo > 0) {
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: 'WITHDRAWAL_FEE',
              status: 'PENDING',
              amountKobo: -feeKobo,
              reference: `${reference}_fee`,
              description: `Processing fee (${this.withdrawalFeePercent}%)`,
              withdrawalId: withdrawal.id,
              metadata: { feePercent: this.withdrawalFeePercent } as any,
            },
          });
        }
        // ── Update cached balance
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { cachedBalanceKobo: { decrement: amountKobo } },
        });
        // ── Audit log
        await tx.paymentAuditLog.create({
          data: {
            actorId: user.sub,
            actorRole: user.role,
            action: 'WITHDRAWAL_REQUESTED',
            targetId: withdrawal.id,
            targetType: 'WITHDRAWAL',
            metadata: {
              amountKobo,
              feeKobo,
              netKobo,
              provider,
              accountNumber: dto.accountNumber,
              bankCode: dto.bankCode,
            } as any,
          },
        });
        return withdrawal;
      });
      // ── Initiate actual bank transfer OUTSIDE transaction
      // Rule: NATS emit() calls must NOT be inside DB transactions
      try {
        const transferResult = await providerService.initiateTransfer(
          netKobo,
          {
            bankCode: dto.bankCode,
            accountNumber: verified.accountNumber,
            accountName: verified.accountName,
            bankName: verified.bankName,
          },
          `withdrawal_${result.id}`,
          `Lagos Waste withdrawal - ${user.sub}`,
        );
        // ── Update withdrawal with provider reference
        await this.prisma.withdrawalRequest.update({
          where: { id: result.id },
          data: {
            status: 'PROCESSING',
            providerReference: transferResult.providerReference,
            providerResponse: transferResult.providerResponse as any,
            processedAt: new Date(),
          },
        });
        // ── Update debit ledger entry to PROCESSING
        await this.prisma.walletTransaction.updateMany({
          where: { withdrawalId: result.id },
          data: { status: 'PROCESSING' },
        });
      } catch (error) {
        // ── Transfer failed — reverse the debit
        await this.reverseFailedWithdrawal(result.id, (error as Error).message);
        throw new BadRequestException(`Transfer initiation failed: ${(error as Error).message}`);
      }
      // ── Fire NATS event outside transaction (Rule 10)
      this.natsClient.emit(NatsEvents.PAYMENT_SUCCESS, {
        authId: user.sub,
        withdrawalId: result.id,
        amountNgn: dto.amountNgn,
        provider,
        timestamp: new Date().toISOString(),
      });
      return {
        message: 'Withdrawal request submitted successfully',
        withdrawalId: result.id,
        amountRequested: dto.amountNgn,
        fee: feeKobo / 100,
        amountToReceive: netKobo / 100,
        provider,
        status: 'PROCESSING',
      };
    } catch (error) {
      this.logger.error(
        `Withdrawal failed for ${user.sub}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Withdrawal processing failed');
    }
  }
  // ============================================================
  // GET TRANSACTION HISTORY
  // ============================================================
  async getTransactionHistory(user: JwtPayload, page: number = 1, limit: number = 20) {
    // ── Guard NaN
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const wallet = await this.prisma.wallet.findUnique({
      where: { authId: user.sub },
    });
    if (!wallet) return { data: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    const skip = (safePage - 1) * safeLimit;
    const [data, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true,
          type: true,
          status: true,
          amountKobo: true,
          pointsAmount: true,
          description: true,
          reference: true,
          createdAt: true,
        },
      }),
      this.prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);
    return {
      data: data.map((t) => ({
        ...t,
        amountNgn: t.amountKobo / 100,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }
  // ============================================================
  // BANK OPERATIONS
  // ============================================================
  async verifyBankAccount(user: JwtPayload, dto: VerifyBankAccountDto) {
    await this.enforceVerifyRateLimit(user.sub);
    const provider = dto.provider === 'PAYSTACK' ? this.paystack : this.flutterwave;
    return provider.verifyBankAccount(dto.accountNumber, dto.bankCode);
  }
  private async enforceVerifyRateLimit(authId: string): Promise<void> {
    const key = `verify_bank_rate:${authId}`;
    const count = await this.redis.incr(key);
    // Set expiry on first attempt (NX = only if not exists)
    // Limit: 10 attempts per hour (3600 seconds)
    await (this.redis as any).call('EXPIRE', key, 3600, 'NX');
    if (count > 10) {
      this.logger.warn(`Rate limit exceeded for bank verification: ${authId}`);
      throw new BadRequestException(
        'Too many bank account verification attempts. Please try again in an hour.',
      );
    }
  }
  // ============================================================
  // GET BANK LIST
  // ============================================================
  async getBankList(provider: 'FLUTTERWAVE' | 'PAYSTACK' = 'FLUTTERWAVE') {
    const cacheKey = `bank_list:${provider}`;
    // ── Check cache first
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.log(`Serving bank list for ${provider} from cache`);
        return JSON.parse(cached);
      }
    } catch (err) {
      this.logger.warn(`Redis cache read failed: ${(err as Error).message}`);
    }
    // ── Fetch from provider
    const providerService = provider === 'PAYSTACK' ? this.paystack : this.flutterwave;
    const banks = await providerService.getBankList();
    // ── Cache for 6 hours (EX = seconds)
    try {
      await this.redis.set(cacheKey, JSON.stringify(banks), 'EX', 6 * 60 * 60);
    } catch (err) {
      this.logger.warn(`Redis cache write failed: ${(err as Error).message}`);
    }
    return banks;
  }
  // ============================================================
  // HANDLE WEBHOOK — Called by controller after signature verified
  // ============================================================
  async handleWebhookEvent(
    provider: 'FLUTTERWAVE' | 'PAYSTACK',
    eventType: string,
    eventId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    // ── Atomic gate — only ONE process can create this record
    let webhookRecord;
    try {
      webhookRecord = await this.prisma.webhookEvent.create({
        data: {
          provider: provider as any,
          eventType,
          webhookId: eventId,
          rawPayload: data as any,
          processed: false,
        },
      });
    } catch (error) {
      // P2002 = unique constraint violation = duplicate webhook
      if ((error as any).code === 'P2002') {
        this.logger.warn(`Duplicate webhook received: ${eventId} — skipping`);
        return;
      }
      throw error;
    }
    // ── Only ONE process reaches here for any given eventId
    try {
      await this.processWebhookLogic(eventType, data);
      // ── Mark webhook as processed
      await this.prisma.webhookEvent.update({
        where: { id: webhookRecord.id },
        data: { processed: true, processedAt: new Date() },
      });
    } catch (error) {
      await this.prisma.webhookEvent.update({
        where: { id: webhookRecord.id },
        data: { errorMessage: (error as Error).message },
      });
      throw error;
    }
  }
  // ── Public retry method for the Cron task
  async retryWebhookProcessing(webhook: any): Promise<void> {
    try {
      await this.processWebhookLogic(webhook.eventType, webhook.rawPayload as any);
      await this.prisma.webhookEvent.update({
        where: { id: webhook.id },
        data: { processed: true, processedAt: new Date(), errorMessage: null },
      });
    } catch (error) {
      await this.prisma.webhookEvent.update({
        where: { id: webhook.id },
        data: { errorMessage: (error as Error).message },
      });
      throw error;
    }
  }
  // ── Unified processing logic shared by webhook + retry
  private async processWebhookLogic(
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (eventType === 'transfer.success' || eventType === 'transfer.completed') {
      await this.handleTransferSuccess(data);
    } else if (eventType === 'transfer.failed' || eventType === 'transfer.reversed') {
      await this.handleTransferFailed(data);
    }
  }
  // ============================================================
  // NATS — Handle points.awarded event from report-service
  // ============================================================
  async handlePointsAwarded(payload: {
    reportId: string;
    reporterAuthId: string;
    pointsAwarded: number;
    timestamp: string;
  }): Promise<void> {
    const reference = `points_${payload.reportId}`;
    await this.awardPoints(
      payload.reporterAuthId,
      payload.pointsAwarded,
      payload.reportId,
      reference,
    );
  }
  // ============================================================
  // ADMIN — GET ALL WALLETS
  // ============================================================
  async getAllWallets(user: JwtPayload, page: number = 1, limit: number = 20) {
    if (user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only SYS_ADMIN can view all wallets');
    }
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;
    const [data, total] = await Promise.all([
      this.prisma.wallet.findMany({
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          authId: true,
          cachedBalanceKobo: true,
          totalPointsEarned: true,
          totalAmountWithdrawn: true,
          createdAt: true,
        },
      }),
      this.prisma.wallet.count(),
    ]);
    return {
      data: data.map((w) => ({
        ...w,
        cachedBalanceNgn: w.cachedBalanceKobo / 100,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }
  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  private async getWalletBalance(walletId: string): Promise<number> {
    const result = await this.prisma.walletTransaction.aggregate({
      where: { walletId, status: { in: ['SUCCESS', 'PENDING', 'PROCESSING'] } },
      _sum: { amountKobo: true },
    });
    return result._sum.amountKobo ?? 0;
  }
  private async getPointsBalance(walletId: string): Promise<number> {
    const result = await this.prisma.walletTransaction.aggregate({
      where: { walletId, type: 'POINTS_CREDIT', status: 'SUCCESS' },
      _sum: { pointsAmount: true },
    });
    return result._sum.pointsAmount ?? 0;
  }
  private formatWalletResponse(wallet: any, balanceKobo: number, pointsBalance: number) {
    return {
      id: wallet.id,
      authId: wallet.authId,
      balanceNgn: balanceKobo / 100,
      balanceKobo,
      pointsBalance,
      pointsValueNgn: pointsBalance / this.pointsToNairaRate,
      totalPointsEarned: wallet.totalPointsEarned,
      createdAt: wallet.createdAt,
    };
  }
  private async handleTransferSuccess(data: Record<string, unknown>): Promise<void> {
    const reference = String(data.reference ?? data.tx_ref ?? '');
    if (!reference) return;
    // Find the withdrawal by provider reference or our internal reference
    const withdrawal = await this.prisma.withdrawalRequest.findFirst({
      where: {
        OR: [{ providerReference: String(data.id ?? '') }, { idempotencyKey: reference }],
      },
    });
    if (!withdrawal) {
      this.logger.warn(`No withdrawal found for transfer: ${reference}`);
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      // ── Update withdrawal status
      await tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: { status: 'SUCCESS', processedAt: new Date() },
      });
      // ── Mark ledger entries as SUCCESS
      await tx.walletTransaction.updateMany({
        where: { withdrawalId: withdrawal.id },
        data: { status: 'SUCCESS' },
      });
      // ── Update wallet lifetime withdrawal stat
      await tx.wallet.update({
        where: { id: withdrawal.walletId },
        data: { totalAmountWithdrawn: { increment: withdrawal.netAmountKobo } },
      });
      // ── Audit log
      await tx.paymentAuditLog.create({
        data: {
          actorId: 'system',
          actorRole: 'SYSTEM',
          action: 'WITHDRAWAL_SUCCESS',
          targetId: withdrawal.id,
          targetType: 'WITHDRAWAL',
          metadata: { reference, data } as any,
        },
      });
    });
    this.logger.log(`Transfer success: withdrawal ${withdrawal.id}`);
  }
  private async handleTransferFailed(data: Record<string, unknown>): Promise<void> {
    const reference = String(data.reference ?? data.tx_ref ?? '');
    const withdrawal = await this.prisma.withdrawalRequest.findFirst({
      where: {
        OR: [{ providerReference: String(data.id ?? '') }, { idempotencyKey: reference }],
      },
    });
    if (!withdrawal) return;
    await this.reverseFailedWithdrawal(
      withdrawal.id,
      String(data.complete_message ?? data.message ?? 'Transfer failed'),
    );
  }
  private async reverseFailedWithdrawal(withdrawalId: string, reason: string): Promise<void> {
    const withdrawal = await this.prisma.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
    });
    if (!withdrawal) return;
    if (withdrawal.status === 'FAILED') return; // Already reversed
    await this.prisma.$transaction(async (tx) => {
      // ── Mark withdrawal as failed
      await tx.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: { status: 'FAILED', failureReason: reason },
      });
      // ── Reverse the debit — credit back to wallet
      await tx.walletTransaction.create({
        data: {
          walletId: withdrawal.walletId,
          type: 'REFUND',
          status: 'SUCCESS',
          amountKobo: withdrawal.amountKobo, // Positive = credit back
          reference: `refund_${withdrawalId}`,
          description: `Refund for failed withdrawal: ${reason}`,
          withdrawalId,
          metadata: { reason, originalWithdrawalId: withdrawalId } as any,
        },
      });
      // ── Mark original ledger entries as FAILED
      await tx.walletTransaction.updateMany({
        where: { withdrawalId },
        data: { status: 'FAILED' },
      });
      // ── Restore cached balance
      await tx.wallet.update({
        where: { id: withdrawal.walletId },
        data: { cachedBalanceKobo: { increment: withdrawal.amountKobo } },
      });
      // ── Audit
      await tx.paymentAuditLog.create({
        data: {
          actorId: 'system',
          actorRole: 'SYSTEM',
          action: 'WITHDRAWAL_REVERSED',
          targetId: withdrawalId,
          targetType: 'WITHDRAWAL',
          metadata: { reason } as any,
        },
      });
    });
    this.logger.warn(`Withdrawal ${withdrawalId} reversed: ${reason}`);
  }
}
