import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { SocialService } from '../social.service';

// ── Rule 6: NATS handlers SEPARATE from HTTP controller
@Controller()
export class SocialHandler {
  private readonly logger = new Logger(SocialHandler.name);

  constructor(private readonly socialService: SocialService) {}

  // ── feed.post_created → initialize engagement counters
  @EventPattern('feed.post_created')
  async onFeedPostCreated(
    @Payload()
    payload: {
      feedPostId: string;
      reportId: string;
      reporterAuthId: string;
      lgaId: string;
      timestamp: string;
    },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: feed.post_created — initializing engagement for ${payload.reportId}`);
    try {
      await this.socialService.handleFeedPostCreated(payload);
    } catch (error) {
      this.logger.error(`Failed feed.post_created: ${(error as Error).message}`);
      throw error; // Rule 8
    }
  }

  // ── report.verified → cache status
  @EventPattern(NatsEvents.REPORT_VERIFIED)
  async onReportVerified(
    @Payload() payload: { reportId: string; timestamp: string },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    try {
      await this.socialService.handleReportStatusChanged({
        reportId: payload.reportId,
        status: 'VERIFIED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_VERIFIED}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── report.assigned → cache status
  @EventPattern(NatsEvents.REPORT_ASSIGNED)
  async onReportAssigned(
    @Payload() payload: { reportId: string; timestamp: string },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    try {
      await this.socialService.handleReportStatusChanged({
        reportId: payload.reportId,
        status: 'ASSIGNED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_ASSIGNED}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── report.completed → block further comments/upvotes
  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload() payload: { reportId: string; timestamp: string },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.REPORT_COMPLETED} — blocking engagement for ${payload.reportId}`,
    );
    try {
      await this.socialService.handleReportStatusChanged({
        reportId: payload.reportId,
        status: 'COMPLETED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── report.rejected → block further engagement
  @EventPattern(NatsEvents.REPORT_REJECTED)
  async onReportRejected(
    @Payload() payload: { reportId: string; timestamp: string },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    try {
      await this.socialService.handleReportStatusChanged({
        reportId: payload.reportId,
        status: 'REJECTED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_REJECTED}: ${(error as Error).message}`);
      throw error;
    }
  }
}
