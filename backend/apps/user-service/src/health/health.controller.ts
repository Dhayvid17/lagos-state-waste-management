import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type Redis from 'ioredis';

@ApiTags('Health')
@Controller('health')
export class UserHealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly prismaService: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  // GET /api/health — no auth required
  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'User Service health check' })
  async check() {
    return this.health.check([
      // PostgreSQL check via Prisma
      () => this.prisma.pingCheck('postgresql', this.prismaService),
      // Redis check — simple ping
      async () => {
        const pong = await this.redis.ping();
        return {
          redis: {
            status: pong === 'PONG' ? 'up' : 'down',
          },
        };
      },
    ]);
  }
}
