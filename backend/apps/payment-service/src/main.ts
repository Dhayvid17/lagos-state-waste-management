import { NestFactory, Reflector } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import * as bodyParser from 'body-parser';

import {
  GlobalExceptionFilter,
  LoggingInterceptor,
  TransformInterceptor,
  StrictValidationPipe,
} from '@app/shared';

import { PaymentModule } from './payment.module.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INTERVAL = 5000;

async function bootstrap(retryCount = 0) {
  const logger = new Logger('PaymentService');

  try {
    logger.log('Starting Payment Service...');

    // ── CRITICAL: Disable NestJS default body parser
    // RawBodyMiddleware handles webhook routes manually
    // Regular routes still get JSON parsing via explicit middleware below
    const app = await NestFactory.create(PaymentModule, {
      bodyParser: false, // ← Disable default body parser
      logger:
        process.env.NODE_ENV === 'prod'
          ? ['error', 'warn']
          : ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    const config = app.get(ConfigService);
    const port = parseInt(config.get<string>('PAYMENT_SERVICE_PORT') ?? '3006', 10);

    // ── Apply JSON body parser to ALL routes except webhooks
    // Webhooks are handled by RawBodyMiddleware configured in PaymentModule
    app.use(/^(?!\/api\/payments\/webhook).*$/, bodyParser.json({ limit: '1mb' }));
    app.use(/^(?!\/api\/payments\/webhook).*$/, bodyParser.urlencoded({ extended: true }));

    // ── Cookie parser
    app.use(cookieParser());

    // ── Global pipes, filters, interceptors
    app.useGlobalPipes(new StrictValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

    // ── Global JWT guard with Redis blocklist
    const reflector = app.get(Reflector);
    const redisClient = app.get('REDIS_CLIENT');
    app.useGlobalGuards(new JwtAuthGuard(app.get(JwtService), config, reflector, redisClient));

    app.setGlobalPrefix('api');

    app.enableCors({
      origin:
        process.env.NODE_ENV === 'prod'
          ? (config.get<string>('ALLOWED_ORIGINS') ?? '').split(',')
          : '*',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.enableShutdownHooks();

    // ── Swagger (dev only)
    if (process.env.NODE_ENV !== 'prod') {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('Lagos Waste — Payment Service')
        .setDescription('Wallet, Points Redemption & Withdrawal API')
        .setVersion('1.0')
        .addBearerAuth()
        .build();

      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api/payments/docs', app, document);
      logger.log(`📚 Swagger: http://localhost:${port}/api/payments/docs`);
    }

    // ── Rule 7: connectMicroservice BEFORE listen
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.NATS,
      options: {
        servers: [config.get<string>('payment.nats.url') ?? 'nats://localhost:4222'],
        queue: 'payment-service',
      },
    });

    // ── Rule 7: startAllMicroservices BEFORE listen
    await app.startAllMicroservices();
    await app.listen(port);

    logger.log(`🚀 Payment Service running on http://localhost:${port}/api`);
    logger.log(`💳 Flutterwave provider active (default)`);
    logger.log(`💳 Paystack provider active (alternative)`);
    logger.log(`🔒 Webhook endpoints: raw body HMAC verification only`);
    logger.log(`📒 Immutable ledger active — no direct balance updates`);
    logger.log(`🌍 Environment: ${process.env.NODE_ENV ?? 'dev'}`);
  } catch (error) {
    logger.error('❌ Payment Service failed to start');
    logger.error(`Error: ${(error as Error).message}`);

    if (retryCount < MAX_RETRY_ATTEMPTS) {
      logger.warn(
        `Retrying in ${RETRY_INTERVAL / 1000}s... ` + `(${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`,
      );
      await delay(RETRY_INTERVAL);
      return bootstrap(retryCount + 1);
    }

    logger.error('❌ Max retries reached. Shutting down.');
    process.exit(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('uncaughtException', (error: Error) => {
  new Logger('UncaughtException').error(error.message, error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  new Logger('UnhandledRejection').error('Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  new Logger('SIGTERM').log('SIGTERM received — graceful shutdown');
  process.exit(0);
});

process.on('SIGINT', () => {
  new Logger('SIGINT').log('SIGINT received — shutting down');
  process.exit(0);
});

bootstrap();
