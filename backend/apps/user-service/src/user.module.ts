import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';

import userConfig from './config/user.config';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserCreatedHandler } from './events/user-created.handler';
import { UserMessageHandler } from './events/user-message.handler';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PrismaService } from './prisma/prisma.service';
import { UserHealthController } from './health/health.controller';
import Redis from 'ioredis';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [userConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    // JWT — for validating tokens independently
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // NATS — for receiving events from auth-service
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('user.nats.url') ?? 'nats://localhost:4222'],
            queue: 'user-service',
          },
        }),
      },
    ]),
    TerminusModule,
  ],
  controllers: [
    UserController,
    UserCreatedHandler,
    UserMessageHandler,
    UserHealthController,
  ],
  providers: [
    UserService,
    JwtAuthGuard,
    PrismaService,
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const client = new Redis({
          host: config.get<string>('user.redis.host'),
          port: config.get<number>('user.redis.port'),
          password: config.get<string>('user.redis.password'),
          // Infinite exponential backoff capped at 10s — standard for robust microservices
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => console.log('User Service: Redis connected successfully'));
        client.on('error', (err) => console.error('User Service: Redis error:', err.message));

        return client;
      },
    },
  ],
})
export class UserModule {}
