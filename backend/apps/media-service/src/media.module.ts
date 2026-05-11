import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bull';
import { ClientsModule, Transport } from '@nestjs/microservices';

import mediaConfig from './config/media.config.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MinioService } from './minio/minio.service.js';
import { MediaProcessor } from './queue/media.processor.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { MEDIA_QUEUE } from './queue/media.queue.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [mediaConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    // JWT
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // BullMQ — background job processing
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get<string>('media.redis.host'),
          port: config.get<number>('media.redis.port'),
          password: config.get<string>('media.redis.password'),
        },
      }),
    }),

    // Register the media processing queue
    BullModule.registerQueue({
      name: MEDIA_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),

    // NATS — for firing events if needed
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('media.nats.url') ?? 'nats://localhost:4222'],
            queue: 'media-service',
          },
        }),
      },
    ]),
  ],
  controllers: [MediaController],
  providers: [MediaService, MinioService, MediaProcessor, JwtAuthGuard],
})
export class MediaModule {}
