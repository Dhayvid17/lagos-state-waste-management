import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhookRetryTask {
  private readonly logger = new Logger(WebhookRetryTask.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryFailedWebhooks() {
    this.logger.log('Starting webhook retry task...');

    // Find webhooks that:
    // 1. Are not processed
    // 2. Have an error message (failed during first attempt)
    // 3. Were created in the last 24 hours (don't retry ancient stuff)
    const failedWebhooks = await this.prisma.webhookEvent.findMany({
      where: {
        processed: false,
        errorMessage: { not: null },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      take: 10, // Process in small batches to avoid overloading
      orderBy: { createdAt: 'asc' },
    });

    if (failedWebhooks.length === 0) {
      this.logger.log('No failed webhooks to retry.');
      return;
    }

    this.logger.log(`Found ${failedWebhooks.length} failed webhooks to retry.`);

    for (const webhook of failedWebhooks) {
      try {
        this.logger.log(`Retrying webhook: ${webhook.webhookId} (${webhook.eventType})`);
        
        // Clear the error message before retrying to show we are attempting it
        await this.prisma.webhookEvent.update({
          where: { id: webhook.id },
          data: { errorMessage: null },
        });

        await this.walletService.retryWebhookProcessing(webhook);
        
        this.logger.log(`Successfully retried webhook: ${webhook.webhookId}`);
      } catch (error) {
        this.logger.error(
          `Retry attempt failed for webhook ${webhook.webhookId}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log('Webhook retry task completed.');
  }
}
