import { MiddlewareConsumer, Module, NestModule, RequestMethod, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';
import { ScheduleModule } from '@nestjs/schedule';
import Redis from 'ioredis';

import paymentConfig from './config/payment.config';
import { PaymentController } from './payment.controller';
import { WalletService } from './wallet/wallet.service';
import { PrismaService } from './prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { PaystackProvider } from './providers/paystack.provider';
import { PaymentHandler } from './events/payment.handler';
import { RawBodyMiddleware } from './middleware/raw-body.middleware';
import { PaymentHealthController } from './health/health.controller';
import {
  FLUTTERWAVE_PROVIDER,
  PAYSTACK_PROVIDER,
} from './interfaces/payment-provider.interface';
import { WebhookRetryTask } from './tasks/webhook-retry.task';
import { ReconciliationTask } from './tasks/reconciliation.task';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [paymentConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    TerminusModule,
    ScheduleModule.forRoot(),

    // JWT
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // NATS — receive report.completed, fire payment.success
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('payment.nats.url') ?? 'nats://localhost:4222'],
            queue: 'payment-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    PaymentController,
    PaymentHandler, // ← NATS event listener
    PaymentHealthController,
  ],
  providers: [
    WalletService,
    PrismaService,
    JwtAuthGuard,
    FlutterwaveProvider,
    PaystackProvider,
    WebhookRetryTask,
    ReconciliationTask,

    // ── Provider injection tokens — clean DI for interface pattern
    {
      provide: FLUTTERWAVE_PROVIDER,
      useExisting: FlutterwaveProvider,
    },
    {
      provide: PAYSTACK_PROVIDER,
      useExisting: PaystackProvider,
    },

    // ── Redis — for token blocklist check (financial ops must check)
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisLogger = new Logger('PaymentRedis');
        const client = new Redis({
          host: config.get<string>('payment.redis.host'),
          port: config.get<number>('payment.redis.port'),
          password: config.get<string>('payment.redis.password'),
          // Rule 6 — retry forever, never abandon
          retryStrategy: (times) => Math.min(times * 500, 10000),
        });

        client.on('connect', () => redisLogger.log('Redis connected'));
        client.on('error', (err) => redisLogger.error(`Redis error: ${err.message}`));

        return client;
      },
    },
  ],
})
export class PaymentModule implements NestModule {
  // ── Apply RawBodyMiddleware ONLY to webhook routes
  // Regular routes use NestJS default body parser
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RawBodyMiddleware)
      .forRoutes(
        { path: 'api/payments/webhook/flutterwave', method: RequestMethod.POST },
        { path: 'api/payments/webhook/paystack', method: RequestMethod.POST },
      );
  }
}
