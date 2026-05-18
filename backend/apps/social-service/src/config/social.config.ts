import { registerAs } from '@nestjs/config';

export default registerAs('social', () => ({
  postgres: {
    url: process.env.DATABASE_URL_SOCIAL ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  limits: {
    maxCommentLength: 1000,
    maxCommentsPerHour: 20, // Rate limit per citizen
    maxUpvotesPerHour: 50, // Rate limit per citizen
    maxRepostsPerHour: 10, // Rate limit per citizen
    maxFlagsPerUserPerDay: 5, // Daily flag submission rate limit per citizen
    flagEscalationThreshold: 15, // Total unique flags on a single post before auto-escalating to moderation queue
  },
}));
