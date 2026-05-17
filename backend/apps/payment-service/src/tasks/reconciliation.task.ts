import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import type { PaymentProviderInterface } from '../interfaces/payment-provider.interface';
import { FLUTTERWAVE_PROVIDER, PAYSTACK_PROVIDER } from '../interfaces/payment-provider.interface';

@Injectable()
export class ReconciliationTask {
  private readonly logger = new Logger(ReconciliationTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    @Inject(FLUTTERWAVE_PROVIDER) private readonly flutterwave: PaymentProviderInterface,
    @Inject(PAYSTACK_PROVIDER) private readonly paystack: PaymentProviderInterface,
  ) {}

  // ============================================================
  // EVERY 15 MINUTES — Detect stuck withdrawals
  // ============================================================
  @Cron('*/15 * * * *')
  async reconcileStuckWithdrawals() {
    this.logger.log('Starting withdrawal reconciliation...');

    // Find withdrawals stuck in PROCESSING for more than 30 minutes
    const stuckThreshold = new Date(Date.now() - 30 * 60 * 1000);

    const stuckWithdrawals = await this.prisma.withdrawalRequest.findMany({
      where: {
        status: 'PROCESSING',
        processedAt: { lt: stuckThreshold },
        providerReference: { not: null }, // Must have a provider reference to check
      },
      take: 20, // Process max 20 per run to avoid rate limits
    });

    if (stuckWithdrawals.length === 0) {
      this.logger.log('No stuck withdrawals found.');
      return;
    }

    this.logger.warn(`Found ${stuckWithdrawals.length} stuck withdrawals — reconciling...`);

    for (const withdrawal of stuckWithdrawals) {
      try {
        // Ask the payment provider what the current status actually is
        const provider = withdrawal.provider === 'PAYSTACK' ? this.paystack : this.flutterwave;

        // verifyTransfer may not exist on all providers — guard gracefully
        if (!provider.verifyTransfer) {
          this.logger.warn(`Provider ${withdrawal.provider} does not support verifyTransfer — skipping`);
          continue;
        }

        const result = await provider.verifyTransfer(withdrawal.providerReference!);

        this.logger.log(
          `Reconciliation: withdrawal ${withdrawal.id} — provider says: ${result.status}`,
        );

        if (result.status === 'success') {
          // Webhook was lost — process success now
          await this.walletService.handleWebhookEvent(
            withdrawal.provider as 'FLUTTERWAVE' | 'PAYSTACK',
            'transfer.success',
            withdrawal.providerReference!,
            {
              reference: withdrawal.providerReference,
              id: withdrawal.providerReference,
              reconciled: true,
            },
          );
          this.logger.log(`Reconciled success for withdrawal: ${withdrawal.id}`);

        } else if (result.status === 'failed') {
          // Webhook was lost — process failure now
          await this.walletService.handleWebhookEvent(
            withdrawal.provider as 'FLUTTERWAVE' | 'PAYSTACK',
            'transfer.failed',
            withdrawal.providerReference!,
            {
              reference: withdrawal.providerReference,
              id: withdrawal.providerReference,
              complete_message: 'Transfer failed — detected via reconciliation',
              reconciled: true,
            },
          );
          this.logger.warn(`Reconciled failure for withdrawal: ${withdrawal.id}`);

        } else {
          // Still pending at provider — extend the check window
          const currentMeta = (withdrawal.metadata as any) ?? {};
          await this.prisma.withdrawalRequest.update({
            where: { id: withdrawal.id },
            data: {
              processedAt: new Date(), // Reset timer so we don't re-check too aggressively
              metadata: {
                ...currentMeta,
                lastReconciliationCheck: new Date().toISOString(),
                reconciliationChecks: (currentMeta.reconciliationChecks ?? 0) + 1,
              } as any,
            },
          });

          // After 48 hours, escalate to admin via logger (NATS can be wired in later)
          const hoursProcessing =
            (Date.now() - withdrawal.processedAt!.getTime()) / (1000 * 60 * 60);
          if (hoursProcessing > 48) {
            this.logger.error(
              `CRITICAL: Withdrawal ${withdrawal.id} stuck for ${Math.round(hoursProcessing)}h — manual intervention required`,
            );
          }
        }

        // Small delay between API calls to avoid provider rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));

      } catch (error) {
        this.logger.error(
          `Reconciliation failed for withdrawal ${withdrawal.id}: ${(error as Error).message}`,
        );
        // Continue to next — don't let one failure stop the whole run
      }
    }

    this.logger.log('Reconciliation run complete.');
  }

  // ============================================================
  // DAILY 1AM LAGOS TIME — Full reconciliation report
  // ============================================================
  @Cron('0 1 * * *', { timeZone: 'Africa/Lagos' })
  async dailyReconciliationReport() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalProcessed, totalFailed, totalStuck, totalAmount] = await Promise.all([
      this.prisma.withdrawalRequest.count({
        where: { status: 'SUCCESS', processedAt: { gte: yesterday, lt: today } },
      }),
      this.prisma.withdrawalRequest.count({
        where: { status: 'FAILED', updatedAt: { gte: yesterday, lt: today } },
      }),
      this.prisma.withdrawalRequest.count({
        where: { status: 'PROCESSING', processedAt: { lt: today } },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: { status: 'SUCCESS', processedAt: { gte: yesterday, lt: today } },
        _sum: { netAmountKobo: true },
      }),
    ]);

    const totalPaidOutNgn = ((totalAmount._sum.netAmountKobo ?? 0) / 100).toLocaleString('en-NG');

    this.logger.log(
      `Daily Reconciliation Report — ` +
        `Processed: ${totalProcessed}, Failed: ${totalFailed}, ` +
        `Still Stuck: ${totalStuck}, Total Paid Out: ₦${totalPaidOutNgn}`,
    );

    if (totalStuck > 0) {
      this.logger.error(`ALERT: ${totalStuck} withdrawals still stuck from previous days`);
    }
  }
}
