import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, NatsContext, Payload } from '@nestjs/microservices';
import { NatsEvents } from '@app/shared';
import { RewardsService } from '../rewards.service';
import type {
  ReportCompletedPayload,
  UserRegisteredPayload,
  KycVerifiedPayload,
} from '../rewards.service';

// ── Rule 6: NATS handlers SEPARATE from HTTP controller
@Controller()
export class RewardsHandler {
  private readonly logger = new Logger(RewardsHandler.name);

  constructor(private readonly rewardsService: RewardsService) {}

  // ── report.completed → update rewards + badges + streaks
  @EventPattern(NatsEvents.REPORT_COMPLETED)
  async onReportCompleted(
    @Payload() payload: ReportCompletedPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.REPORT_COMPLETED} — processing rewards for ${payload.reporterAuthId}`,
    );
    try {
      await this.rewardsService.handleReportCompleted(payload);
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.REPORT_COMPLETED}: ${(error as Error).message}`);
      throw error; // Rule 8 — rethrow for NATS retry
    }
  }

  // ── user.created → create rewards profile
  @EventPattern(NatsEvents.USER_CREATED)
  async onUserCreated(
    @Payload() payload: UserRegisteredPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(
      `Event: ${NatsEvents.USER_CREATED} — creating rewards profile for ${payload.authId}`,
    );
    try {
      await this.rewardsService.handleUserCreated(payload);
    } catch (error) {
      this.logger.error(`Failed ${NatsEvents.USER_CREATED}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ── kyc.verified → award VERIFIED_CITIZEN badge
  @EventPattern(NatsEvents.KYC_VERIFIED)
  async onKycVerified(
    @Payload() payload: KycVerifiedPayload,
    @Ctx() _ctx: NatsContext,
  ): Promise<void> {
    this.logger.log(`Event: kyc.verified — awarding badge to ${payload.authId}`);
    try {
      await this.rewardsService.handleKycVerified(payload);
    } catch (error) {
      this.logger.error(`Failed kyc.verified: ${(error as Error).message}`);
      throw error;
    }
  }
}
