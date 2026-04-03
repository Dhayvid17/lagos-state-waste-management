import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';

import userConfig from './config/user.config.js';
import { UserController } from './user.controller.js';
import { UserService } from './user.service.js';
import { UserCreatedHandler } from './events/user-created.handler.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [userConfig],
      envFilePath: ['../.env.dev', '.env.dev', '.env'],
    }),

    // JWT — for validating tokens independently
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),

    // NATS — for receiving events from auth-service
    ClientsModule.registerAsync([
      {
        name: 'NATS_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: {
            servers: [config.get<string>('user.nats.url') ?? 'nats://localhost:4222'],
            queue: 'user-service',
          },
        }),
      },
    ]),
  ],
  controllers: [
    UserController,
    UserCreatedHandler, // ← NATS event listener
  ],
  providers: [UserService, JwtAuthGuard, PrismaService],
})
export class UserModule {}
