import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, Roles, UserRole } from '@app/shared';

import { NotificationService } from './notification.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';
import { NotificationChannel, NotificationStatus } from './schemas/notification-log.schema';

// ── Rule 8: HTTP controller is SEPARATE from NATS handler
@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  // ── GET /api/notifications/me
  @Get('me')
  @ApiOperation({ summary: 'Get my notification history' })
  getMyNotifications(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    return this.notificationService.getMyNotifications(
      user,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  // ── GET /api/notifications (admin)
  @Get()
  @Roles(UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Get all notification logs — Admin only' })
  getNotificationLogs(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('channel') channel?: NotificationChannel,
    @Query('status') status?: NotificationStatus,
  ) {
    return this.notificationService.getNotificationLogs(
      user,
      parseInt(page, 10),
      parseInt(limit, 10),
      channel,
      status,
    );
  }
}
