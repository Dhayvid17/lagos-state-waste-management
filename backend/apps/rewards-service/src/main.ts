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

import { BadgeType } from './generated/prisma/client';

import { RewardsModule } from './rewards.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INTERVAL = 5000;

async function bootstrap(retryCount = 0) {
  const logger = new Logger('RewardsService');

  try {
    logger.log('Starting Rewards Service...');

    const app = await NestFactory.create(RewardsModule, {
      logger:
        process.env.NODE_ENV === 'prod'
          ? ['error', 'warn']
          : ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    const config = app.get(ConfigService);
    const port = parseInt(config.get<string>('REWARDS_SERVICE_PORT') ?? '3011', 10);

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.NATS,
      options: {
        servers: [config.get<string>('rewards.nats.url') ?? 'nats://localhost:4222'],
        queue: 'rewards-service',
      },
    });

    app.use(cookieParser());
    app.useGlobalPipes(new StrictValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

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

    if (process.env.NODE_ENV !== 'prod') {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('Lagos Waste — Rewards Service')
        .setDescription('Badges, Streaks & Leaderboard API')
        .setVersion('1.0')
        .addBearerAuth()
        .build();

      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api/rewards/docs', app, document);
      logger.log(`📚 Swagger: http://localhost:${port}/api/rewards/docs`);
    }

    await app.startAllMicroservices();
    await app.listen(port);

    logger.log(`🚀 Rewards Service running on http://localhost:${port}/api`);
    logger.log(`🏅 Badge engine active — ${Object.keys(BadgeType).length} badge types`);
    logger.log(`🔥 Streak system active — ${5}pts/day bonus capped at 50pts`);
    logger.log(`🏆 Weekly leaderboard cron active — updates every Sunday`);
  } catch (error) {
    logger.error('❌ Rewards Service failed to start');
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
