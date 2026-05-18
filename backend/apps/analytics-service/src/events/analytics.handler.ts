import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { AnalyticsService } from '../analytics.service';

// ── Rule 6: NATS handlers SEPARATE from HTTP controller
@Controller()
export class AnalyticsHandler {
  private readonly logger = new Logger(AnalyticsHandler.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  @EventPattern(NatsEvents.REPORT_CREATED)
  async onReportCreated(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('REPORT_CREATED', payload);
    } catch (error) {
      this.logger.error(`Failed REPORT_CREATED ingest: ${(error as Error).message}`);
      // ── Analytics failures must NOT block business operations
      // Do not rethrow — analytics is non-critical
    }
  }

  @EventPattern(NatsEvents.REPORT_VERIFIED)
  async onReportVerified(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('REPORT_VERIFIED', payload);
    } catch (error) {
      this.logger.error(`Failed REPORT_VERIFIED ingest: ${(error as Error).message}`);
    }
  }

  @EventPattern(NatsEvents.REPORT_ASSIGNED)
  async onReportAssigned(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('REPORT_ASSIGNED', payload);
    } catch (error) {
      this.logger.error(`Failed REPORT_ASSIGNED ingest: ${(error as Error).message}`);
    }
  }

  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload() payload: any,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.REPORT_COMPLETED} — ingesting completion + points for ${payload.reportId}`
    );

    // ── Ingest REPORT_COMPLETED event
    try {
      await this.analyticsService.ingestEvent('REPORT_COMPLETED', payload);
    } catch (error) {
      this.logger.error(
        `Failed REPORT_COMPLETED ingest: ${(error as Error).message}`
      );
      // Analytics failures must NOT block business operations — do not rethrow
    }

    // ── Ingest POINTS_AWARDED if points were awarded
    // This runs independently — a failure here must not prevent REPORT_COMPLETED from standing
    if (payload.pointsAwarded && payload.pointsAwarded > 0) {
      try {
        await this.analyticsService.ingestEvent('POINTS_AWARDED', payload);
      } catch (error) {
        this.logger.error(
          `Failed POINTS_AWARDED ingest: ${(error as Error).message}`
        );
      }
    }
  }

  @EventPattern(NatsEvents.REPORT_REJECTED)
  async onReportRejected(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('REPORT_REJECTED', payload);
    } catch (error) {
      this.logger.error(`Failed REPORT_REJECTED ingest: ${(error as Error).message}`);
    }
  }

  @EventPattern(NatsEvents.REPORT_CANCELLED)
  async onReportCancelled(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('REPORT_CANCELLED', payload);
    } catch (error) {
      this.logger.error(`Failed REPORT_CANCELLED ingest: ${(error as Error).message}`);
    }
  }

  @EventPattern(NatsEvents.USER_CREATED)
  async onUserCreated(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('USER_REGISTERED', payload);
    } catch (error) {
      this.logger.error(`Failed USER_REGISTERED ingest: ${(error as Error).message}`);
    }
  }

  @EventPattern(NatsEvents.PAYMENT_SUCCESS)
  async onPaymentSuccess(@Payload() payload: any, @Ctx() _ctx: NatsContext): Promise<void> {
    try {
      await this.analyticsService.ingestEvent('WITHDRAWAL_MADE', payload);
    } catch (error) {
      this.logger.error(`Failed WITHDRAWAL_MADE ingest: ${(error as Error).message}`);
    }
  }
}
