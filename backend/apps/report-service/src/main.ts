import { NestFactory, Reflector } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';

import {
  GlobalExceptionFilter,
  LoggingInterceptor,
  TransformInterceptor,
  StrictValidationPipe,
} from '@app/shared';

import { ReportModule } from './report.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INTERVAL = 5000;

async function bootstrap(retryCount = 0) {
  const logger = new Logger('ReportService');

  try {
    logger.log('Starting Report Service...');

    const app = await NestFactory.create(ReportModule, {
      logger:
        process.env.NODE_ENV === 'prod'
          ? ['error', 'warn']
          : ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    const config = app.get(ConfigService);
    const port = parseInt(process.env.REPORT_SERVICE_PORT ?? '3003', 10);

    // ── Cookie parser
    app.use(cookieParser());

    // ── Global pipes, filters, interceptors
    app.useGlobalPipes(new StrictValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

    // ── Global JWT guard
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new JwtAuthGuard(app.get(JwtService), config, reflector));

    app.setGlobalPrefix('api');

    app.enableCors({
      origin:
        process.env.NODE_ENV === 'prod' ? (process.env.ALLOWED_ORIGINS ?? '').split(',') : '*',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.enableShutdownHooks();

    // ── Swagger (dev only)
    if (process.env.NODE_ENV !== 'prod') {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('Lagos Waste — Report Service')
        .setDescription('Waste Report Management API')
        .setVersion('1.0')
        .addBearerAuth()
        .build();

      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api/reports/docs', app, document);
      logger.log(`📚 Swagger: http://localhost:${port}/api/reports/docs`);
    }

    // ── Connect NATS microservice transport (hybrid app)
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.NATS,
      options: {
        servers: [config.get<string>('report.nats.url') ?? 'nats://localhost:4222'],
        queue: 'report-service',
      },
    });

    // Start NATS listener BEFORE HTTP so events can be received immediately
    await app.startAllMicroservices();
    await app.listen(port);

    logger.log(`🚀 Report Service running on http://localhost:${port}/api`);
    logger.log(`📡 NATS microservice connected — listening for events`);
    logger.log(`🌍 Environment: ${process.env.NODE_ENV ?? 'dev'}`);
    logger.log(`📍 Geospatial duplicate detection active (50m radius)`);
    logger.log(`⚡ Rate limiting active (10 reports/hour per citizen)`);
  } catch (error) {
    logger.error('❌ Report Service failed to start');
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
