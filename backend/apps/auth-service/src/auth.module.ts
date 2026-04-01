import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';

import authConfig from './config/auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { User, UserSchema } from './schemas/user.schema.js';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy.js';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { TokenBlocklistService } from './blocklist/token-blocklist.service.js';

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({
      isGlobal: true,
      load: [authConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

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
        signOptions: { expiresIn: config.get<string>('auth.jwt.accessExpiry') },
      }),
    }),

    // Passport
    PassportModule.register({ defaultStrategy: 'jwt-access' }),

    // Rate limiting — 10 requests per 60s globally
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('auth.redis.port') ? 60000 : 60000,
            limit: 10,
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAccessStrategy,
    JwtRefreshStrategy,
    JwtAuthGuard,
    TokenBlocklistService,
  ],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
