import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import rewardsConfig from './config/rewards.config';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { RewardsHandler } from './events/rewards.handler';
import { RewardsTasks } from './tasks/rewards.tasks';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RewardsHealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [rewardsConfig],
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
            servers: [config.get<string>('rewards.nats.url') ?? 'nats://localhost:4222'],
            queue: 'rewards-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    RewardsController,
    RewardsHandler, // ← NATS event listener
    RewardsHealthController,
  ],
  providers: [
    RewardsService,
    PrismaService,
    JwtAuthGuard,
    RewardsTasks,

    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('RewardsRedis');
        const client = new Redis({
          host: config.get<string>('rewards.redis.host'),
          port: config.get<number>('rewards.redis.port'),
          password: config.get<string>('rewards.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));

        return client;
      },
    },
  ],
})
export class RewardsModule {}
