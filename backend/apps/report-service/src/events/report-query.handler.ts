import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ReportService } from '../report.service';

/**
 * Handles internal NATS request-reply status and owner queries from other services
 */
@Controller()
export class ReportQueryHandler {
  private readonly logger = new Logger(ReportQueryHandler.name);

  constructor(private readonly reportService: ReportService) {}

  @MessagePattern('report.get_status')
  async getStatus(@Payload() data: { reportId: string }): Promise<{ status: string }> {
    this.logger.log(`NATS Query: report.get_status for ${data.reportId}`);
    try {
      const report = await this.reportService.getReportDirectly(data.reportId);
      return { status: report?.status ?? '' };
    } catch (error) {
      this.logger.error(`Failed report.get_status: ${(error as Error).message}`);
      return { status: '' };
    }
  }

  @MessagePattern('report.get_reporter')
  async getReporter(@Payload() data: { reportId: string }): Promise<{ reporterAuthId: string }> {
    this.logger.log(`NATS Query: report.get_reporter for ${data.reportId}`);
    try {
      const report = await this.reportService.getReportDirectly(data.reportId);
      return { reporterAuthId: report?.reporterAuthId ?? '' };
    } catch (error) {
      this.logger.error(`Failed report.get_reporter: ${(error as Error).message}`);
      return { reporterAuthId: '' };
    }
  }

  @MessagePattern('report.get_lga')
  async getLga(@Payload() data: { reportId: string }): Promise<{ lgaId: string }> {
    this.logger.log(`NATS Query: report.get_lga for ${data.reportId}`);
    try {
      const report = await this.reportService.getReportDirectly(data.reportId);
      return { lgaId: report?.lgaId ?? '' };
    } catch (error) {
      this.logger.error(`Failed report.get_lga: ${(error as Error).message}`);
      return { lgaId: '' };
    }
  }
}
