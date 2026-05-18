import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, LagosLGA } from '@app/shared';

import { RewardsService } from './rewards.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';

@ApiTags('Rewards')
@Controller('rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  // ── GET /api/rewards/me
  @Get('me')
  @ApiOperation({ summary: 'Get my rewards profile' })
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.rewardsService.getMyProfile(user);
  }

  // ── GET /api/rewards/me/badges
  @Get('me/badges')
  @ApiOperation({ summary: 'Get my earned badges' })
  getMyBadges(@CurrentUser() user: JwtPayload) {
    return this.rewardsService.getMyBadges(user);
  }

  // ── GET /api/rewards/me/streak
  @Get('me/streak')
  @ApiOperation({ summary: 'Get my current reporting streak' })
  getMyStreak(@CurrentUser() user: JwtPayload) {
    return this.rewardsService.getMyStreak(user);
  }

  // ── GET /api/rewards/leaderboard/platform
  @Get('leaderboard/platform')
  @ApiOperation({ summary: 'Top 100 citizens across Lagos' })
  getPlatformLeaderboard(@Query('page') page: string = '1', @Query('limit') limit: string = '20') {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.rewardsService.getPlatformLeaderboard(safePage, safeLimit);
  }

  // ── GET /api/rewards/leaderboard/lga
  @Get('leaderboard/lga')
  @ApiOperation({ summary: 'Top 50 citizens in a specific LGA' })
  getLgaLeaderboard(
    @Query('lgaId') lgaId: LagosLGA,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.rewardsService.getLgaLeaderboard(lgaId, safePage, safeLimit);
  }
}
