import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalyticsService } from '../analytics.service';

@Injectable()
export class AnalyticsTasks {
  private readonly logger = new Logger(AnalyticsTasks.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  // ── Midnight daily — recalculate yesterday's aggregates
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async recalculateDailyAggregates() {
    this.logger.log('Running daily aggregate recalculation...');
    try {
      await this.analyticsService.recalculateDailyAggregates();
    } catch (error) {
      this.logger.error(`Daily aggregate failed: ${(error as Error).message}`);
    }
  }

  // ── 2 AM daily — cleanup expired raw events
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupExpiredEvents() {
    this.logger.log('Running analytics event cleanup...');
    try {
      await this.analyticsService.cleanupExpiredEvents();
    } catch (error) {
      this.logger.error(`Analytics cleanup failed: ${(error as Error).message}`);
    }
  }
}
