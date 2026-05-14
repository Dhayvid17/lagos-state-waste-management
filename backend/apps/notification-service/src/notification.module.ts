import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { RedisModule } from '@nestjs-modules/ioredis';
import { TerminusModule } from '@nestjs/terminus';

import notificationConfig from './config/notification.config';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationHandler } from './events/notification.handler';
import { EmailProvider } from './providers/email.provider';
import { SmsProvider } from './providers/sms.provider';
import { PushProvider } from './providers/push.provider';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { NotificationLog, NotificationLogSchema } from './schemas/notification-log.schema';
import { NotificationHealthController } from './health/notification-health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [notificationConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),
    TerminusModule,

    // MongoDB — Atlas
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('notification.mongo.uri'),
      }),
    }),

    MongooseModule.forFeature([{ name: NotificationLog.name, schema: NotificationLogSchema }]),

    // JWT
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // Redis — Rule 6: retryStrategy retries forever
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: `redis://:${config.get('notification.redis.password')}@${config.get('notification.redis.host')}:${config.get('notification.redis.port')}`,
        options: {
          retryStrategy: (times: number) => Math.min(times * 500, 10000), // Rule 6 — retry forever
        },
      }),
    }),

    // NATS — for listening to events from all services
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('notification.nats.url') ?? 'nats://localhost:4222'],
            queue: 'notification-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    NotificationController,
    NotificationHandler, // ← NATS event listeners
    NotificationHealthController,
  ],
  providers: [
    NotificationService,
    EmailProvider,
    SmsProvider,
    PushProvider,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class NotificationModule {}
