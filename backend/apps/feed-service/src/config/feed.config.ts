import { registerAs } from '@nestjs/config';

export default registerAs('feed', () => ({
  postgres: {
    url: process.env.DATABASE_URL_FEED ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  ranking: {
    recalculateIntervalMinutes: 5, // Recalculate scores every 5 mins
    severityWeights: {
      CRITICAL: 10,
      HIGH: 7,
      MEDIUM: 4,
      LOW: 1,
    },
    scoreWeights: {
      severity: 0.45,
      upvotes: 0.35,
      recency: 0.20,
    },
    completedDerankFactor: 0.2, // COMPLETED posts scored at 20% of original
    archiveAfterDays: 30, // Auto-archive 30 days after COMPLETED
  },
  pagination: {
    defaultLimit: 20,
    maxLimit: 100,
  },
}));
