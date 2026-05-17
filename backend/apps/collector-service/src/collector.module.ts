import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import collectorConfig from './config/collector.config';
import { CollectorController } from './collector.controller';
import { CollectorService } from './collector.service';
import { CollectorHandler } from './events/collector.handler';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CleanupTask } from './tasks/cleanup.task';
import { CollectorHealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [collectorConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    // Scheduling — for NDPA cleanup cron job
    ScheduleModule.forRoot(),

    TerminusModule,

    // JWT
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // NATS
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('collector.nats.url') ?? 'nats://localhost:4222'],
            queue: 'collector-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    CollectorController,
    CollectorHandler, // ← NATS event handler
    CollectorHealthController,
  ],
  providers: [
    CollectorService,
    PrismaService,
    JwtAuthGuard,
    CleanupTask,

    // Redis — blocklist + GPS cache
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('CollectorRedis');
        const client = new Redis({
          host: config.get<string>('collector.redis.host'),
          port: config.get<number>('collector.redis.port'),
          password: config.get<string>('collector.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));

        return client;
      },
    },
  ],
})
export class CollectorModule {}
