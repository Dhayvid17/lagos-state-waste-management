import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type {
  PaymentProviderInterface,
  VerifyAccountResult,
  InitiateTransferResult,
  WebhookVerificationResult,
  BankListResult,
  BankAccount,
} from '../interfaces/payment-provider.interface.js';

@Injectable()
export class FlutterwaveProvider implements PaymentProviderInterface {
  readonly providerName = 'FLUTTERWAVE';
  private readonly logger = new Logger(FlutterwaveProvider.name);
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl = 'https://api.flutterwave.com/v3';

  constructor(private readonly configService: ConfigService) {
    this.secretKey = this.configService.get<string>('payment.flutterwave.secretKey')!;
    this.webhookSecret = this.configService.get<string>('payment.flutterwave.webhookSecret')!;
  }

  // ============================================================
  // VERIFY BANK ACCOUNT
  // ============================================================
  async verifyBankAccount(accountNumber: string, bankCode: string): Promise<VerifyAccountResult> {
    try {
      const response = await fetch(`${this.baseUrl}/accounts/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode }),
      });

      const data = (await response.json()) as any;

      if (!response.ok || data.status !== 'success') {
        throw new BadRequestException(
          `Bank account verification failed: ${data.message ?? 'Unknown error'}`,
        );
      }

      return {
        accountName: data.data.account_name,
        accountNumber: data.data.account_number,
        bankName: bankCode,
        isValid: true,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Flutterwave verifyBankAccount failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Bank account verification failed');
    }
  }

  // ============================================================
  // GET BANK LIST
  // ============================================================
  async getBankList(): Promise<BankListResult[]> {
    try {
      const response = await fetch(`${this.baseUrl}/banks/NG`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });

      const data = (await response.json()) as any;

      if (!response.ok || data.status !== 'success') {
        throw new InternalServerErrorException('Failed to fetch bank list');
      }

      return (data.data as any[]).map((bank) => ({
        code: bank.code,
        name: bank.name,
      }));
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Flutterwave getBankList failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to fetch bank list');
    }
  }

  // ============================================================
  // INITIATE TRANSFER
  // ============================================================
  async initiateTransfer(
    amountKobo: number,
    account: BankAccount,
    reference: string,
    narration: string,
  ): Promise<InitiateTransferResult> {
    // ── Convert kobo to naira for Flutterwave
    const amountNgn = amountKobo / 100;

    try {
      const response = await fetch(`${this.baseUrl}/transfers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_bank: account.bankCode,
          account_number: account.accountNumber,
          amount: amountNgn,
          narration,
          currency: 'NGN',
          reference,
          callback_url: '', // Handled via webhook
          debit_currency: 'NGN',
        }),
      });

      const data = (await response.json()) as any;

      if (!response.ok) {
        throw new InternalServerErrorException(
          `Flutterwave transfer failed: ${data.message ?? 'Unknown error'}`,
        );
      }

      const status = data.data?.status?.toLowerCase();

      return {
        providerReference: String(data.data?.id ?? reference),
        status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
        providerResponse: data.data ?? {},
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Flutterwave initiateTransfer failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Transfer initiation failed');
    }
  }

  // ============================================================
  // VERIFY WEBHOOK SIGNATURE
  // Rule: raw body used — never parsed body
  // ============================================================
  verifyWebhook(rawBody: Buffer, signature: string): WebhookVerificationResult {
    // ── Flutterwave uses SHA-256 HMAC with webhook secret
    const expectedHash = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedHash, 'hex'),
      Buffer.from(signature, 'hex'),
    );

    if (!isValid) {
      this.logger.warn('Flutterwave webhook signature verification failed');
      return {
        isValid: false,
        eventType: '',
        eventId: '',
        data: {},
      };
    }

    // ── Parse AFTER verification
    const payload = JSON.parse(rawBody.toString()) as any;

    return {
      isValid: true,
      eventType: payload.event ?? 'unknown',
      eventId: String(payload.data?.id ?? payload.data?.tx_ref ?? ''),
      data: payload.data ?? {},
    };
  }

  // ============================================================
  // VERIFY TRANSFER STATUS
  // ============================================================
  async verifyTransfer(
    providerReference: string,
  ): Promise<{ status: 'pending' | 'success' | 'failed' }> {
    try {
      const response = await fetch(`${this.baseUrl}/transfers/${providerReference}`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });

      const data = (await response.json()) as any;

      if (!response.ok) {
        throw new InternalServerErrorException('Transfer verification failed');
      }

      const status = data.data?.status?.toLowerCase();

      return {
        status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Flutterwave verifyTransfer failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Transfer verification failed');
    }
  }
}
