import { NestFactory, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';

import {
  GlobalExceptionFilter,
  LoggingInterceptor,
  TransformInterceptor,
  StrictValidationPipe,
} from '@app/shared';

import { AuthModule } from './auth.module.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

// ============================================================
// CONSTANTS
// ============================================================
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INTERVAL = 5000; // 5 seconds

// ============================================================
// BOOTSTRAP
// ============================================================
async function bootstrap(retryCount = 0) {
  const logger = new Logger('AuthService');

  try {
    logger.log('Starting Auth Service...');

    const app = await NestFactory.create(AuthModule, {
      // ── Use NestJS built-in logger levels in dev, errors only in prod
      logger:
        process.env.NODE_ENV === 'prod'
          ? ['error', 'warn']
          : ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    const config = app.get(ConfigService);
    const port = parseInt(process.env.AUTH_SERVICE_PORT ?? '3001', 10);

    // ── Cookie parser (must be before guards)
    app.use(cookieParser());

    // ── Global validation pipe (from shared lib — strict mode)
    app.useGlobalPipes(new StrictValidationPipe());

    // ── Global exception filter (standardized error responses)
    app.useGlobalFilters(new GlobalExceptionFilter());

    // ── Global interceptors
    app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

    // ── Global JWT guard — protects ALL routes unless @Public() decorator
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new JwtAuthGuard(reflector));

    // ── Global prefix — all routes become /api/auth/...
    app.setGlobalPrefix('api');

    // ── CORS
    app.enableCors({
      origin:
        process.env.NODE_ENV === 'prod' ? (process.env.ALLOWED_ORIGINS ?? '').split(',') : '*',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    // ── Graceful shutdown hooks (critical for Docker/K8s SIGTERM handling)
    app.enableShutdownHooks();

    // ── Swagger docs (dev only)
    if (process.env.NODE_ENV !== 'prod') {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('Lagos Waste — Auth Service')
        .setDescription('Authentication & Authorization API')
        .setVersion('1.0')
        .addBearerAuth()
        .addCookieAuth('refresh_token')
        .build();

      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api/auth/docs', app, document);
      logger.log(`📚 Swagger docs: http://localhost:${port}/api/auth/docs`);
    }

    await app.listen(port);

    logger.log(`🚀 Auth Service running on http://localhost:${port}/api`);
    logger.log(`🌍 Environment: ${process.env.NODE_ENV ?? 'dev'}`);
    logger.log(`🔐 JWT guard active on all routes`);
  } catch (error) {
    logger.error('❌ Auth Service failed to start');
    logger.error(`Error: ${(error as Error).message}`);

    if (retryCount < MAX_RETRY_ATTEMPTS) {
      logger.warn(
        `Retrying in ${RETRY_INTERVAL / 1000}s... (Attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`,
      );
      await delay(RETRY_INTERVAL);
      return bootstrap(retryCount + 1);
    }

    logger.error('❌ Max retry attempts reached. Shutting down.');
    process.exit(1);
  }
}

// ============================================================
// HELPERS
// ============================================================
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// PROCESS-LEVEL ERROR HANDLERS
// ============================================================

// Catches synchronous errors that escape all try/catch blocks
process.on('uncaughtException', (error: Error) => {
  const logger = new Logger('UncaughtException');
  logger.error('Uncaught Exception:', error.message);
  logger.error(error.stack ?? '');
  process.exit(1);
});

// Catches unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  const logger = new Logger('UnhandledRejection');
  logger.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Docker/K8s sends SIGTERM before killing the container
// This gives the app time to finish in-flight requests
process.on('SIGTERM', () => {
  const logger = new Logger('SIGTERM');
  logger.log('SIGTERM received — graceful shutdown initiated');
  process.exit(0);
});

// Ctrl+C in terminal
process.on('SIGINT', () => {
  const logger = new Logger('SIGINT');
  logger.log('SIGINT received — shutting down');
  process.exit(0);
});

// ============================================================
// START
// ============================================================
bootstrap();
