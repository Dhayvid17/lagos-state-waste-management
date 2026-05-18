import { registerAs } from '@nestjs/config';

export default registerAs('analytics', () => ({
  postgres: {
    url: process.env.DATABASE_URL_ANALYTICS ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  cache: {
    dashboardTtlSeconds: 300, // 5 minutes — dashboard data
    heatmapTtlSeconds: 600, // 10 minutes — heatmap data
    leaderboardTtlSeconds: 900, // 15 minutes — LGA leaderboard
  },
  retention: {
    rawEventDays: 365, // Keep raw events for 1 year
    aggregatedYears: 5, // Keep aggregated stats for 5 years
  },
}));
