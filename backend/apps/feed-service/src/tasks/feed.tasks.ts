import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeedService } from '../feed.service';

@Injectable()
export class FeedTasks {
  private readonly logger = new Logger(FeedTasks.name);

  constructor(private readonly feedService: FeedService) {}

  // ── Every 5 minutes — recalculate ranking scores
  // Recency score decays over time so must be refreshed
  @Cron('*/5 * * * *')
  async recalculateScores() {
    this.logger.log('Running feed score recalculation...');
    try {
      await this.feedService.recalculateAllScores();
    } catch (error) {
      this.logger.error(`Score recalculation failed: ${(error as Error).message}`);
    }
  }

  // ── Daily at 3 AM — daily feed maintenance
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async dailyMaintenance() {
    this.logger.log('Running daily feed maintenance...');

    try {
      await this.feedService.autoArchiveExpiredPosts();
    } catch (error) {
      this.logger.error(`Auto-archive failed: ${(error as Error).message}`);
    }

    try {
      await this.feedService.recalculateOldPostScores();
    } catch (error) {
      this.logger.error(`Old post recalculation failed: ${(error as Error).message}`);
    }
  }
}
