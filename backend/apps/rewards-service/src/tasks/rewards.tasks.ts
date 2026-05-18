import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RewardsService } from '../rewards.service';

@Injectable()
export class RewardsTasks {
  private readonly logger = new Logger(RewardsTasks.name);

  constructor(private readonly rewardsService: RewardsService) {}

  // ── Every Sunday at 1 AM — recalculate leaderboards
  @Cron('0 1 * * 0')
  async recalculateLeaderboards() {
    this.logger.log('Running weekly leaderboard recalculation...');
    try {
      await this.rewardsService.recalculateLeaderboards();
    } catch (error) {
      this.logger.error(`Leaderboard recalculation failed: ${(error as Error).message}`);
    }
  }
}
