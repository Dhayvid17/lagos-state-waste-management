import { registerAs } from '@nestjs/config';

// ============================================================
// User Service Configuration
// ============================================================
export default registerAs('user', () => ({
  postgres: {
    url: process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
}));
