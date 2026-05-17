import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, LagosLGA, Roles, UserRole } from '@app/shared';

import { CollectorService } from './collector.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';
import {
  UpdateLocationDto,
  UpdateAssignmentStatusDto,
  RateCollectorDto,
} from './dto/collector.dto';

@ApiTags('Collector')
@Controller('collector')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CollectorController {
  constructor(private readonly collectorService: CollectorService) {}

  // ── GET /api/collector/assignment/active
  @Get('assignment/active')
  @Roles(UserRole.COLLECTOR)
  @ApiOperation({ summary: 'Get my active assignment' })
  getMyActiveAssignment(@CurrentUser() user: JwtPayload) {
    return this.collectorService.getMyActiveAssignment(user);
  }

  // ── GET /api/collector/assignments
  @Get('assignments')
  @Roles(UserRole.COLLECTOR)
  @ApiOperation({ summary: 'Get my assignment history' })
  getMyAssignments(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('status') status?: string,
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.collectorService.getMyAssignments(user, safePage, safeLimit, status);
  }

  // ── PATCH /api/collector/assignment/:id/status
  @Patch('assignment/:id/status')
  @Roles(UserRole.COLLECTOR)
  @ApiOperation({ summary: 'Update assignment status (ON_ROUTE, COLLECTING, COMPLETED)' })
  updateAssignmentStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateAssignmentStatusDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    const userAgent = req.headers['user-agent'];
    return this.collectorService.updateAssignmentStatus(user, id, dto, ip, userAgent);
  }

  // ── POST /api/collector/location/ping
  @Post('location/ping')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.COLLECTOR)
  @ApiOperation({
    summary: 'GPS ping — send current location (every 30s during active assignment)',
  })
  pingLocation(@CurrentUser() user: JwtPayload, @Body() dto: UpdateLocationDto) {
    return this.collectorService.pingLocation(user, dto);
  }

  // ── GET /api/collector/stats
  @Get('stats')
  @ApiOperation({ summary: 'Get collector stats' })
  getCollectorStats(
    @CurrentUser() user: JwtPayload,
    @Query('collectorAuthId') collectorAuthId?: string,
  ) {
    return this.collectorService.getCollectorStats(user, collectorAuthId);
  }

  // ── POST /api/collector/assignment/:id/rate
  @Post('assignment/:id/rate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Rate a completed collector assignment' })
  rateCollector(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RateCollectorDto,
  ) {
    return this.collectorService.rateCollector(user, id, dto);
  }

  // ── GET /api/collector/map
  @Get('map')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Live collector map for LGA — Admin only' })
  getLiveCollectorMap(@CurrentUser() user: JwtPayload, @Query('lgaId') lgaId: LagosLGA) {
    return this.collectorService.getLiveCollectorMap(user, lgaId);
  }
}
