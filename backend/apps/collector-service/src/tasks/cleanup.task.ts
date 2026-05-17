import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CollectorService } from '../collector.service';

@Injectable()
export class CleanupTask {
  private readonly logger = new Logger(CleanupTask.name);

  constructor(private readonly collectorService: CollectorService) {}

  // ── Run daily at 2 AM — NDPA compliance cleanup
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupExpiredLocationPings() {
    this.logger.log('Running NDPA GPS location cleanup...');
    try {
      await this.collectorService.cleanupExpiredLocationPings();
    } catch (error) {
      this.logger.error(`NDPA cleanup failed: ${(error as Error).message}`);
    }
  }
}
