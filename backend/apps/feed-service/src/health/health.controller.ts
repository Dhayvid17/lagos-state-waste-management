import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator, MicroserviceHealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';
import { Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class FeedHealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private microservice: MicroserviceHealthIndicator,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () =>
        this.microservice.pingCheck('nats', {
          transport: Transport.NATS,
          options: {
            servers: [this.config.get<string>('feed.nats.url') ?? 'nats://localhost:4222'],
          },
        }),
    ]);
  }
}
