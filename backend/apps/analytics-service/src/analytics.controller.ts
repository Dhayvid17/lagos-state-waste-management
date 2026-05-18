import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, LagosLGA, Roles, UserRole } from '@app/shared';

import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';

@ApiTags('Analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ── GET /api/analytics/dashboard/lga
  @Get('dashboard/lga')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'LGA dashboard — Admin only' })
  getLgaDashboard(
    @CurrentUser() user: JwtPayload,
    @Query('lgaId') lgaId: LagosLGA,
    @Query('days') days: string = '30',
  ) {
    const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    return this.analyticsService.getLgaDashboard(user, lgaId, safeDays);
  }

  // ── GET /api/analytics/dashboard/platform
  @Get('dashboard/platform')
  @Roles(UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Platform-wide dashboard — SYS_ADMIN only' })
  getPlatformDashboard(@CurrentUser() user: JwtPayload, @Query('days') days: string = '30') {
    const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    return this.analyticsService.getPlatformDashboard(user, safeDays);
  }

  // ── GET /api/analytics/heatmap
  @Get('heatmap')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Waste density heatmap — Admin only' })
  getHeatmap(@CurrentUser() user: JwtPayload, @Query('lgaId') lgaId?: LagosLGA) {
    return this.analyticsService.getHeatmap(user, lgaId);
  }

  // ── GET /api/analytics/leaderboard
  @Get('leaderboard')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Weekly LGA leaderboard' })
  getLgaLeaderboard(@CurrentUser() user: JwtPayload) {
    return this.analyticsService.getLgaLeaderboard(user);
  }

  // ── GET /api/analytics/waste-types
  @Get('waste-types')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Waste type breakdown for charts' })
  getWasteTypeBreakdown(
    @CurrentUser() user: JwtPayload,
    @Query('lgaId') lgaId?: LagosLGA,
    @Query('days') days: string = '30',
  ) {
    const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    return this.analyticsService.getWasteTypeBreakdown(user, lgaId, safeDays);
  }
}
