import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import feedConfig from './config/feed.config';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';
import { FeedHandler } from './events/feed.handler';
import { FeedTasks } from './tasks/feed.tasks';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { FeedHealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [feedConfig],
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
            servers: [config.get<string>('feed.nats.url') ?? 'nats://localhost:4222'],
            queue: 'feed-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    FeedController,
    FeedHandler, // ← NATS listeners
    FeedHealthController,
  ],
  providers: [
    FeedService,
    PrismaService,
    JwtAuthGuard,
    FeedTasks,

    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('FeedRedis');
        const client = new Redis({
          host: config.get<string>('feed.redis.host'),
          port: config.get<number>('feed.redis.port'),
          password: config.get<string>('feed.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));

        return client;
      },
    },
  ],
})
export class FeedModule {}
