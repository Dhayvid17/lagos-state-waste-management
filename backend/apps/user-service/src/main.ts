import { NestFactory, Reflector } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';

import {
  GlobalExceptionFilter,
  LoggingInterceptor,
  TransformInterceptor,
  StrictValidationPipe,
} from '@app/shared';

import { UserModule } from './user.module.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INTERVAL = 5000;

// ── Main bootstrap function with retry logic for resilient startup
async function bootstrap(retryCount = 0) {
  const logger = new Logger('UserService');

  try {
    logger.log('Starting User Service...');

    /// ── Create Nest application instance
    const app = await NestFactory.create(UserModule, {
      logger:
        process.env.NODE_ENV === 'prod'
          ? ['error', 'warn']
          : ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    /// ── Configure application
    const config = app.get(ConfigService);
    const port = parseInt(process.env.USER_SERVICE_PORT ?? '3002', 10);

    // ── Connect NATS microservice transport for event listening
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.NATS,
      options: {
        servers: [config.get<string>('user.nats.url') ?? 'nats://localhost:4222'],
        queue: 'user-service',
      },
    });

    /// ── Global middleware, pipes, filters, interceptors, guards
    app.use(cookieParser());
    app.useGlobalPipes(new StrictValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

    // ── Apply JWT auth guard globally, except for routes marked with @Public()
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new JwtAuthGuard(app.get(JwtService), config, reflector));

    app.setGlobalPrefix('api');

    // ── Enable CORS
    app.enableCors({
      origin:
        process.env.NODE_ENV === 'prod' ? (process.env.ALLOWED_ORIGINS ?? '').split(',') : '*',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    // ── Enable shutdown hooks
    app.enableShutdownHooks();

    // ── Setup Swagger in non-production environments
    if (process.env.NODE_ENV !== 'prod') {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('Lagos Waste — User Service')
        .setDescription('User Profile Management API')
        .setVersion('1.0')
        .addBearerAuth()
        .build();

      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api/users/docs', app, document);
      logger.log(`📚 Swagger: http://localhost:${port}/api/users/docs`);
    }

    // ── Start both HTTP and NATS microservice
    await app.startAllMicroservices();
    await app.listen(port);

    logger.log(`🚀 User Service running on http://localhost:${port}/api`);
    logger.log(`📡 NATS listener active — waiting for events`);
    logger.log(`🌍 Environment: ${process.env.NODE_ENV ?? 'dev'}`);
  } catch (error) {
    logger.error('❌ User Service failed to start');
    logger.error(`Error: ${(error as Error).message}`);

    if (retryCount < MAX_RETRY_ATTEMPTS) {
      logger.warn(
        `Retrying in ${RETRY_INTERVAL / 1000}s... (${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`,
      );
      await delay(RETRY_INTERVAL);
      return bootstrap(retryCount + 1);
    }

    logger.error('❌ Max retries reached. Shutting down.');
    process.exit(1);
  }
}

// ── Helper function for delay between retries
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
