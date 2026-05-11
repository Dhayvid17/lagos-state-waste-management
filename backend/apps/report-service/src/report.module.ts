import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';

import reportConfig from './config/report.config.js';
import { ReportController } from './report.controller.js';
import { ReportService } from './report.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { ReportHealthController } from './health/health.controller.js';

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
  controllers: [ReportController, ReportHealthController],
  providers: [
    ReportService,
    PrismaService,
    JwtAuthGuard,

    // Redis — rate limiting + duplicate detection
    {
      provide: 'REDIS_CLIENT',
      useFactory: () =>
        new Redis({
          host: process.env.REDIS_HOST ?? 'localhost',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
          password: process.env.REDIS_PASSWORD,
          retryStrategy: (times) => (times > 3 ? null : times * 1000),
        }),
    },
  ],
})
export class ReportModule {}
