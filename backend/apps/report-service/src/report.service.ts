import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { JwtPayload } from '@app/shared';
import {
  LagosLGA,
  LOCKED_STATUSES,
  NatsEvents,
  ReportStatus,
  UserRole,
  WasteType,
} from '@app/shared';
import type Redis from 'ioredis';

import { PrismaService } from './prisma/prisma.service';
import type { CreateReportDto } from './dto/create-report.dto';
import type {
  AssignCollectorDto,
  CancelReportDto,
  CompleteReportDto,
  UpdateReportDto,
  UpdateReportStatusDto,
} from './dto/update-report.dto.js';

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  // ============================================================
  // CREATE REPORT
  // ============================================================
  async createReport(user: JwtPayload, dto: CreateReportDto) {
    // ── 1. Rate limit — max 10 reports per hour per citizen
    await this.enforceRateLimit(user.sub);

    // ── 2. Duplicate detection — check within 50m radius
    const duplicate = await this.findNearbyReport(dto.latitude, dto.longitude, dto.lgaId);

    // ── 3. Fetch points config — fallback to 0 points if missing or inactive to ensure system availability
    const pointsConfig = await this.prisma.rewardPointsConfig.findUnique({
      where: { wasteType: dto.wasteType },
    });

    if (!pointsConfig || !pointsConfig.isActive) {
      this.logger.warn(
        `No active points config found for waste type: ${dto.wasteType} — awarding 0 points for report`,
      );
    }

    // ── 4. Calculate points with multipliers (safe null/inactive handling)
    const basePoints = pointsConfig?.isActive ? pointsConfig.basePoints : 0;
    const isFirstToday = await this.isFirstReportToday(user.sub);
    const multiplier =
      pointsConfig?.isActive && isFirstToday ? pointsConfig.firstReportOfDayMultiplier : 1.0;
    const estimatedPoints = Math.round(basePoints * multiplier);

    // ── 5. Create report + initial status history in transaction
    const report = await this.prisma.$transaction(async (tx) => {
      const newReport = await tx.wasteReport.create({
        data: {
          reporterAuthId: user.sub,
          title: dto.title,
          description: dto.description,
          wasteType: dto.wasteType,
          severity: dto.severity,
          latitude: dto.latitude,
          longitude: dto.longitude,
          address: dto.address,
          landmark: dto.landmark,
          lgaId: dto.lgaId,
          mediaUrls: dto.mediaUrls ?? [],
          thumbnailUrl: dto.thumbnailUrl ?? null,
          status: ReportStatus.PENDING,
          isDuplicate: !!duplicate,
          duplicateOfReportId: duplicate?.id ?? null,
          metadata: {
            estimatedPoints,
            multiplierApplied: multiplier,
          },
        },
      });

      // Write initial status history
      await tx.reportStatusHistory.create({
        data: {
          reportId: newReport.id,
          fromStatus: null,
          toStatus: ReportStatus.PENDING,
          changedById: user.sub,
          changedByRole: user.role,
          note: 'Report submitted by citizen',
        },
      });

      return newReport;
    });

    this.logger.log(
      `Report created: ${report.id} by ${user.sub} [${dto.wasteType}] in ${dto.lgaId}`,
    );

    // ── 6. Fire NATS event — notification-service will alert nearby collectors
    this.natsClient.emit(NatsEvents.REPORT_CREATED, {
      reportId: report.id,
      reporterAuthId: user.sub,
      wasteType: dto.wasteType,
      severity: dto.severity,
      lgaId: dto.lgaId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      estimatedPoints,
      isDuplicate: report.isDuplicate,
      timestamp: new Date().toISOString(),
    });

    return {
      ...report,
      estimatedPoints,
      isDuplicate: report.isDuplicate,
      duplicateWarning: report.isDuplicate
        ? 'A similar report exists nearby. Your report has been recorded but marked as a potential duplicate.'
        : null,
    };
  }

  // ============================================================
  // GET MY REPORTS — Citizen's own reports with pagination
  // ============================================================
  async getMyReports(
    user: JwtPayload,
    page: number = 1,
    limit: number = 20,
    status?: ReportStatus,
  ) {
    // ── Pagination guards
    page = !Number.isInteger(page) || page < 1 ? 1 : page;
    limit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);

    const skip = (page - 1) * limit;
    const where: any = { reporterAuthId: user.sub };
    if (status) where.status = status;

    // ── Fetch reports + total count in parallel for pagination metadata
    const [data, total] = await Promise.all([
      this.prisma.wasteReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          wasteType: true,
          severity: true,
          status: true,
          lgaId: true,
          thumbnailUrl: true,
          pointsAwarded: true,
          isDuplicate: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.wasteReport.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      // ── MEDIA PRESIGN CONTRACT
      // mediaUrls / thumbnailUrl in each record are MinIO object keys, NOT presigned URLs.
      // At Lagos scale, presigning N keys per request on the server would add a blocking
      // NATS round-trip per report and is NOT acceptable for paginated list endpoints.
      // Frontend: collect all keys from the response, then call:
      //   GET /api/media/presign?keys[]=key1&keys[]=key2&...
      // to get a single batch of presigned URLs before rendering.
    };
  }

  // ============================================================
  // GET SINGLE REPORT
  // ============================================================
  async getReportById(user: JwtPayload, reportId: string) {
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
      include: {
        statusHistory: {
          orderBy: { createdAt: 'asc' },
        },
        comments: {
          where: {
            // Citizens only see public comments
            isInternal: user.role === UserRole.CITIZEN ? false : undefined,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Citizens can only see their own reports
    if (user.role === UserRole.CITIZEN && report.reporterAuthId !== user.sub) {
      throw new ForbiddenException('You can only view your own reports');
    }

    // ── AGENCY_ADMIN can only see reports in their LGA
    if (user.role === UserRole.AGENCY_ADMIN && report.lgaId !== user.lgaId) {
      throw new ForbiddenException('You can only view reports in your LGA');
    }

    // ── COLLECTOR can only see reports assigned to them
    if (user.role === UserRole.COLLECTOR && report.assignedCollectorId !== user.sub) {
      throw new ForbiddenException('You can only view reports assigned to you');
    }

    // ── MEDIA PRESIGN CONTRACT
    // mediaUrls and thumbnailUrl contain MinIO object keys (e.g. 'reports/userId/2026/01/uuid.webp').
    // They are NEVER stored as presigned URLs to avoid stale-link issues at scale.
    // The frontend must call: GET /api/media/presign?keys[]=key1&keys[]=key2
    // to get fresh presigned URLs (15-min TTL) before rendering images.
    return report;
  }

  // ============================================================
  // UPDATE REPORT — Citizens only, PENDING status only
  // ============================================================
  async updateReport(user: JwtPayload, reportId: string, dto: UpdateReportDto) {
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Only the reporter can edit
    if (report.reporterAuthId !== user.sub) {
      throw new ForbiddenException('You can only edit your own reports');
    }

    // ── Only PENDING reports can be edited
    if (LOCKED_STATUSES.includes(report.status as any)) {
      throw new ForbiddenException(
        `Report is locked. Status is ${report.status} — no further edits allowed.`,
      );
    }

    const { mediaUrls, thumbnailUrl, ...contentFields } = dto;

    const updated = await this.prisma.wasteReport.update({
      where: { id: reportId },
      data: {
        ...contentFields, // title, description, wasteType, severity, lat/lng, address, etc.
        updatedAt: new Date(),
        // Only update media if provided AND validate that the keys belong to this user
        ...(mediaUrls !== undefined && {
          mediaUrls: mediaUrls.filter((key) => key.includes(`/${report.reporterAuthId}/`)),
        }),
        ...(thumbnailUrl !== undefined &&
          thumbnailUrl.includes(`/${report.reporterAuthId}/`) && {
            thumbnailUrl,
          }),
      },
    });

    this.logger.log(`Report updated: ${reportId} by citizen ${user.sub}`);
    return updated;
  }

  // ============================================================
  // CANCEL REPORT — Citizen requests cancellation (soft delete)
  // ============================================================
  async cancelReport(user: JwtPayload, reportId: string, dto: CancelReportDto) {
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Only reporter can cancel
    if (report.reporterAuthId !== user.sub) {
      throw new ForbiddenException('You can only cancel your own reports');
    }

    // ── Cannot cancel locked reports
    if (LOCKED_STATUSES.includes(report.status as any)) {
      throw new ForbiddenException(
        `Cannot cancel a report with status: ${report.status}. Contact your LGA admin.`,
      );
    }

    // ── Already cancelled
    if (report.status === ReportStatus.CANCELLED) {
      throw new BadRequestException('Report is already cancelled');
    }

    // ── Soft delete by setting status to CANCELLED and recording cancellation reason
    const updated = await this.prisma.$transaction(async (tx) => {
      const cancelledReport = await tx.wasteReport.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: dto.reason ?? 'No reason provided',
          cancellationRequestedAt: new Date(),
        },
      });

      // Record status change in history
      await tx.reportStatusHistory.create({
        data: {
          reportId: reportId,
          fromStatus: report.status as ReportStatus,
          toStatus: ReportStatus.CANCELLED,
          changedById: user.sub,
          changedByRole: user.role,
          note: dto.reason ?? 'Citizen requested cancellation',
        },
      });

      return cancelledReport;
    });

    // ── Fire NATS event — notification-service will alert nearby collectors to ignore this report
    this.natsClient.emit(NatsEvents.REPORT_CANCELLED, {
      reportId,
      reporterAuthId: user.sub,
      reason: dto.reason,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  // ============================================================
  // ADMIN — GET ALL REPORTS (Paginated + filtered)
  // ============================================================
  async getAllReports(
    user: JwtPayload,
    page: number = 1,
    limit: number = 20,
    status?: ReportStatus,
    lgaId?: LagosLGA,
    wasteType?: WasteType,
  ) {
    if (
      user.role !== UserRole.SYS_ADMIN &&
      user.role !== UserRole.AGENCY_ADMIN &&
      user.role !== UserRole.COLLECTOR
    ) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const where: any = {};

    // ── AGENCY_ADMIN locked to their LGA
    if (user.role === UserRole.AGENCY_ADMIN) {
      where.lgaId = user.lgaId;
    } else if (lgaId) {
      where.lgaId = lgaId;
    }

    // ── COLLECTOR only sees assigned reports
    if (user.role === UserRole.COLLECTOR) {
      where.assignedCollectorId = user.sub;
    }

    if (status) where.status = status;
    if (wasteType) where.wasteType = wasteType;

    // ── Pagination guards
    page = !Number.isInteger(page) || page < 1 ? 1 : page;
    limit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.wasteReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          wasteType: true,
          severity: true,
          status: true,
          lgaId: true,
          latitude: true,
          longitude: true,
          address: true,
          thumbnailUrl: true,
          reporterAuthId: true,
          isDuplicate: true,
          upvoteCount: true,
          pointsAwarded: true,
          createdAt: true,
        },
      }),
      this.prisma.wasteReport.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ============================================================
  // ADMIN — REVIEW REPORT (locks it from citizen edits)
  // ============================================================
  async reviewReport(actor: JwtPayload, reportId: string, dto: UpdateReportStatusDto) {
    return this.changeStatus(
      actor,
      reportId,
      ReportStatus.UNDER_REVIEW,
      dto.note,
      [UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN],
      [ReportStatus.PENDING],
    );
  }

  // ============================================================
  // ADMIN — VERIFY REPORT
  // ============================================================
  async verifyReport(actor: JwtPayload, reportId: string, dto: UpdateReportStatusDto) {
    const report = await this.changeStatus(
      actor,
      reportId,
      ReportStatus.VERIFIED,
      dto.note,
      [UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN],
      [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW],
    );

    // ── Fire NATS — notification-service will SMS the citizen
    this.natsClient.emit(NatsEvents.REPORT_VERIFIED, {
      reportId: report.id,
      reporterAuthId: report.reporterAuthId,
      lgaId: report.lgaId,
      wasteType: report.wasteType,
      verifiedById: actor.sub,
      timestamp: new Date().toISOString(),
    });

    return report;
  }

  // ============================================================
  // ADMIN — REJECT REPORT
  // ============================================================
  async rejectReport(actor: JwtPayload, reportId: string, dto: UpdateReportStatusDto) {
    if (!dto.note) {
      throw new BadRequestException('Rejection reason is required');
    }

    // ── Use changeStatus to leverage its guards (LGA, roles, status transitions)
    const updated = await this.changeStatus(
      actor,
      reportId,
      ReportStatus.REJECTED,
      dto.note,
      [UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN],
      [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW],
    );

    // ── Additional rejection-specific logic (already handled by changeStatus but we update specific fields here)
    // Actually, changeStatus is generic. Let's customize it to handle the extra rejection/verification fields.
    // Wait, the original code had custom fields for rejection. I'll merge them into changeStatus or keep them here.
    // I'll update changeStatus to be more flexible.
    
    // Fire NATS — notification-service will SMS the citizen
    this.natsClient.emit(NatsEvents.REPORT_REJECTED, {
      reportId: updated.id,
      reporterAuthId: updated.reporterAuthId,
      rejectionReason: dto.note,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  // ============================================================
  // ADMIN — ASSIGN COLLECTOR
  // ============================================================
  async assignCollector(actor: JwtPayload, reportId: string, dto: AssignCollectorDto) {
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Only AGENCY_ADMIN and SYS_ADMIN can assign
    this.enforceAdminLgaBoundary(actor, report.lgaId as LagosLGA);

    // ── Report must be VERIFIED to be assigned
    if (report.status !== ReportStatus.VERIFIED) {
      throw new BadRequestException('Report must be VERIFIED before assigning a collector');
    }

    // ── Cannot assign if already assigned
    if (report.assignedCollectorId) {
      throw new BadRequestException('Report is already assigned to a collector');
    }

    // ── Validate that the assigned user is an active collector via NATS request-reply
    // We cannot query userProfile directly here — that model lives in the user-service schema.
    // TODO (for Claude): Add a MessagePattern handler in user-service for 'user.validate_collector'
    // that checks profile.isActiveDriver === true and replies { isValid: boolean }.
    // Then uncomment and wire up the NATS call below:
    //
    // const validation = await firstValueFrom(
    //   this.natsClient.send('user.validate_collector', { authId: dto.collectorAuthId })
    // );
    // if (!validation?.isValid) {
    //   throw new BadRequestException(`'${dto.collectorAuthId}' is not a registered active collector`);
    // }

    const updated = await this.prisma.$transaction(async (tx) => {
      const assignedReport = await tx.wasteReport.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.ASSIGNED,
          assignedAt: new Date(),
          assignedCollectorId: dto.collectorAuthId,
          assignedById: actor.sub,
        },
      });

      await tx.reportStatusHistory.create({
        data: {
          reportId: reportId,
          fromStatus: ReportStatus.VERIFIED,
          toStatus: ReportStatus.ASSIGNED,
          changedById: actor.sub,
          changedByRole: actor.role,
          note: dto.note ?? `Assigned to collector ${dto.collectorAuthId}`,
        },
      });

      return assignedReport;
    });

    // ── Fire NATS event — notification-service will alert nearby collectors to ignore this report
    this.natsClient.emit(NatsEvents.REPORT_ASSIGNED, {
      reportId: report.id,
      reporterAuthId: report.reporterAuthId,
      collectorAuthId: dto.collectorAuthId,
      lgaId: report.lgaId,
      wasteType: report.wasteType,
      latitude: report.latitude,
      longitude: report.longitude,
      address: report.address,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  // ============================================================
  // COLLECTOR — COMPLETE REPORT
  // ============================================================
  async completeReport(actor: JwtPayload, reportId: string, dto: CompleteReportDto) {
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Only the assigned collector can complete
    if (actor.role === UserRole.COLLECTOR && report.assignedCollectorId !== actor.sub) {
      throw new ForbiddenException('You are not assigned to this report');
    }

    // ── Report must be in ASSIGNED or IN_PROGRESS status to be completed
    if (report.status !== ReportStatus.ASSIGNED && report.status !== ReportStatus.IN_PROGRESS) {
      throw new BadRequestException('Report must be ASSIGNED or IN_PROGRESS to complete');
    }

    // ── Calculate final points with all applicable multipliers
    const pointsConfig = await this.prisma.rewardPointsConfig.findUnique({
      where: { wasteType: report.wasteType },
    });

    // Fallback to base points if config is missing
    const basePoints = pointsConfig?.basePoints ?? 10;

    // ── Re-apply the same multipliers used at submission time
    // 1. First-report-of-day bonus (Read from persisted metadata)
    const storedMetadata = (report.metadata as { multiplierApplied?: number }) ?? {};
    let multiplier = storedMetadata.multiplierApplied ?? 1.0;

    // 2. Underserved LGA bonus — checked against config
    // (underservedLgaMultiplier > 1.0 means this LGA is flagged as underserved by admin)
    const lgaMultiplier = pointsConfig?.underservedLgaMultiplier ?? 1.0;
    multiplier = multiplier * lgaMultiplier;

    const finalPoints = Math.round(basePoints * multiplier);

    // ── Update report status to COMPLETED, set completedAt, and record points awarded in a transaction
    const updated = await this.prisma.$transaction(async (tx) => {
      const completedReport = await tx.wasteReport.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.COMPLETED,
          completedAt: new Date(),
          collectorNote: dto.collectorNote,
          pointsAwarded: finalPoints,
          // Append completion media if provided
          mediaUrls: dto.completionMediaUrls?.length
            ? { push: dto.completionMediaUrls }
            : undefined,
        },
      });

      await tx.reportStatusHistory.create({
        data: {
          reportId: reportId,
          fromStatus: report.status as ReportStatus,
          toStatus: ReportStatus.COMPLETED,
          changedById: actor.sub,
          changedByRole: actor.role,
          note: dto.collectorNote ?? 'Waste collected',
          metadata: { pointsAwarded: finalPoints },
        },
      });

      return completedReport;
    });

    // ── Fire NATS — payment-service awards points, notification-service alerts citizen
    this.natsClient.emit(NatsEvents.REPORT_COMPLETED, {
      reportId,
      reporterAuthId: report.reporterAuthId,
      collectorAuthId: actor.sub,
      wasteType: report.wasteType,
      lgaId: report.lgaId,
      pointsAwarded: finalPoints,
      timestamp: new Date().toISOString(),
      mediaKeys: report.mediaUrls,
      completionMediaKeys: dto.completionMediaUrls ?? [],
    });

    this.logger.log(
      `Report ${reportId} completed. ${finalPoints} points awarded to ${report.reporterAuthId}`,
    );

    return updated;
  }

  // ============================================================
  // UPVOTE REPORT — Citizens confirm a dump is real
  // ============================================================
  async upvoteReport(user: JwtPayload, reportId: string) {
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Cannot upvote your own report
    if (report.reporterAuthId === user.sub) {
      throw new BadRequestException('You cannot upvote your own report');
    }

    // ── Cannot upvote twice
    if (report.upvotedByIds.includes(user.sub)) {
      throw new ConflictException('You have already upvoted this report');
    }

    // ── Cap upvoters array at 100
    if (report.upvotedByIds.length >= 100) {
      throw new BadRequestException('This report has reached the maximum upvotes');
    }

    // ── Cannot upvote completed/rejected/cancelled reports
    if (
      [ReportStatus.COMPLETED, ReportStatus.REJECTED, ReportStatus.CANCELLED].includes(
        report.status as ReportStatus,
      )
    ) {
      throw new BadRequestException(`Cannot upvote a report with status: ${report.status}`);
    }

    await this.prisma.wasteReport.update({
      where: { id: reportId },
      data: {
        upvoteCount: { increment: 1 },
        upvotedByIds: { push: user.sub },
      },
    });

    return { message: 'Report upvoted successfully' };
  }

  // ============================================================
  // GET REPORTS NEAR LOCATION — PostGIS-style query
  // ============================================================
  async getNearbyReports(
    latitude: number,
    longitude: number,
    radiusKm: number = 5,
    lgaId?: LagosLGA,
  ) {
    // ── Bounding box approximation (1 degree ≈ 111km)
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.cos((latitude * Math.PI) / 180));

    const where: any = {
      latitude: { gte: latitude - latDelta, lte: latitude + latDelta },
      longitude: { gte: longitude - lngDelta, lte: longitude + lngDelta },
      status: {
        notIn: [ReportStatus.COMPLETED, ReportStatus.REJECTED, ReportStatus.CANCELLED],
      },
    };

    if (lgaId) where.lgaId = lgaId;

    // ── For simplicity, we return all reports in the bounding box. In a real implementation, we would calculate the exact distance and sort by proximity.
    const reports = await this.prisma.wasteReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        wasteType: true,
        severity: true,
        status: true,
        latitude: true,
        longitude: true,
        address: true,
        thumbnailUrl: true,
        upvoteCount: true,
        createdAt: true,
      },
    });

    return reports;
  }

  // ============================================================
  // GET REPORT STATISTICS — Admin dashboard
  // ============================================================
  async getReportStats(user: JwtPayload, lgaId?: LagosLGA) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // AGENCY_ADMIN can only see stats for their LGA, SYS_ADMIN can specify LGA or see all
    const targetLga = user.role === UserRole.AGENCY_ADMIN ? (user.lgaId as LagosLGA) : lgaId;

    const where: any = {};
    if (targetLga) where.lgaId = targetLga;

    const [
      total,
      pending,
      underReview,
      verified,
      assigned,
      completed,
      rejected,
      cancelled,
      byWasteType,
      bySeverity,
    ] = await Promise.all([
      this.prisma.wasteReport.count({ where }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.PENDING } }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.UNDER_REVIEW } }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.VERIFIED } }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.ASSIGNED } }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.COMPLETED } }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.REJECTED } }),
      this.prisma.wasteReport.count({ where: { ...where, status: ReportStatus.CANCELLED } }),
      this.prisma.wasteReport.groupBy({
        by: ['wasteType'],
        where,
        _count: { wasteType: true },
      }),
      this.prisma.wasteReport.groupBy({
        by: ['severity'],
        where,
        _count: { severity: true },
      }),
    ]);

    return {
      total,
      byStatus: {
        pending,
        underReview,
        verified,
        assigned,
        completed,
        rejected,
        cancelled,
        completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
      byWasteType: byWasteType.map((w) => ({
        wasteType: w.wasteType,
        count: w._count.wasteType,
      })),
      bySeverity: bySeverity.map((s) => ({
        severity: s.severity,
        count: s._count.severity,
      })),
    };
  }

  // ============================================================
  // ADMIN — GET POINTS CONFIG
  // ============================================================
  async getPointsConfig(user: JwtPayload) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return this.prisma.rewardPointsConfig.findMany({
      orderBy: { wasteType: 'asc' },
    });
  }

  // ============================================================
  // ADMIN — UPDATE POINTS CONFIG (No redeployment needed)
  // ============================================================
  async updatePointsConfig(
    user: JwtPayload,
    wasteType: WasteType,
    updates: {
      basePoints?: number;
      firstReportOfDayMultiplier?: number;
      underservedLgaMultiplier?: number;
      verifiedReporterMultiplier?: number;
      isActive?: boolean;
    },
  ) {
    if (user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only SYS_ADMIN can update points config');
    }

    // ── Validate waste type exists in config
    const existingConfig = await this.prisma.rewardPointsConfig.findUnique({
      where: { wasteType },
    });

    if (!existingConfig) {
      throw new BadRequestException(`Points config for waste type '${wasteType}' not found`);
    }

    const updated = await this.prisma.rewardPointsConfig.update({
      where: { wasteType },
      data: updates,
    });

    this.logger.log(
      `Points config updated for ${wasteType} by ${user.sub}: ${JSON.stringify(updates)}`,
    );

    return updated;
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async enforceRateLimit(userId: string) {
    const key = `report_rate:${userId}`;
    const count = await this.redis.incr(key);

    // ── Set expiry on first increment atomically (Redis 7+ NX flag)
    // NX = only set expiry if no expiry exists — prevents race conditions
    await this.redis.call('EXPIRE', key, 60 * 60, 'NX');

    // Allow up to 10 reports per hour
    if (count > 10) {
      throw new BadRequestException(
        'Rate limit exceeded. You can only submit 10 reports per hour.',
      );
    }
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async findNearbyReport(latitude: number, longitude: number, lgaId: LagosLGA) {
    const radiusMeters = 50;
    const latDelta = radiusMeters / 111000;
    const lngDelta = radiusMeters / (111000 * Math.cos((latitude * Math.PI) / 180));

    // ── Only consider reports from the last 7 days to avoid "hotspot" false positives
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Only consider reports that are not rejected or cancelled
    return this.prisma.wasteReport.findFirst({
      where: {
        lgaId,
        latitude: { gte: latitude - latDelta, lte: latitude + latDelta },
        longitude: { gte: longitude - lngDelta, lte: longitude + lngDelta },
        createdAt: { gte: sevenDaysAgo },
        status: {
          notIn: [ReportStatus.REJECTED, ReportStatus.CANCELLED],
        },
      },
    });
  }

  private async isFirstReportToday(userId: string): Promise<boolean> {
    // WAT (West Africa Time) is UTC+1 = 60 minutes ahead
    const nowUtc = new Date();
    const lagosOffsetMs = 60 * 60 * 1000;

    // Get start of today in Lagos time, then convert back to UTC for DB query
    // 1. Convert current UTC time to Lagos time
    const lagosNow = new Date(nowUtc.getTime() + lagosOffsetMs);

    // 2. Get the midnight of that day in Lagos time
    const lagosStartOfDay = new Date(lagosNow);
    lagosStartOfDay.setUTCHours(0, 0, 0, 0);

    // 3. Convert that Lagos midnight back to UTC for the database query
    const utcStartOfDay = new Date(lagosStartOfDay.getTime() - lagosOffsetMs);

    const existingToday = await this.prisma.wasteReport.findFirst({
      where: {
        reporterAuthId: userId,
        createdAt: { gte: utcStartOfDay },
      },
    });

    return !existingToday;
  }

  // Enforces that AGENCY_ADMIN can only manage reports within their assigned LGA
  private enforceAdminLgaBoundary(actor: JwtPayload, reportLgaId: LagosLGA) {
    if (actor.role === UserRole.AGENCY_ADMIN && actor.lgaId !== reportLgaId) {
      throw new ForbiddenException('You can only manage reports in your assigned LGA');
    }
  }

  // Generalized status change handler for review, verify, reject actions with role and LGA boundary checks
  private async changeStatus(
    actor: JwtPayload,
    reportId: string,
    newStatus: ReportStatus,
    note?: string,
    allowedRoles?: UserRole[],
    allowedFromStatuses?: ReportStatus[],
  ) {
    if (allowedRoles && !allowedRoles.includes(actor.role)) {
      throw new ForbiddenException(`Role '${actor.role}' cannot perform this action`);
    }

    // Fetch report to check existence and LGA boundary before making any updates
    const report = await this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw new NotFoundException('Report not found');

    // ── Enforce status transition guard
    if (allowedFromStatuses && !allowedFromStatuses.includes(report.status as ReportStatus)) {
      throw new BadRequestException(
        `Cannot change report status to '${newStatus}' from its current status of '${report.status}'. ` +
          `Allowed starting statuses: ${allowedFromStatuses.join(', ')}`,
      );
    }

    // Enforce LGA boundary for AGENCY_ADMIN
    this.enforceAdminLgaBoundary(actor, report.lgaId as LagosLGA);

    // Additional checks based on newStatus can be added here if needed (e.g., only allow certain transitions)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.wasteReport.update({
        where: { id: reportId },
        data: {
          status: newStatus,
          lockedAt: report.lockedAt ?? new Date(),
          lockedById: report.lockedById ?? actor.sub,
          // Verification-specific fields
          verifiedAt: newStatus === ReportStatus.VERIFIED ? new Date() : undefined,
          verifiedById: newStatus === ReportStatus.VERIFIED ? actor.sub : undefined,
          verificationNote: newStatus === ReportStatus.VERIFIED ? note : undefined,
          // Rejection-specific fields
          rejectedAt: newStatus === ReportStatus.REJECTED ? new Date() : undefined,
          rejectedById: newStatus === ReportStatus.REJECTED ? actor.sub : undefined,
          rejectionReason: newStatus === ReportStatus.REJECTED ? note : undefined,
        },
      });

      await tx.reportStatusHistory.create({
        data: {
          reportId: reportId,
          fromStatus: report.status as ReportStatus,
          toStatus: newStatus,
          changedById: actor.sub,
          changedByRole: actor.role,
          note: note ?? null,
        },
      });

      return updated;
    });
  }

  // ============================================================
  // EVENT HANDLERS (from other services)
  // ============================================================

  async handleMediaProcessed(data: {
    originalKey: string;
    compressedKey: string;
    thumbnailKey: string;
    uploadedById: string;
    mediaType: string;
  }) {
    this.logger.log(`Received media.processed event for ${data.originalKey}`);

    // Find reports that contain the original media key
    const reports = await this.prisma.wasteReport.findMany({
      where: {
        mediaUrls: {
          has: data.originalKey,
        },
      },
    });

    if (reports.length === 0) {
      this.logger.warn(`No report found containing media key: ${data.originalKey}`);
      return;
    }

    // Update all matching reports (usually just 1) in parallel
    await Promise.all(
      reports.map(async (report) => {
        // Replace the old key with the new compressed key in the array
        const updatedMediaUrls = report.mediaUrls.map((url) =>
          url === data.originalKey ? data.compressedKey : url,
        );

        // Only update the thumbnail if:
        // (a) no thumbnail has been set yet, OR
        // (b) the current thumbnail is still the original uncompressed key
        const shouldUpdateThumbnail =
          !report.thumbnailUrl || report.thumbnailUrl === data.originalKey;

        await this.prisma.wasteReport.update({
          where: { id: report.id },
          data: {
            mediaUrls: updatedMediaUrls,
            ...(shouldUpdateThumbnail && { thumbnailUrl: data.thumbnailKey }),
          },
        });

        this.logger.log(
          `Updated Report ${report.id}: compressed media key stored${shouldUpdateThumbnail ? ', thumbnail updated' : ' (thumbnail preserved)'}`,
        );
      }),
    );
  }

  // ============================================================
  // GET REPORT DIRECTLY — Internal microservice helper
  // ============================================================
  async getReportDirectly(reportId: string) {
    return this.prisma.wasteReport.findUnique({
      where: { id: reportId },
    });
  }
}
