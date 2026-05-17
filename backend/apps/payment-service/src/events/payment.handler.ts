import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { WalletService } from '../wallet/wallet.service.js';

// ── Rule 8: NATS handlers in SEPARATE class from HTTP controller
@Controller()
export class PaymentHandler {
  private readonly logger = new Logger(PaymentHandler.name);

  constructor(private readonly walletService: WalletService) {}

  // ── report.completed → award points to citizen
  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload()
    payload: {
      reportId: string;
      reporterAuthId: string;
      pointsAwarded: number;
      timestamp: string;
    },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event received: ${NatsEvents.REPORT_COMPLETED} — awarding ${payload.pointsAwarded} points to ${payload.reporterAuthId}`,
    );

    try {
      await this.walletService.handlePointsAwarded(payload);
    } catch (error) {
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`,
      );
      // ── Rule 9: Rethrow so NATS retries
      // Points award failure is critical — must retry
      throw error;
    }
  }
}
