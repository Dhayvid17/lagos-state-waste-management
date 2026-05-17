import { defineConfig } from 'prisma/config';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load environment variables from .env.dev (and fallback to .env if not found)
// so ../ points to the project root where .env.dev lives
config({ path: resolve(process.cwd(), '../.env.dev') });
config({ path: resolve(process.cwd(), '.env.dev') });

// ============================================================
// Collector Service Prisma Configuration
// ============================================================
export default defineConfig({
  schema: resolve(process.cwd(), 'apps/collector-service/prisma/schema.prisma'),
  migrations: {
    path: resolve(process.cwd(), 'apps/collector-service/prisma/migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL_COLLECTORS ?? process.env.DATABASE_URL ?? '',
  },
});
