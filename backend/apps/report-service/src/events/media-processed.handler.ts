import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';

import { ReportService } from '../report.service';

/**
 * Handles media processed events from the media-service
 */
@Controller()
export class MediaProcessedHandler {
  private readonly logger = new Logger(MediaProcessedHandler.name);

  constructor(private readonly reportService: ReportService) {}

  @EventPattern('media.processed')
  async handleMediaProcessed(
    @Payload()
    data: {
      originalKey: string;
      compressedKey: string;
      thumbnailKey: string;
      uploadedById: string;
      mediaType: string;
    },
    @Ctx() _context: NatsContext,
  ) {
    try {
      await this.reportService.handleMediaProcessed(data);
    } catch (error) {
      // Rethrow so NATS can retry — do NOT swallow
      this.logger.error(
        `Failed to handle media.processed event: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }
}
