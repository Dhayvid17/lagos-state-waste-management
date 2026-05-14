import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schemas/user.schema.js';

@Injectable()
export class CleanupExpiredTokensTask {
  private readonly logger = new Logger(CleanupExpiredTokensTask.name);

  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  // Run at 2:00 AM Lagos time every night
  @Cron('0 2 * * *', {
    timeZone: 'Africa/Lagos',
  })
  async handleCron() {
    this.logger.log('Starting nightly cleanup of expired device sessions...');

    try {
      const now = new Date();
      
      const result = await this.userModel.updateMany(
        {},
        {
          $pull: {
            deviceRefreshTokens: {
              expiresAt: { $lt: now }
            }
          }
        }
      );

      this.logger.log(`Nightly cleanup completed. Modified ${result.modifiedCount} users.`);
    } catch (error) {
      this.logger.error('Failed to cleanup expired tokens:', (error as Error).message);
    }
  }
}
