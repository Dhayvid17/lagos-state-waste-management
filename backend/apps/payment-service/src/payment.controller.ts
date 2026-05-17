import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, Public, Roles, UserRole } from '@app/shared';

import { WalletService } from './wallet/wallet.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { PaystackProvider } from './providers/paystack.provider';
import { RedeemPointsDto, WithdrawalRequestDto, VerifyBankAccountDto } from './dto/payment.dto';

@ApiTags('Payments')
@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly flutterwaveProvider: FlutterwaveProvider,
    private readonly paystackProvider: PaystackProvider,
  ) {}

  // ============================================================
  // WALLET ENDPOINTS
  // ============================================================

  // ── GET /api/payments/wallet
  @Get('wallet')
  @ApiOperation({ summary: 'Get my wallet balance and stats' })
  getMyWallet(@CurrentUser() user: JwtPayload) {
    return this.walletService.getMyWallet(user);
  }

  // ── POST /api/payments/wallet/redeem
  @Post('wallet/redeem')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem points to wallet balance' })
  redeemPoints(@CurrentUser() user: JwtPayload, @Body() dto: RedeemPointsDto) {
    return this.walletService.redeemPoints(user, dto);
  }

  // ── GET /api/payments/wallet/transactions
  @Get('wallet/transactions')
  @ApiOperation({ summary: 'Get my transaction history' })
  getTransactionHistory(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.walletService.getTransactionHistory(user, safePage, safeLimit);
  }

  // ============================================================
  // WITHDRAWAL ENDPOINTS
  // ============================================================

  // ── POST /api/payments/withdrawal
  @Post('withdrawal')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a bank withdrawal from wallet' })
  requestWithdrawal(@CurrentUser() user: JwtPayload, @Body() dto: WithdrawalRequestDto) {
    return this.walletService.requestWithdrawal(user, dto);
  }

  // ── POST /api/payments/bank/verify
  @Post('bank/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify bank account details before withdrawal' })
  verifyBankAccount(@CurrentUser() user: JwtPayload, @Body() dto: VerifyBankAccountDto) {
    return this.walletService.verifyBankAccount(user, dto);
  }

  // ── GET /api/payments/banks
  @Get('banks')
  @ApiOperation({ summary: 'Get list of supported banks' })
  getBankList(@Query('provider') provider: 'FLUTTERWAVE' | 'PAYSTACK' = 'FLUTTERWAVE') {
    return this.walletService.getBankList(provider);
  }

  // ============================================================
  // ADMIN ENDPOINTS
  // ============================================================

  // ── GET /api/payments/admin/wallets
  @Get('admin/wallets')
  @Roles(UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'List all wallets — SYS_ADMIN only' })
  getAllWallets(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.walletService.getAllWallets(user, safePage, safeLimit);
  }

  // ============================================================
  // WEBHOOK ENDPOINTS
  // Both @Public() — security via HMAC signature only
  // Raw body preserved by RawBodyMiddleware
  // ============================================================

  // ── POST /api/payments/webhook/flutterwave
  @Public()
  @Post('webhook/flutterwave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Flutterwave webhook receiver' })
  async handleFlutterwaveWebhook(@Req() req: Request) {
    const rawBody = (req as any).rawBody as Buffer;
    const signature = (req.headers['verif-hash'] as string) ?? '';

    if (!rawBody) {
      this.logger.error('Flutterwave webhook: raw body missing');
      return { received: false };
    }

    // ── Verify HMAC signature FIRST — before any processing
    const verification = this.flutterwaveProvider.verifyWebhook(rawBody, signature);

    if (!verification.isValid) {
      this.logger.warn('Flutterwave webhook: invalid signature — rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.log(
      `Flutterwave webhook received: ${verification.eventType} [${verification.eventId}]`,
    );

    // ── Process event asynchronously — return 200 immediately
    // Flutterwave retries if we don't respond within 30s
    this.walletService
      .handleWebhookEvent(
        'FLUTTERWAVE',
        verification.eventType,
        verification.eventId,
        verification.data,
      )
      .catch((err) => this.logger.error(`Flutterwave webhook processing failed: ${err.message}`));

    return { received: true };
  }

  // ── POST /api/payments/webhook/paystack
  @Public()
  @Post('webhook/paystack')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Paystack webhook receiver' })
  async handlePaystackWebhook(@Req() req: Request) {
    const rawBody = (req as any).rawBody as Buffer;
    const signature = (req.headers['x-paystack-signature'] as string) ?? '';

    if (!rawBody) {
      this.logger.error('Paystack webhook: raw body missing');
      return { received: false };
    }

    // ── Verify HMAC signature FIRST
    const verification = this.paystackProvider.verifyWebhook(rawBody, signature);

    if (!verification.isValid) {
      this.logger.warn('Paystack webhook: invalid signature — rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.log(
      `Paystack webhook received: ${verification.eventType} [${verification.eventId}]`,
    );

    // ── Process asynchronously — return 200 immediately
    this.walletService
      .handleWebhookEvent(
        'PAYSTACK',
        verification.eventType,
        verification.eventId,
        verification.data,
      )
      .catch((err) => this.logger.error(`Paystack webhook processing failed: ${err.message}`));

    return { received: true };
  }
}
