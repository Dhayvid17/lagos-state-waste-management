import { Controller, Logger, BadRequestException } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { NotificationService } from '../notification.service';
import type {
  UserCreatedPayload,
  ReportEventPayload,
  PaymentEventPayload,
  DirectNotificationPayload,
} from '../notification.service';
import { NotificationChannel } from '../schemas/notification-log.schema';

// ── Rule 8: NATS handlers in SEPARATE class from HTTP controller
@Controller()
export class NotificationHandler {
  private readonly logger = new Logger(NotificationHandler.name);

  constructor(private readonly notificationService: NotificationService) {}

  // ── user.created
  @EventPattern(NatsEvents.USER_CREATED)
  async onUserCreated(
    @Payload() payload: UserCreatedPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.USER_CREATED} for ${payload.authId}`);
    try {
      await this.notificationService.handleUserCreated(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.USER_CREATED}: ${(error as Error).message}`,
        );
        return; // ACK message, no retry
      }
      this.logger.error(`Failed handling ${NatsEvents.USER_CREATED}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── report.created
  @EventPattern(NatsEvents.REPORT_CREATED)
  async onReportCreated(
    @Payload() payload: ReportEventPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.REPORT_CREATED} for ${payload.reportId}`);
    try {
      await this.notificationService.handleReportCreated(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.REPORT_CREATED}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_CREATED}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ── report.verified
  @EventPattern(NatsEvents.REPORT_VERIFIED)
  async onReportVerified(
    @Payload() payload: ReportEventPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.REPORT_VERIFIED} for ${payload.reportId}`);
    try {
      await this.notificationService.handleReportVerified(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.REPORT_VERIFIED}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_VERIFIED}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ── report.assigned
  @EventPattern(NatsEvents.REPORT_ASSIGNED)
  async onReportAssigned(
    @Payload() payload: ReportEventPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.REPORT_ASSIGNED} for ${payload.reportId}`);
    try {
      await this.notificationService.handleReportAssigned(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.REPORT_ASSIGNED}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_ASSIGNED}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ── report.completed
  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload() payload: ReportEventPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.REPORT_COMPLETED} for ${payload.reportId}`);
    try {
      await this.notificationService.handleReportCompleted(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ── report.rejected
  @EventPattern(NatsEvents.REPORT_REJECTED)
  async onReportRejected(
    @Payload() payload: ReportEventPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.REPORT_REJECTED} for ${payload.reportId}`);
    try {
      await this.notificationService.handleReportRejected(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.REPORT_REJECTED}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(
        `Failed handling ${NatsEvents.REPORT_REJECTED}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ── report.cancelled
  @EventPattern(NatsEvents.REPORT_CANCELLED)
  async onReportCancelled(
    @Payload() payload: ReportEventPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.REPORT_CANCELLED} for ${payload.reportId}`);
    // Cancellation — just log, no notification needed
  }

  // ── user.banned
  @EventPattern(NatsEvents.USER_BANNED)
  async onUserBanned(
    @Payload() payload: { authId: string; email: string; reason: string },
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.USER_BANNED} for ${payload.authId}`);
    try {
      await this.notificationService.handleUserBanned(payload);
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.USER_BANNED}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(`Failed handling ${NatsEvents.USER_BANNED}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── Direct email trigger
  @EventPattern(NatsEvents.SEND_EMAIL)
  async onSendEmail(
    @Payload() payload: DirectNotificationPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.SEND_EMAIL} to ${payload.recipientAuthId}`);
    try {
      await this.notificationService.handleDirectEmail({
        ...payload,
        channel: NotificationChannel.EMAIL,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.SEND_EMAIL}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(`Failed handling ${NatsEvents.SEND_EMAIL}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── Direct SMS trigger
  @EventPattern(NatsEvents.SEND_SMS)
  async onSendSms(
    @Payload() payload: DirectNotificationPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.SEND_SMS} to ${payload.recipientAuthId}`);
    try {
      await this.notificationService.handleDirectSms({
        ...payload,
        channel: NotificationChannel.SMS,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.SEND_SMS}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(`Failed handling ${NatsEvents.SEND_SMS}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── Direct push trigger
  @EventPattern(NatsEvents.SEND_PUSH)
  async onSendPush(
    @Payload() payload: DirectNotificationPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event received: ${NatsEvents.SEND_PUSH} to ${payload.recipientAuthId}`);
    try {
      await this.notificationService.handleDirectPush({
        ...payload,
        channel: NotificationChannel.PUSH,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(
          `Non-retriable error for ${NatsEvents.SEND_PUSH}: ${(error as Error).message}`,
        );
        return;
      }
      this.logger.error(`Failed handling ${NatsEvents.SEND_PUSH}: ${(error as Error).message}`);
      throw error;
    }
  }
}
