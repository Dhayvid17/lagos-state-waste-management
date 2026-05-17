import { registerAs } from '@nestjs/config';

// Centralized configuration for the Payment Service, including database, messaging, caching, and payment gateway settings.
export default registerAs('payment', () => ({
  postgres: {
    url: process.env.DATABASE_URL_PAYMENTS ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  flutterwave: {
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY,
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY,
    webhookSecret: process.env.FLUTTERWAVE_WEBHOOK_SECRET,
    encryptionKey: process.env.FLUTTERWAVE_ENCRYPTION_KEY,
  },
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET,
  },
  wallet: {
    pointsToNairaRate: 10, // 10 points = ₦1
    minimumWithdrawalNgn: 500, // ₦500 minimum
    maximumWithdrawalNgn: 500000, // ₦500,000 daily max
    withdrawalFeePercent: 1.5, // 1.5% processing fee
  },
}));
