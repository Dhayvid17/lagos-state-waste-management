import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, LagosLGA, Roles, UserRole, ReportStatus, WasteType } from '@app/shared';

import { ReportService } from './report.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from '@app/shared';
import { CreateReportDto } from './dto/create-report.dto.js';
import {
  AssignCollectorDto,
  CancelReportDto,
  CompleteReportDto,
  UpdateReportDto,
  UpdateReportStatusDto,
} from './dto/update-report.dto.js';

@ApiTags('Reports')
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  // ============================================================
  // CITIZEN ENDPOINTS
  // ============================================================

  // ── POST /api/reports
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Submit a new waste report' })
  createReport(@CurrentUser() user: JwtPayload, @Body() dto: CreateReportDto) {
    return this.reportService.createReport(user, dto);
  }

  // ── GET /api/reports/my
  @Get('my')
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Get my own reports' })
  getMyReports(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('status') status?: ReportStatus,
  ) {
    return this.reportService.getMyReports(user, parseInt(page, 10), parseInt(limit, 10), status);
  }

  // ── GET /api/reports/nearby
  @Get('nearby')
  @ApiOperation({ summary: 'Get reports near a location' })
  getNearbyReports(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radiusKm') radiusKm: string = '5',
    @Query('lgaId') lgaId?: LagosLGA,
  ) {
    return this.reportService.getNearbyReports(
      parseFloat(lat),
      parseFloat(lng),
      parseFloat(radiusKm),
      lgaId,
    );
  }

  // ── GET /api/reports/stats
  @Get('stats')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Get report statistics — Admin only' })
  getReportStats(@CurrentUser() user: JwtPayload, @Query('lgaId') lgaId?: LagosLGA) {
    return this.reportService.getReportStats(user, lgaId);
  }

  // ── GET /api/reports/points-config
  @Get('points-config')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Get reward points config — Admin only' })
  getPointsConfig(@CurrentUser() user: JwtPayload) {
    return this.reportService.getPointsConfig(user);
  }

  // ── PATCH /api/reports/points-config/:wasteType
  @Patch('points-config/:wasteType')
  @Roles(UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Update reward points config — SYS_ADMIN only' })
  updatePointsConfig(
    @CurrentUser() user: JwtPayload,
    @Param('wasteType') wasteType: WasteType,
    @Body()
    body: {
      basePoints?: number;
      firstReportOfDayMultiplier?: number;
      underservedLgaMultiplier?: number;
      verifiedReporterMultiplier?: number;
      isActive?: boolean;
    },
  ) {
    return this.reportService.updatePointsConfig(user, wasteType, body);
  }

  // ── GET /api/reports (admin list)
  @Get()
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN, UserRole.COLLECTOR)
  @ApiOperation({ summary: 'List all reports — Admin/Collector only' })
  getAllReports(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('status') status?: ReportStatus,
    @Query('lgaId') lgaId?: LagosLGA,
    @Query('wasteType') wasteType?: WasteType,
  ) {
    return this.reportService.getAllReports(
      user,
      parseInt(page, 10),
      parseInt(limit, 10),
      status,
      lgaId,
      wasteType,
    );
  }

  // ── GET /api/reports/:id
  @Get(':id')
  @ApiOperation({ summary: 'Get a single report by ID' })
  getReportById(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.reportService.getReportById(user, id);
  }

  // ── PATCH /api/reports/:id
  @Patch(':id')
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Update own PENDING report — Citizen only' })
  updateReport(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateReportDto,
  ) {
    return this.reportService.updateReport(user, id, dto);
  }

  // ── POST /api/reports/:id/cancel
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Request report cancellation — Citizen only' })
  cancelReport(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CancelReportDto,
  ) {
    return this.reportService.cancelReport(user, id, dto);
  }

  // ── POST /api/reports/:id/upvote
  @Post(':id/upvote')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Upvote a report — confirms dump is real' })
  upvoteReport(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.reportService.upvoteReport(user, id);
  }

  // ============================================================
  // ADMIN ENDPOINTS
  // ============================================================

  // ── POST /api/reports/:id/review
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Mark report as under review — locks citizen edits' })
  reviewReport(
    @CurrentUser() actor: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateReportStatusDto,
  ) {
    return this.reportService.reviewReport(actor, id, dto);
  }

  // ── POST /api/reports/:id/verify
  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Verify a report as genuine — Admin only' })
  verifyReport(
    @CurrentUser() actor: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateReportStatusDto,
  ) {
    return this.reportService.verifyReport(actor, id, dto);
  }

  // ── POST /api/reports/:id/reject
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Reject a report — requires reason' })
  rejectReport(
    @CurrentUser() actor: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateReportStatusDto,
  ) {
    return this.reportService.rejectReport(actor, id, dto);
  }

  // ── POST /api/reports/:id/assign
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Assign a collector to a report — Admin only' })
  assignCollector(
    @CurrentUser() actor: JwtPayload,
    @Param('id') id: string,
    @Body() dto: AssignCollectorDto,
  ) {
    return this.reportService.assignCollector(actor, id, dto);
  }

  // ── POST /api/reports/:id/complete
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.COLLECTOR)
  @ApiOperation({ summary: 'Mark report as completed — Collector only' })
  completeReport(
    @CurrentUser() actor: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteReportDto,
  ) {
    return this.reportService.completeReport(actor, id, dto);
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  @EventPattern('media.processed')
  async handleMediaProcessed(
    @Payload()
    data: {
      originalKey: string;
      compressedKey: string;
      thumbnailKey: string;
      uploadedById: string;
      mediaType: string;
    },
  ) {
    return this.reportService.handleMediaProcessed(data);
  }
}
