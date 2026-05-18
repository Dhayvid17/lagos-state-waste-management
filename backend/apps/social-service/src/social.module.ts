import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import socialConfig from './config/social.config';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';
import { SocialHandler } from './events/social.handler';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { SocialHealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [socialConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

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
            servers: [config.get<string>('social.nats.url') ?? 'nats://localhost:4222'],
            queue: 'social-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    SocialController,
    SocialHandler, // ← NATS event listener
    SocialHealthController,
  ],
  providers: [
    SocialService,
    PrismaService,
    JwtAuthGuard,

    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('SocialRedis');
        const client = new Redis({
          host: config.get<string>('social.redis.host'),
          port: config.get<number>('social.redis.port'),
          password: config.get<string>('social.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));

        return client;
      },
    },
  ],
})
export class SocialModule {}
