import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { CollectorService } from '../collector.service';

// ── Rule 6: NATS handlers in SEPARATE class from HTTP controller
@Controller()
export class CollectorHandler {
  private readonly logger = new Logger(CollectorHandler.name);

  constructor(private readonly collectorService: CollectorService) {}

  // ── report.assigned → create assignment record
  @EventPattern(NatsEvents.REPORT_ASSIGNED)
  async onReportAssigned(
    @Payload()
    payload: {
      reportId: string;
      collectorAuthId: string;
      assignedByAuthId: string;
      actorRole?: string;
      lgaId: string;
      latitude: number;
      longitude: number;
      address?: string;
      timestamp: string;
    },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.REPORT_ASSIGNED} — ` +
        `collector ${payload.collectorAuthId} → report ${payload.reportId}`,
    );

    try {
      await this.collectorService.handleReportAssigned(payload);
    } catch (error) {
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_ASSIGNED}: ${(error as Error).message}`,
      );
      // ── Rule 8: rethrow so NATS retries
      throw error;
    }
  }

  // ── report.completed → close assignment if still open
  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload()
    payload: {
      reportId: string;
      collectorAuthId: string;
      timestamp: string;
    },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.REPORT_COMPLETED} — closing assignment for report ${payload.reportId}`,
    );

    try {
      await this.collectorService.autoCloseAssignment(
        payload.reportId,
        payload.collectorAuthId,
      );
    } catch (error) {
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`,
      );
      throw error; // Rethrow so NATS retries
    }
  }

  // ── NATS Request-Reply — report-service calls this for proximity dispatch
  @MessagePattern('collector.get_available')
  async handleGetAvailableCollectors(
    @Payload()
    data: {
      lgaId: string;
      latitude: number;
      longitude: number;
    },
  ) {
    this.logger.log(
      `collector.get_available requested for LGA: ${data.lgaId} ` +
      `at (${data.latitude}, ${data.longitude})`
    );

    try {
      return await this.collectorService.getAvailableCollectors(data);
    } catch (error) {
      this.logger.error(
        `collector.get_available failed: ${(error as Error).message}`
      );
      // Return empty rather than crashing — report service handles empty gracefully
      return { collectors: [] };
    }
  }
}
