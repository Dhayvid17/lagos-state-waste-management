import { registerAs } from '@nestjs/config';

export default registerAs('collector', () => ({
  postgres: {
    url: process.env.DATABASE_URL_COLLECTOR ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  tracking: {
    pingIntervalSeconds: 30, // GPS ping interval
    maxPingAgeHours: 2160, // 90 days in hours — NDPA compliance
    inactivityTimeoutMins: 10, // Auto-stop tracking if no ping
    locationHistoryDays: 90, // Delete after 90 days
  },
  eta: {
    averageSpeedKmh: 30, // Lagos traffic average speed estimate
  },
}));
