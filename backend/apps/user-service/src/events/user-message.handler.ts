import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload, Ctx, NatsContext, EventPattern } from '@nestjs/microservices';
import { UserService } from '../user.service';

@Controller()
export class UserMessageHandler {
  private readonly logger = new Logger(UserMessageHandler.name);

  constructor(private readonly userService: UserService) {}

  /**
   * Request-Reply handler for resolving user contact information.
   * Pattern: 'user.get_contact'
   */
  @MessagePattern('user.get_contact')
  async getContactInfo(@Payload() data: { authId: string }) {
    this.logger.log(`Resolving contact info for user: ${data.authId}`);
    return this.userService.getContactInfo(data.authId);
  }

  /**
   * Event listener for invalid FCM tokens.
   * Pattern: 'user.remove_fcm_tokens'
   */
  @EventPattern('user.remove_fcm_tokens')
  async handleRemoveFcmTokens(@Payload() data: { authId: string; tokens: string[] }) {
    this.logger.warn(`Received invalid tokens alert for user: ${data.authId}`);
    await this.userService.handleRemoveFcmTokens(data.authId, data.tokens);
  }
}
