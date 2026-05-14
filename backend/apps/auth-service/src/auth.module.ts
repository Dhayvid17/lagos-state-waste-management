import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TerminusModule } from '@nestjs/terminus';
import { ScheduleModule } from '@nestjs/schedule';

import authConfig from './config/auth.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema } from './schemas/user.schema';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TokenBlocklistService } from './blocklist/token-blocklist.service';
import { RedisThrottlerStorage } from './throttler/redis-throttler.storage';
import { AuthHealthController } from './health/health.controller';
import { CleanupExpiredTokensTask } from './tasks/cleanup-expired-tokens.task';
import Redis from 'ioredis';

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({
      isGlobal: true,
      load: [authConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // MongoDB
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('auth.mongo.uri'),
      }),
    }),

    // Register User model
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),

    // JWT — async so we can use ConfigService
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('auth.jwt.accessSecret'),
        signOptions: { expiresIn: config.get<any>('auth.jwt.accessExpiry') },
      }),
    }),

    // Passport
    PassportModule.register({ defaultStrategy: 'jwt-access' }),

    // Rate limiting — 10 requests per 60s, backed by Redis (survives restarts)
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: 60000, // 60 seconds
            limit: 10,
          },
        ],
        storage: new RedisThrottlerStorage(config),
      }),
    }),

    // ── NATS JetStream client — fires events to other services
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('auth.nats.url') ?? 'nats://localhost:4222'],
            queue: 'auth-service',
          },
        }),
      },
    ]),
    TerminusModule,
  ],
  controllers: [AuthController, AuthHealthController],
  providers: [
    AuthService,
    JwtAccessStrategy,
    JwtAuthGuard,
    TokenBlocklistService,
    CleanupExpiredTokensTask,
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const client = new Redis({
          host: config.get<string>('auth.redis.host'),
          port: config.get<number>('auth.redis.port'),
          password: config.get<string>('auth.redis.password'),
          retryStrategy: (times) => Math.min(times * 500, 10000), // Infinite exponential backoff capped at 10s
        });

        client.on('connect', () => console.log('Auth Service: Redis connected successfully'));
        client.on('error', (err) => console.error('Auth Service: Redis error:', err.message));

        return client;
      },
    },
  ],
  exports: [AuthService, JwtAuthGuard, 'REDIS_CLIENT'],
})
export class AuthModule {}
