import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload, Ctx, NatsContext } from '@nestjs/microservices';
import { UserService } from '../user.service.js';
import { CreateProfileDto } from '../dto/create-profile.dto.js';
import { NatsEvents } from '@app/shared';

@Controller()
export class UserCreatedHandler {
  private readonly logger = new Logger(UserCreatedHandler.name);

  constructor(private readonly userService: UserService) {}

  @EventPattern(NatsEvents.USER_CREATED)
  async handleUserCreated(@Payload() payload: CreateProfileDto, @Ctx() context: NatsContext) {
    this.logger.log(`Received ${NatsEvents.USER_CREATED} event for authId: ${payload.authId}`);

    try {
      await this.userService.createProfileFromEvent(payload);
      this.logger.log(`Profile created for authId: ${payload.authId}`);
    } catch (error) {
      this.logger.error(
        `Failed to create profile for authId: ${payload.authId}`,
        (error as Error).message,
      );
      // Don't throw — NATS JetStream will retry automatically
    }
  }
}
