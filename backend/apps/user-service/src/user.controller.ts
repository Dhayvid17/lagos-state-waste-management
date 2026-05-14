import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser, LagosLGA, Roles, UserRole } from '@app/shared';
import type { JwtPayload } from '@app/shared';

import { UserService } from './user.service';
import { UpdateProfileDto, AddFcmTokenDto, UpdateLocationDto } from './dto/update-profile.dto';

// ── Guard imported from auth-service via shared pattern
// In real microservices this would be a shared guard
// For now user-service validates JWT independently
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ── GET /api/users/me
  @Get('me')
  @ApiOperation({ summary: 'Get my profile' })
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.userService.getMyProfile(user);
  }

  // ── PATCH /api/users/me
  @Patch('me')
  @ApiOperation({ summary: 'Update my profile' })
  updateMyProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto) {
    return this.userService.updateMyProfile(user, dto);
  }

  // ── PATCH /api/users/me/location
  @Patch('me/location')
  @ApiOperation({ summary: 'Update my location' })
  updateLocation(@CurrentUser() user: JwtPayload, @Body() dto: UpdateLocationDto) {
    return this.userService.updateLocation(user, dto);
  }

  // ── POST /api/users/me/fcm-token
  @Post('me/fcm-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register FCM push token' })
  addFcmToken(@CurrentUser() user: JwtPayload, @Body() dto: AddFcmTokenDto) {
    return this.userService.addFcmToken(user, dto.token);
  }

  // ── DELETE /api/users/me/fcm-token
  @Delete('me/fcm-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove FCM push token' })
  removeFcmToken(@CurrentUser() user: JwtPayload, @Body() dto: AddFcmTokenDto) {
    return this.userService.removeFcmToken(user, dto.token);
  }

  // ── GET /api/users/:id (public profile)
  @Get(':id')
  @ApiOperation({ summary: 'Get public profile by ID' })
  getPublicProfile(@Param('id') id: string, @Ip() ip: string) {
    return this.userService.getPublicProfile(id, ip);
  }

  // ── GET /api/users (admin only)
  @Get()
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'List all users — Admin only' })
  getAllUsers(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('lgaId') lgaId?: LagosLGA,
  ) {
    const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    return this.userService.getAllUsers(user, parsedPage, parsedLimit, lgaId);
  }

  // ── PATCH /api/users/:id/kyc
  @Patch(':id/kyc')
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Update KYC status — Agency Admin only' })
  updateKyc(
    @CurrentUser() actor: JwtPayload,
    @Param('id') profileId: string,
    @Body() body: { status: 'VERIFIED' | 'REJECTED'; reason?: string },
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString() ?? undefined;
    const userAgent = req.headers['user-agent'] ?? undefined;
    return this.userService.updateKycStatus(
      actor,
      profileId,
      body.status,
      body.reason,
      ip,
      userAgent,
    );
  }
}
