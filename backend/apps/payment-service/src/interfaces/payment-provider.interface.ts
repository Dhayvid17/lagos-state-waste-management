// ── Common interface — adding a third provider requires
// implementing this interface only. Zero service changes.

export interface BankAccount {
  bankCode: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
}

export interface VerifyAccountResult {
  accountName: string;
  accountNumber: string;
  bankName: string;
  isValid: boolean;
}

export interface InitiateTransferResult {
  providerReference: string;
  status: 'pending' | 'success' | 'failed';
  providerResponse: Record<string, unknown>;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  eventType: string;
  eventId: string; // Provider's unique event ID for idempotency
  data: Record<string, unknown>;
}

export interface BankListResult {
  code: string;
  name: string;
}

// ── Every payment provider must implement this interface
export interface PaymentProviderInterface {
  readonly providerName: string;

  // Verify bank account details before withdrawal
  verifyBankAccount(accountNumber: string, bankCode: string): Promise<VerifyAccountResult>;

  // Get list of supported banks
  getBankList(): Promise<BankListResult[]>;

  // Initiate bank transfer
  initiateTransfer(
    amount: number, // In kobo
    account: BankAccount,
    reference: string,
    narration: string,
  ): Promise<InitiateTransferResult>;

  // Verify webhook signature and extract event data
  verifyWebhook(rawBody: Buffer, signature: string): WebhookVerificationResult;

  // Check transfer status
  verifyTransfer(providerReference: string): Promise<{ status: 'pending' | 'success' | 'failed' }>;
}

// ── Injection token for provider selection
export const FLUTTERWAVE_PROVIDER = 'FLUTTERWAVE_PROVIDER';
export const PAYSTACK_PROVIDER = 'PAYSTACK_PROVIDER';
