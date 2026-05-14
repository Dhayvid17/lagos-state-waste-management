import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AfricasTalking from 'africastalking';

// This provider handles sending SMS messages via Africa's Talking.
export interface SendSmsOptions {
  to: string; // E.164 format (+234... or +254...)
  message: string;
}

@Injectable()
export class SmsProvider {
  private readonly logger = new Logger(SmsProvider.name);
  private readonly sms: any;
  private readonly senderId: string;

  constructor(private readonly configService: ConfigService) {
    this.senderId = this.configService.get<string>('notification.africastalking.senderId')!;

    const client = AfricasTalking({
      apiKey: this.configService.get<string>('notification.africastalking.apiKey')!,
      username: this.configService.get<string>('notification.africastalking.username')!,
    });

    this.sms = client.SMS;
  }

  async sendSms(options: SendSmsOptions): Promise<string> {
    try {
      const normalizedTo = this.normalizePhoneNumber(options.to);

      const response = await this.sms.send({
        to: [normalizedTo],
        message: options.message,
        from: this.senderId,
      });

      const recipient = response.SMSMessageData?.Recipients?.[0];
      const messageId = recipient?.messageId ?? 'unknown';
      const status = recipient?.status ?? 'unknown';

      // Status 101 is 'Sent', 100 is 'Processed' (Success)
      if (status !== 'Success' && status !== 'Sent' && status !== 'Buffered') {
        throw new Error(`Africa's Talking status: ${status}`);
      }

      this.logger.log(`SMS sent to ${options.to} — Status: ${status}, MessageId: ${messageId}`);

      return messageId;
    } catch (error) {
      this.logger.error(`SMS failed to ${options.to}: ${(error as Error).message}`);
      throw new InternalServerErrorException(`SMS delivery failed: ${(error as Error).message}`);
    }
  }

  /**
   * Normalizes phone numbers to E.164 format.
   * Prioritizes Nigeria (+234) but supports Worldwide (E.164).
   */
  private normalizePhoneNumber(phone: string): string {
    // 1. If it already starts with +, assume it's E.164 and just clean extra spaces/dashes
    if (phone.startsWith('+')) {
      return '+' + phone.replace(/\D/g, '');
    }

    let clean = phone.replace(/\D/g, ''); // Remove all non-digits

    // 2. Handle Nigerian local format (080..., 070..., 090... -> 11 digits starting with 0)
    if (clean.length === 11 && clean.startsWith('0')) {
      return `+234${clean.slice(1)}`;
    }

    // 3. Handle Kenyan local format (07..., 01... -> 10 digits starting with 0)
    if (clean.length === 10 && (clean.startsWith('07') || clean.startsWith('01'))) {
      return `+254${clean.slice(1)}`;
    }

    // 4. Handle numbers already starting with country code but missing + (e.g. 234..., 254...)
    if (clean.startsWith('234') && clean.length === 13) return `+${clean}`;
    if (clean.startsWith('254') && clean.length === 12) return `+${clean}`;

    // 5. Default Fallback: Add + if it looks like a full international number, 
    // otherwise assume it's a Nigerian number missing the leading 0
    if (clean.length >= 11) {
      return `+${clean}`;
    } else if (clean.length === 10) {
      return `+234${clean}`;
    }

    return `+${clean}`;
  }
}
