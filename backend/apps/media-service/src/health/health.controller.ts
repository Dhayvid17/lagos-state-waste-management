import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MicroserviceHealthIndicator } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { Public } from '@app/shared';

import { MinioService } from '../minio/minio.service.js';

@ApiTags('Health')
@Controller('health')
export class MediaHealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly microservice: MicroserviceHealthIndicator,
    private readonly configService: ConfigService,
    private readonly minioService: MinioService,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Media Service health check' })
  check() {
    return this.health.check([
      // Check Redis connection
      () =>
        this.microservice.pingCheck('redis', {
          transport: Transport.REDIS,
          options: {
            host: this.configService.get<string>('media.redis.host'),
            port: this.configService.get<number>('media.redis.port'),
            password: this.configService.get<string>('media.redis.password'),
          },
        }),
      // Check MinIO connection
      async () => {
        const isUp = await this.minioService.ping();
        if (isUp) {
          return { minio: { status: 'up' } };
        }
        throw new Error('MinIO is unreachable');
      },
    ]);
  }
}
