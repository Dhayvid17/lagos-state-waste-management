import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { FeedService } from '../feed.service';
import type {
  ReportCreatedPayload,
  ReportStatusPayload,
  MediaProcessedPayload,
  CollectorLocationPayload,
  SocialEngagementPayload,
} from '../feed.service';

// ── Rule 6: NATS handlers SEPARATE from HTTP controller
@Controller()
export class FeedHandler {
  private readonly logger = new Logger(FeedHandler.name);

  constructor(private readonly feedService: FeedService) {}

  @EventPattern(NatsEvents.REPORT_CREATED)
  async onReportCreated(
    @Payload() payload: ReportCreatedPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.REPORT_CREATED} — creating feed post for ${payload.reportId}`,
    );
    try {
      await this.feedService.handleReportCreated(payload);
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_CREATED}: ${(error as Error).message}`);
      throw error; // Rule 8
    }
  }

  @EventPattern(NatsEvents.REPORT_VERIFIED)
  async onReportVerified(
    @Payload() payload: ReportStatusPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: ${NatsEvents.REPORT_VERIFIED} for ${payload.reportId}`);
    try {
      await this.feedService.handleReportStatusChanged({
        ...payload,
        status: 'VERIFIED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_VERIFIED}: ${(error as Error).message}`);
      throw error;
    }
  }

  @EventPattern(NatsEvents.REPORT_ASSIGNED)
  async onReportAssigned(
    @Payload() payload: ReportStatusPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: ${NatsEvents.REPORT_ASSIGNED} for ${payload.reportId}`);
    try {
      await this.feedService.handleReportStatusChanged({
        ...payload,
        status: 'ASSIGNED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_ASSIGNED}: ${(error as Error).message}`);
      throw error;
    }
  }

  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload() payload: ReportStatusPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: ${NatsEvents.REPORT_COMPLETED} for ${payload.reportId}`);
    try {
      await this.feedService.handleReportStatusChanged({
        ...payload,
        status: 'COMPLETED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`);
      throw error;
    }
  }

  @EventPattern(NatsEvents.REPORT_REJECTED)
  async onReportRejected(
    @Payload() payload: ReportStatusPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: ${NatsEvents.REPORT_REJECTED} for ${payload.reportId}`);
    try {
      await this.feedService.handleReportStatusChanged({
        ...payload,
        status: 'REJECTED',
      });
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_REJECTED}: ${(error as Error).message}`);
      throw error;
    }
  }

  @EventPattern('media.processed')
  async onMediaProcessed(
    @Payload() payload: MediaProcessedPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: media.processed — updating thumbnail ${payload.originalKey}`);
    try {
      await this.feedService.handleMediaProcessed(payload);
    } catch (error) {
      this.logger.error(`Failed media.processed: ${(error as Error).message}`);
      throw error;
    }
  }

  @EventPattern('collector.location_updated')
  async onCollectorLocationUpdated(
    @Payload() payload: CollectorLocationPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    try {
      await this.feedService.handleCollectorLocationUpdated(payload);
    } catch (error) {
      this.logger.error(`Failed collector.location_updated: ${(error as Error).message}`);
      throw error;
    }
  }

  @EventPattern('social.engagement_updated')
  async onEngagementUpdated(
    @Payload() payload: SocialEngagementPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    try {
      await this.feedService.handleEngagementUpdated(payload);
    } catch (error) {
      this.logger.error(`Failed social.engagement_updated: ${(error as Error).message}`);
      throw error;
    }
  }
}
