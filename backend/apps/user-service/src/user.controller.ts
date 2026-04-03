import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, LagosLGA, Roles, UserRole } from '@app/shared';
import type { JwtPayload } from '@app/shared';

import { UserService } from './user.service.js';
import { UpdateProfileDto, AddFcmTokenDto, UpdateLocationDto } from './dto/update-profile.dto.js';

// ── Guard imported from auth-service via shared pattern
// In real microservices this would be a shared guard
// For now user-service validates JWT independently
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
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
  getPublicProfile(@Param('id') id: string) {
    return this.userService.getPublicProfile(id);
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
    return this.userService.getAllUsers(user, parseInt(page, 10), parseInt(limit, 10), lgaId);
  }

  // ── PATCH /api/users/:id/kyc
  @Patch(':id/kyc')
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Update KYC status — Agency Admin only' })
  updateKyc(
    @CurrentUser() actor: JwtPayload,
    @Param('id') profileId: string,
    @Body() body: { status: 'VERIFIED' | 'REJECTED'; reason?: string },
  ) {
    return this.userService.updateKycStatus(actor, profileId, body.status, body.reason);
  }
}
