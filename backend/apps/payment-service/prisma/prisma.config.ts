import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load environment variables from .env.dev (and fallback to .env if not found)
// so ../ points to the project root where .env.dev lives
config({ path: resolve(process.cwd(), '../.env.dev') });
config({ path: resolve(process.cwd(), '.env.dev') }); // fallback

// ============================================================
// Payment Service Prisma Configuration
// ============================================================
export default defineConfig({
  schema: resolve(process.cwd(), './apps/payment-service/prisma/schema.prisma'),
  migrations: {
    path: resolve(process.cwd(), './apps/payment-service/prisma/migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL_PAYMENTS ?? process.env.DATABASE_URL ?? '',
  },
});
