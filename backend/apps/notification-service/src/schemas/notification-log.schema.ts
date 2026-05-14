import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// This schema logs all notification attempts (email, SMS, push) for auditing and debugging.
export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  PUSH = 'PUSH',
}

// Status of the notification attempt
export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  BOUNCED = 'BOUNCED',
}

// Mongoose document type for NotificationLog
export type NotificationLogDocument = NotificationLog & Document;

@Schema({
  timestamps: true,
  collection: 'notification_logs',
})
// We use a single collection for all channels to simplify querying and indexing.
export class NotificationLog {
  @Prop({ required: true, index: true })
  recipientAuthId: string;

  @Prop({ required: true })
  recipientContact: string; // email, phone, or FCM token

  @Prop({
    type: String,
    enum: NotificationChannel,
    index: true,
  })
  channel: NotificationChannel;

  @Prop({
    type: String,
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
    index: true,
  })
  status: NotificationStatus;

  @Prop({ required: true })
  subject: string; // Email subject or notification title

  @Prop({ required: true })
  body: string; // Full message body

  @Prop()
  triggerEvent?: string; // Which NATS event triggered this

  @Prop()
  triggerEntityId?: string; // reportId, paymentId, etc.

  @Prop()
  providerMessageId?: string; // AWS SES MessageId, AT messageId

  @Prop()
  errorMessage?: string; // If failed

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const NotificationLogSchema = SchemaFactory.createForClass(NotificationLog);

NotificationLogSchema.index({ recipientAuthId: 1 });
NotificationLogSchema.index({ channel: 1, status: 1 });
NotificationLogSchema.index({ createdAt: -1 });
NotificationLogSchema.index({ triggerEvent: 1 });
