import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MongooseHealthIndicator } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@app/shared';

@ApiTags('Health')
@Controller('health')
export class AuthHealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
  ) {}

  // GET /api/health — no auth required (Docker & Kubernetes need to call this freely)
  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Auth Service health check' })
  check() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb'),
    ]);
  }
}
