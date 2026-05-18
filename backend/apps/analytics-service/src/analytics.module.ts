import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import analyticsConfig from './config/analytics.config';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsHandler } from './events/analytics.handler';
import { AnalyticsTasks } from './tasks/analytics.tasks';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AnalyticsHealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [analyticsConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    ScheduleModule.forRoot(),
    TerminusModule,

    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('analytics.nats.url') ?? 'nats://localhost:4222'],
            queue: 'analytics-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    AnalyticsController,
    AnalyticsHandler, // ← NATS event listener
    AnalyticsHealthController,
  ],
  providers: [
    AnalyticsService,
    PrismaService,
    JwtAuthGuard,
    AnalyticsTasks,

    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('AnalyticsRedis');
        const client = new Redis({
          host: config.get<string>('analytics.redis.host'),
          port: config.get<number>('analytics.redis.port'),
          password: config.get<string>('analytics.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));

        return client;
      },
    },
  ],
})
export class AnalyticsModule {}
