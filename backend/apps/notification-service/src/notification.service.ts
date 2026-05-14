import { BadRequestException, Injectable, Logger, NotFoundException, Inject, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InjectRedis } from '@nestjs-modules/ioredis';
import type { Redis } from 'ioredis';
import type { JwtPayload } from '@app/shared';
import { UserRole } from '@app/shared';

import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { EmailProvider } from './providers/email.provider';
import { SmsProvider } from './providers/sms.provider';
import { PushProvider } from './providers/push.provider';
import {
  NotificationLog,
  NotificationLogDocument,
  NotificationChannel,
  NotificationStatus,
} from './schemas/notification-log.schema';
import { EmailTemplates, SmsTemplates, PushTemplates } from './templates/email.template';

// ── Payload shapes matching what other services fire via NATS
export interface UserCreatedPayload {
  authId: string;
  email: string;
  role: string;
  timestamp: string;
}

export interface ReportEventPayload {
  reportId: string;
  reporterAuthId: string;
  wasteType?: string;
  severity?: string;
  lgaId?: string;
  latitude?: number;
  longitude?: number;
  pointsAwarded?: number;
  verifiedById?: string;
  collectorAuthId?: string;
  rejectionReason?: string;
  address?: string;
  timestamp: string;
}

export interface PaymentEventPayload {
  authId: string;
  email: string;
  amount: number;
  currency: string;
  reference: string;
  timestamp: string;
}

export interface DirectNotificationPayload {
  recipientAuthId: string;
  recipientContact: string;
  subject: string;
  body: string;
  channel: NotificationChannel;
  triggerEvent?: string;
  triggerEntityId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly emailProvider: EmailProvider,
    private readonly smsProvider: SmsProvider,
    private readonly pushProvider: PushProvider,
    @InjectModel(NotificationLog.name)
    private readonly notificationLogModel: Model<NotificationLogDocument>,
    @InjectRedis()
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  // ============================================================
  // NATS EVENT HANDLERS — Called by event handler class
  // ============================================================

  async handleUserCreated(payload: UserCreatedPayload): Promise<void> {
    await this.sendEmailNotification({
      recipientAuthId: payload.authId,
      recipientContact: payload.email,
      triggerEvent: 'user.created',
      triggerEntityId: payload.authId,
      ...EmailTemplates.welcome({ email: payload.email }),
    });
  }

  async handleReportVerified(payload: ReportEventPayload): Promise<void> {
    // ── Resolve contact if missing
    const contact = await this.getUserContact(payload.reporterAuthId);

    await this.sendEmailNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: contact?.email ?? '',
      triggerEvent: 'report.verified',
      triggerEntityId: payload.reportId,
      ...EmailTemplates.reportVerified({
        reportTitle: `Report #${payload.reportId.slice(-8)}`,
        reportId: payload.reportId,
        lgaId: payload.lgaId ?? 'Lagos',
      }),
    });

    // ── SMS the reporter
    await this.sendSmsNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: contact?.phoneNumber ?? '',
      triggerEvent: 'report.verified',
      triggerEntityId: payload.reportId,
      subject: 'Report Verified',
      body: SmsTemplates.reportVerified(payload.reportId),
      channel: NotificationChannel.SMS,
    });
  }

  async handleReportCompleted(payload: ReportEventPayload): Promise<void> {
    const points = payload.pointsAwarded ?? 0;
    const contact = await this.getUserContact(payload.reporterAuthId);

    await this.sendEmailNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: contact?.email ?? '',
      triggerEvent: 'report.completed',
      triggerEntityId: payload.reportId,
      ...EmailTemplates.reportCompleted({
        reportTitle: `Report #${payload.reportId.slice(-8)}`,
        pointsAwarded: points,
        totalPoints: points,
      }),
    });

    await this.sendSmsNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: contact?.phoneNumber ?? '',
      triggerEvent: 'report.completed',
      triggerEntityId: payload.reportId,
      subject: 'Waste Collected',
      body: SmsTemplates.reportCompleted(points),
      channel: NotificationChannel.SMS,
    });
  }

  async handleReportAssigned(payload: ReportEventPayload): Promise<void> {
    if (!payload.collectorAuthId) return;

    const reporterContact = await this.getUserContact(payload.reporterAuthId);
    const collectorContact = await this.getUserContact(payload.collectorAuthId);

    // ── SMS citizen
    await this.sendSmsNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: reporterContact?.phoneNumber ?? '',
      triggerEvent: 'report.assigned',
      triggerEntityId: payload.reportId,
      subject: 'Collector Assigned',
      body: SmsTemplates.reportAssigned(payload.reportId),
      channel: NotificationChannel.SMS,
    });

    // ── Push notification to collector
    await this.sendPushToUser({
      recipientAuthId: payload.collectorAuthId,
      fcmTokens: collectorContact?.fcmTokens ?? [],
      triggerEvent: 'report.assigned',
      triggerEntityId: payload.reportId,
      ...PushTemplates.reportAssigned(payload.address),
      data: {
        reportId: payload.reportId,
        latitude: String(payload.latitude ?? ''),
        longitude: String(payload.longitude ?? ''),
        lgaId: payload.lgaId ?? '',
      },
    });
  }

  async handleReportRejected(payload: ReportEventPayload): Promise<void> {
    const contact = await this.getUserContact(payload.reporterAuthId);

    await this.sendEmailNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: contact?.email ?? '',
      triggerEvent: 'report.rejected',
      triggerEntityId: payload.reportId,
      ...EmailTemplates.reportRejected({
        reportTitle: `Report #${payload.reportId.slice(-8)}`,
        rejectionReason: payload.rejectionReason ?? 'No reason provided',
      }),
    });

    await this.sendSmsNotification({
      recipientAuthId: payload.reporterAuthId,
      recipientContact: contact?.phoneNumber ?? '',
      triggerEvent: 'report.rejected',
      triggerEntityId: payload.reportId,
      subject: 'Report Rejected',
      body: SmsTemplates.reportRejected(payload.rejectionReason ?? 'No reason provided'),
      channel: NotificationChannel.SMS,
    });
  }

  async handleReportCreated(payload: ReportEventPayload): Promise<void> {
    // ── Push to all collectors in the LGA
    // In production, fetch collector FCM tokens from user-service
    // For now, log the event
    this.logger.log(`Report created in ${payload.lgaId} — push to collectors queued`);
  }

  async handleUserBanned(payload: {
    authId: string;
    email: string;
    reason: string;
  }): Promise<void> {
    await this.sendEmailNotification({
      recipientAuthId: payload.authId,
      recipientContact: payload.email,
      triggerEvent: 'user.banned',
      triggerEntityId: payload.authId,
      ...EmailTemplates.accountSuspended({
        reason: payload.reason,
      }),
    });
  }

  async handleDirectEmail(payload: DirectNotificationPayload): Promise<void> {
    await this.sendEmailNotification({
      recipientAuthId: payload.recipientAuthId,
      recipientContact: payload.recipientContact,
      subject: payload.subject,
      body: payload.body,
      triggerEvent: payload.triggerEvent,
      triggerEntityId: payload.triggerEntityId,
    });
  }

  async handleDirectSms(payload: DirectNotificationPayload): Promise<void> {
    await this.sendSmsNotification({
      recipientAuthId: payload.recipientAuthId,
      recipientContact: payload.recipientContact,
      subject: payload.subject,
      body: payload.body,
      channel: NotificationChannel.SMS,
      triggerEvent: payload.triggerEvent,
      triggerEntityId: payload.triggerEntityId,
    });
  }

  async handleDirectPush(payload: DirectNotificationPayload): Promise<void> {
    await this.sendPushToUser({
      recipientAuthId: payload.recipientAuthId,
      triggerEvent: payload.triggerEvent,
      triggerEntityId: payload.triggerEntityId,
      title: payload.subject,
      body: payload.body,
    });
  }

  // ============================================================
  // GET NOTIFICATION LOGS — Admin
  // ============================================================
  async getNotificationLogs(
    user: JwtPayload,
    page: number = 1,
    limit: number = 20,
    channel?: NotificationChannel,
    status?: NotificationStatus,
  ) {
    if (user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only SYS_ADMIN can view all notification logs');
    }

    // ── Guard against NaN (Rule 13)
    const safePage = isNaN(page) || page < 1 ? 1 : page;
    const safeLimit = isNaN(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const filter: any = {};
    if (channel) filter.channel = channel;
    if (status) filter.status = status;

    const [data, total] = await Promise.all([
      this.notificationLogModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      this.notificationLogModel.countDocuments(filter),
    ]);

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ============================================================
  // GET MY NOTIFICATIONS
  // ============================================================
  async getMyNotifications(user: JwtPayload, page: number = 1, limit: number = 20) {
    const safePage = isNaN(page) || page < 1 ? 1 : page;
    const safeLimit = isNaN(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.notificationLogModel
        .find({ recipientAuthId: user.sub })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .select('-metadata')
        .lean(),
      this.notificationLogModel.countDocuments({
        recipientAuthId: user.sub,
      }),
    ]);

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ============================================================
  // PRIVATE — CORE SEND METHODS
  // ============================================================

  private async sendEmailNotification(data: {
    recipientAuthId: string;
    recipientContact: string;
    subject: string;
    html?: string;
    text?: string;
    body?: string;
    triggerEvent?: string;
    triggerEntityId?: string;
  }): Promise<void> {
    // ── Rate limit check (Rule 11 — atomic EXPIRE with NX)
    await this.enforceRateLimit(
      data.recipientAuthId,
      'email',
      this.configService.get<number>('notification.rateLimit.emailPerHour')!,
    );

    // ── Deduplication check (Claude Fix 4)
    const isDuplicate = await this.checkIdempotency(
      data.triggerEvent,
      data.triggerEntityId,
      'email',
      data.recipientAuthId,
    );
    if (isDuplicate) {
      this.logger.warn(
        `Duplicate email notification skipped: ${data.triggerEvent}:${data.triggerEntityId}`,
      );
      return;
    }

    // ── Create log entry as PENDING first
    const log = await this.notificationLogModel.create({
      recipientAuthId: data.recipientAuthId,
      recipientContact: data.recipientContact,
      channel: NotificationChannel.EMAIL,
      status: NotificationStatus.PENDING,
      subject: data.subject,
      body: data.html ?? data.body ?? '',
      triggerEvent: data.triggerEvent,
      triggerEntityId: data.triggerEntityId,
    });

    try {
      if (!data.recipientContact) {
        // ── Skip send if no contact — log as failed (Claude Fix 2)
        this.logger.warn(`No email for ${data.recipientAuthId} — marking as failed`);
        await this.notificationLogModel.updateOne(
          { _id: log._id },
          {
            status: NotificationStatus.FAILED,
            errorMessage: 'No recipient contact available — user profile not fetched',
          },
        );
        return;
      }

      const messageId = await this.emailProvider.sendEmail({
        to: data.recipientContact,
        subject: data.subject,
        html: data.html ?? `<p>${data.body}</p>`,
        text: data.text ?? data.body ?? '',
      });

      await this.notificationLogModel.updateOne(
        { _id: log._id },
        {
          status: NotificationStatus.SENT,
          providerMessageId: messageId,
        },
      );
    } catch (error) {
      await this.notificationLogModel.updateOne(
        { _id: log._id },
        {
          status: NotificationStatus.FAILED,
          errorMessage: (error as Error).message,
        },
      );
      // ── Rethrow so NATS retries (Rule 9)
      throw error;
    }
  }

  private async sendSmsNotification(data: {
    recipientAuthId: string;
    recipientContact: string;
    subject: string;
    body: string;
    channel: NotificationChannel;
    triggerEvent?: string;
    triggerEntityId?: string;
  }): Promise<void> {
    await this.enforceRateLimit(
      data.recipientAuthId,
      'sms',
      this.configService.get<number>('notification.rateLimit.smsPerHour')!,
    );

    const isDuplicate = await this.checkIdempotency(
      data.triggerEvent,
      data.triggerEntityId,
      'sms',
      data.recipientAuthId,
    );
    if (isDuplicate) {
      this.logger.warn(
        `Duplicate SMS notification skipped: ${data.triggerEvent}:${data.triggerEntityId}`,
      );
      return;
    }

    const log = await this.notificationLogModel.create({
      recipientAuthId: data.recipientAuthId,
      recipientContact: data.recipientContact,
      channel: NotificationChannel.SMS,
      status: NotificationStatus.PENDING,
      subject: data.subject,
      body: data.body,
      triggerEvent: data.triggerEvent,
      triggerEntityId: data.triggerEntityId,
    });

    try {
      if (!data.recipientContact) {
        this.logger.warn(`No phone for ${data.recipientAuthId} — marking as failed`);
        await this.notificationLogModel.updateOne(
          { _id: log._id },
          {
            status: NotificationStatus.FAILED,
            errorMessage: 'No recipient contact available — user profile not fetched',
          },
        );
        return;
      }

      const messageId = await this.smsProvider.sendSms({
        to: data.recipientContact,
        message: data.body,
      });

      await this.notificationLogModel.updateOne(
        { _id: log._id },
        {
          status: NotificationStatus.SENT,
          providerMessageId: messageId,
        },
      );
    } catch (error) {
      await this.notificationLogModel.updateOne(
        { _id: log._id },
        {
          status: NotificationStatus.FAILED,
          errorMessage: (error as Error).message,
        },
      );
      throw error;
    }
  }

  private async sendPushToUser(data: {
    recipientAuthId: string;
    fcmTokens?: string[];
    title: string;
    body: string;
    triggerEvent?: string;
    triggerEntityId?: string;
    data?: Record<string, string>;
    imageUrl?: string;
  }): Promise<void> {
    await this.enforceRateLimit(
      data.recipientAuthId,
      'push',
      this.configService.get<number>('notification.rateLimit.pushPerHour')!,
    );

    const log = await this.notificationLogModel.create({
      recipientAuthId: data.recipientAuthId,
      recipientContact: 'fcm',
      channel: NotificationChannel.PUSH,
      status: NotificationStatus.PENDING,
      subject: data.title,
      body: data.body,
      triggerEvent: data.triggerEvent,
      triggerEntityId: data.triggerEntityId,
    });

    try {
      if (!data.fcmTokens?.length) {
        this.logger.warn(`No FCM tokens for ${data.recipientAuthId} — push skipped`);
        return;
      }

      const response = await this.pushProvider.sendPush({
        fcmTokens: data.fcmTokens,
        title: data.title,
        body: data.body,
        data: data.data,
        imageUrl: data.imageUrl,
      });

      // ── Handle invalid tokens: fire batch event back to user-service
      if (response.invalidTokens.length > 0) {
        this.natsClient.emit('user.remove_fcm_tokens', {
          authId: data.recipientAuthId,
          tokens: response.invalidTokens,
        });
      }

      await this.notificationLogModel.updateOne(
        { _id: log._id },
        {
          status: NotificationStatus.SENT,
          metadata: {
            successCount: response.successCount,
            failureCount: response.failureCount,
          },
        },
      );
    } catch (error) {
      await this.notificationLogModel.updateOne(
        { _id: log._id },
        {
          status: NotificationStatus.FAILED,
          errorMessage: (error as Error).message,
        },
      );
      throw error;
    }
  }

  // ── Rate limiter — atomic INCR + EXPIRE with NX (Rule 11)
  private async enforceRateLimit(
    userId: string,
    channel: string,
    maxPerHour: number,
  ): Promise<void> {
    const key = `notif_rate:${channel}:${userId}`;
    const count = await this.redis.incr(key);

    if (count === 1) {
      // ── Atomic EXPIRE with NX — only sets if key has no expiry (Rule 11)
      await (this.redis as any).call('EXPIRE', key, 3600, 'NX');
    }

    if (count > maxPerHour) {
      this.logger.warn(
        `Rate limit hit: user ${userId} exceeded ${maxPerHour} ${channel} notifications/hour`,
      );
      throw new BadRequestException(
        `Rate limit exceeded: max ${maxPerHour} ${channel} notifications per hour`,
      );
    }
  }

  /**
   * Helper to resolve user contact info via NATS Request-Reply to user-service
   */
  private async getUserContact(authId: string) {
    try {
      const contact = await firstValueFrom(
        this.natsClient.send('user.get_contact', { authId }).pipe(timeout(5000)),
      );
      return (contact as { email: string; phoneNumber: string; fcmTokens: string[] }) ?? {
        email: '',
        phoneNumber: '',
        fcmTokens: [],
      };
    } catch (error) {
      this.logger.error(`Failed to resolve contact for ${authId}: ${(error as Error).message}`);
      return { email: '', phoneNumber: '', fcmTokens: [] };
    }
  }

  /**
   * Deduplication helper (Claude Fix 4)
   * Prevents sending duplicate notifications if NATS replays an event.
   */
  private async checkIdempotency(
    triggerEvent: string | undefined,
    triggerEntityId: string | undefined,
    channel: string,
    recipientAuthId: string,
  ): Promise<boolean> {
    if (!triggerEvent || !triggerEntityId) return false; // Direct sends are not deduplicated

    const dedupKey = `notif_dedup:${channel}:${triggerEvent}:${triggerEntityId}:${recipientAuthId}`;

    // SET NX — only sets if key doesn't exist, returns 'OK' if set, null if already existed
    const result = await this.redis.set(dedupKey, '1', 'EX', 86400, 'NX');
    return result === null; // null = key already existed = duplicate
  }
}
