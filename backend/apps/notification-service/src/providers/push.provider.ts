import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

// This provider handles sending push notifications via Firebase Cloud Messaging (FCM).
export interface SendPushOptions {
  fcmTokens: string[]; // Array of device tokens from user profile
  title: string;
  body: string;
  data?: Record<string, string>; // Extra payload (reportId, etc.)
  imageUrl?: string;
}

@Injectable()
export class PushProvider implements OnModuleInit {
  private readonly logger = new Logger(PushProvider.name);
  private app: admin.app.App;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // ── Initialize Firebase Admin only once
    if (!admin.apps.length) {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: this.configService.get<string>('notification.firebase.projectId')!,
          clientEmail: this.configService.get<string>('notification.firebase.clientEmail')!,
          privateKey: this.configService.get<string>('notification.firebase.privateKey')!,
        }),
      });

      this.logger.log('✅ Firebase Admin initialized');
    } else {
      this.app = admin.apps[0]!;
    }
  }

  async sendPush(options: SendPushOptions): Promise<{
    successCount: number;
    failureCount: number;
    invalidTokens: string[];
  }> {
    if (!options.fcmTokens.length) {
      this.logger.warn('sendPush called with empty FCM tokens array');
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    const messages: admin.messaging.Message[] = options.fcmTokens.map((token) => ({
      token,
      notification: {
        title: options.title,
        body: options.body,
        ...(options.imageUrl && { imageUrl: options.imageUrl }),
      },
      data: options.data ?? {},
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    }));

    try {
      const response = await admin.messaging().sendEach(messages);

      const invalidTokens: string[] = [];

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          // Collect invalid/expired tokens for cleanup
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(options.fcmTokens[idx]);
          }
          this.logger.warn(
            `Push failed for token ${options.fcmTokens[idx]}: ${resp.error?.message}`,
          );
        }
      });

      this.logger.log(
        `Push sent: ${response.successCount} success, ` + `${response.failureCount} failed`,
      );

      return {
        successCount: response.successCount,
        failureCount: response.failureCount,
        invalidTokens,
      };
    } catch (error) {
      this.logger.error(`Push notification failed: ${(error as Error).message}`);
      throw new InternalServerErrorException(`Push delivery failed: ${(error as Error).message}`);
    }
  }
}
