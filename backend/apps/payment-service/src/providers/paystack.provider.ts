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
export class PaystackProvider implements PaymentProviderInterface {
  readonly providerName = 'PAYSTACK';
  private readonly logger = new Logger(PaystackProvider.name);
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private readonly configService: ConfigService) {
    this.secretKey = this.configService.get<string>('payment.paystack.secretKey')!;
    this.webhookSecret = this.configService.get<string>('payment.paystack.webhookSecret')!;
  }

  // ============================================================
  // VERIFY BANK ACCOUNT
  // ============================================================
  async verifyBankAccount(accountNumber: string, bankCode: string): Promise<VerifyAccountResult> {
    try {
      const response = await fetch(
        `${this.baseUrl}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        {
          headers: { Authorization: `Bearer ${this.secretKey}` },
        },
      );

      const data = (await response.json()) as any;

      if (!response.ok || !data.status) {
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
      this.logger.error(`Paystack verifyBankAccount failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Bank account verification failed');
    }
  }

  // ============================================================
  // GET BANK LIST
  // ============================================================
  async getBankList(): Promise<BankListResult[]> {
    try {
      const response = await fetch(`${this.baseUrl}/bank?country=nigeria&perPage=100`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });

      const data = (await response.json()) as any;

      if (!response.ok || !data.status) {
        throw new InternalServerErrorException('Failed to fetch bank list');
      }

      return (data.data as any[]).map((bank) => ({
        code: bank.code,
        name: bank.name,
      }));
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Paystack getBankList failed: ${(error as Error).message}`);
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
    try {
      // ── Step 1: Create transfer recipient
      const recipientRes = await fetch(`${this.baseUrl}/transferrecipient`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'nuban',
          name: account.accountName,
          account_number: account.accountNumber,
          bank_code: account.bankCode,
          currency: 'NGN',
        }),
      });

      const recipientData = (await recipientRes.json()) as any;

      if (!recipientRes.ok || !recipientData.status) {
        throw new InternalServerErrorException(
          `Paystack recipient creation failed: ${recipientData.message}`,
        );
      }

      const recipientCode = recipientData.data.recipient_code;

      // ── Step 2: Initiate transfer
      // Paystack uses kobo natively — no conversion needed
      const transferRes = await fetch(`${this.baseUrl}/transfer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'balance',
          amount: amountKobo,
          recipient: recipientCode,
          reason: narration,
          reference,
        }),
      });

      const transferData = (await transferRes.json()) as any;

      if (!transferRes.ok || !transferData.status) {
        throw new InternalServerErrorException(`Paystack transfer failed: ${transferData.message}`);
      }

      const status = transferData.data?.status?.toLowerCase();

      return {
        providerReference: transferData.data?.transfer_code ?? reference,
        status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
        providerResponse: transferData.data ?? {},
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Paystack initiateTransfer failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Transfer initiation failed');
    }
  }

  // ============================================================
  // VERIFY WEBHOOK SIGNATURE
  // Paystack uses SHA-512 HMAC with secret key (not separate webhook secret)
  // ============================================================
  verifyWebhook(rawBody: Buffer, signature: string): WebhookVerificationResult {
    const expectedHash = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedHash, 'hex'),
      Buffer.from(signature, 'hex'),
    );

    if (!isValid) {
      this.logger.warn('Paystack webhook signature verification failed');
      return {
        isValid: false,
        eventType: '',
        eventId: '',
        data: {},
      };
    }

    const payload = JSON.parse(rawBody.toString()) as any;

    return {
      isValid: true,
      eventType: payload.event ?? 'unknown',
      eventId: payload.data?.reference ?? payload.data?.transfer_code ?? '',
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
      const response = await fetch(`${this.baseUrl}/transfer/verify/${providerReference}`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });

      const data = (await response.json()) as any;

      if (!response.ok || !data.status) {
        throw new InternalServerErrorException('Transfer verification failed');
      }

      const status = data.data?.status?.toLowerCase();

      return {
        status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Paystack verifyTransfer failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Transfer verification failed');
    }
  }
}
