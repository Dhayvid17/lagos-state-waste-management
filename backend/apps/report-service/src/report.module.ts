import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import reportConfig from './config/report.config';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ReportHealthController } from './health/health.controller';
import { MediaProcessedHandler } from './events/media-processed.handler';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [reportConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    // JWT — validate tokens independently
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // NATS — fire events to other services
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('report.nats.url') ?? 'nats://localhost:4222'],
            queue: 'report-service',
          },
        }),
      },
    ]),
    TerminusModule,
  ],
  controllers: [ReportController, ReportHealthController, MediaProcessedHandler],
  providers: [
    ReportService,
    PrismaService,
    JwtAuthGuard,

    // Redis — rate limiting + duplicate detection
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('report.redis.host') ?? 'localhost',
          port: config.get<number>('report.redis.port') ?? 6379,
          password: config.get<string>('report.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000), // Permanent backoff
        }),
    },
  ],
})
export class ReportModule {}
