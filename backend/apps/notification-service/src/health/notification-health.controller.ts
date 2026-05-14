import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MongooseHealthIndicator, MicroserviceHealthIndicator } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@app/shared';
import { Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

@ApiTags('Health')
@Controller('health')
export class NotificationHealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly microservice: MicroserviceHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Notification Service health check' })
  check() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb'),
      () =>
        this.microservice.pingCheck('nats', {
          transport: Transport.NATS,
          options: {
            servers: [this.config.get<string>('notification.nats.url') ?? 'nats://localhost:4222'],
          },
        }),
    ]);
  }
}
