import { defineConfig } from 'prisma/config';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../.env.dev') });
config({ path: resolve(process.cwd(), '.env.dev') });

export default defineConfig({
  schema: resolve(process.cwd(), 'apps/rewards-service/prisma/schema.prisma'),
  migrations: {
    path: resolve(process.cwd(), 'apps/rewards-service/prisma/migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL_REWARDS ?? process.env.DATABASE_URL ?? '',
  },
});
