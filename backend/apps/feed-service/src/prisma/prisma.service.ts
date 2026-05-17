import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL_FEED ?? process.env.DATABASE_URL,
    });

    pool.on('connect', (client: any) => {
      client.query('SET search_path TO feed, public;');
    });

    const adapter = new PrismaPg(pool, { schema: 'feed' });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('✅ Postgres connected — feed-service');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Prisma disconnected — feed-service');
  }
}
