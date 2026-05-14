import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

// This provider handles sending emails via Resend.
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string; // Plain text fallback
}

@Injectable()
export class EmailProvider {
  private readonly logger = new Logger(EmailProvider.name);
  private readonly client: Resend;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(private readonly configService: ConfigService) {
    this.fromEmail = this.configService.get<string>('notification.resend.fromEmail')!;
    this.fromName = this.configService.get<string>('notification.resend.fromName')!;
    const apiKey = this.configService.get<string>('notification.resend.apiKey')!;

    this.client = new Resend(apiKey);
  }

  // Sends an email using Resend and returns the MessageId for tracking.
  async sendEmail(options: SendEmailOptions): Promise<string> {
    try {
      const response = await this.client.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const messageId = response.data?.id ?? 'unknown';

      this.logger.log(`Email sent to ${options.to} — MessageId: ${messageId}`);

      return messageId;
    } catch (error) {
      this.logger.error(`Email failed to ${options.to}: ${(error as Error).message}`);
      throw new InternalServerErrorException(`Email delivery failed: ${(error as Error).message}`);
    }
  }
}
