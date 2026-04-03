import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../.env.dev') });
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: './apps/user-service/prisma/schema.prisma',
  migrations: {
    path: './apps/user-service/prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});