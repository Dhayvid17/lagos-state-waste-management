import { registerAs } from '@nestjs/config';

// ============================================================
// Report Service Configuration
// ============================================================
export default registerAs('report', () => ({
  postgres: {
    url: process.env.DATABASE_URL_REPORTS ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  security: {
    maxReportsPerHour: 10, // Max reports a citizen can submit per hour
    maxMediaPerReport: 5, // Max photos/videos per report
    duplicateRadiusMeters: 50, // Reports within 50m of each other flagged as duplicate
  },
}));
