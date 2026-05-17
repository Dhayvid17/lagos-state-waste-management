import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import * as crypto from 'crypto';
import type { JwtPayload } from '@app/shared';
import { NatsEvents, UserRole, LagosLGA } from '@app/shared';
import type Redis from 'ioredis';
import { firstValueFrom, timeout } from 'rxjs';
import { LagosLGA as PrismaLagosLGA } from './generated/prisma/enums';

import { PrismaService } from './prisma/prisma.service';
import type {
  UpdateLocationDto,
  UpdateAssignmentStatusDto,
  RateCollectorDto,
} from './dto/collector.dto';

@Injectable()
export class CollectorService {
  private readonly logger = new Logger(CollectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  // ============================================================
  // NATS — Handle report.assigned event
  // Creates the assignment record when admin assigns a collector
  // ============================================================
  async handleReportAssigned(payload: {
    reportId: string;
    collectorAuthId: string;
    assignedByAuthId: string;
    actorRole?: string;
    lgaId: string;
    latitude: number;
    longitude: number;
    address?: string;
    timestamp: string;
  }): Promise<void> {
    // ── Idempotency — skip if assignment already exists
    const existing = await this.prisma.collectorAssignment.findUnique({
      where: {
        collectorAuthId_reportId: {
          collectorAuthId: payload.collectorAuthId,
          reportId: payload.reportId,
        },
      },
    });

    if (existing) {
      this.logger.warn(
        `Assignment already exists for collector ${payload.collectorAuthId} ` +
          `on report ${payload.reportId} — skipping`,
      );
      return;
    }

    // ── Check collector has no other active assignment
    const activeAssignment = await this.prisma.collectorAssignment.findFirst({
      where: {
        collectorAuthId: payload.collectorAuthId,
        status: { in: ['ON_ROUTE', 'COLLECTING'] },
      },
    });

    if (activeAssignment) {
      this.logger.warn(
        `Collector ${payload.collectorAuthId} is busy — rejecting assignment for report ${payload.reportId}`,
      );

      // ── Notify report-service so admin can reassign (TODO: report-service must listen for this)
      this.natsClient.emit('collector.assignment_rejected', {
        reportId: payload.reportId,
        collectorAuthId: payload.collectorAuthId,
        assignedByAuthId: payload.assignedByAuthId,
        reason: 'Collector already has an active assignment',
        activeAssignmentId: activeAssignment.id,
        timestamp: new Date().toISOString(),
      });

      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // ── Create assignment
      const assignment = await tx.collectorAssignment.create({
        data: {
          collectorAuthId: payload.collectorAuthId,
          reportId: payload.reportId,
          lgaId: payload.lgaId as PrismaLagosLGA,
          assignedByAuthId: payload.assignedByAuthId,
          status: 'PENDING',
          reportLatitude: payload.latitude,
          reportLongitude: payload.longitude,
          reportAddress: payload.address,
          metadata: { source: 'report.assigned', timestamp: payload.timestamp },
        },
      });

      // ── Get or create collector stats
      await tx.collectorStats.upsert({
        where: { collectorAuthId: payload.collectorAuthId },
        create: {
          collectorAuthId: payload.collectorAuthId,
          lgaId: payload.lgaId as any,
          totalAssignments: 1,
          isAvailable: false,
        },
        update: {
          totalAssignments: { increment: 1 },
          isAvailable: false,
        },
      });

      // ── Audit log
      await tx.collectorAuditLog.create({
        data: {
          actorId: payload.assignedByAuthId,
          actorRole: payload.actorRole ?? 'AGENCY_ADMIN',
          action: 'ASSIGNMENT_CREATED',
          targetId: assignment.id,
          targetType: 'ASSIGNMENT',
          metadata: payload as any,
        },
      });

      return assignment;
    });

    this.logger.log(
      `Assignment created: collector ${payload.collectorAuthId} → report ${payload.reportId}`,
    );
  }

  // ============================================================
  // UPDATE ASSIGNMENT STATUS
  // Called by collector via HTTP — ON_ROUTE, COLLECTING, COMPLETED
  // ============================================================
  async updateAssignmentStatus(
    user: JwtPayload,
    assignmentId: string,
    dto: UpdateAssignmentStatusDto,
    ip?: string,
    userAgent?: string,
  ) {
    const assignment = await this.prisma.collectorAssignment.findUnique({
      where: { id: assignmentId },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');

    // ── Only the assigned collector can update status
    if (user.role === UserRole.COLLECTOR && assignment.collectorAuthId !== user.sub) {
      throw new ForbiddenException('You are not assigned to this job');
    }

    // ── Validate status transition
    this.validateStatusTransition(assignment.status as any, dto.status);

    const now = new Date();
    const updateData: any = { status: dto.status };

    if (dto.status === 'ON_ROUTE') updateData.startedAt = now;
    if (dto.status === 'COLLECTING') updateData.arrivedAt = now;
    if (dto.status === 'COMPLETED') {
      updateData.completedAt = now;
      updateData.completionNote = dto.note;
    }
    if (dto.status === 'CANCELLED') {
      updateData.cancelledAt = now;
      updateData.cancellationReason = dto.note;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedAssignment = await tx.collectorAssignment.update({
        where: { id: assignmentId },
        data: updateData,
      });

      // ── Update collector availability
      const isActive = ['ON_ROUTE', 'COLLECTING'].includes(dto.status);
      await tx.collectorStats.update({
        where: { collectorAuthId: assignment.collectorAuthId },
        data: {
          isAvailable: !isActive,
          isOnline: dto.status !== 'CANCELLED' && dto.status !== 'COMPLETED',
        },
      });

      // ── Audit log
      await tx.collectorAuditLog.create({
        data: {
          actorId: user.sub,
          actorRole: user.role,
          action: `STATUS_CHANGED_TO_${dto.status}`,
          targetId: assignmentId,
          targetType: 'ASSIGNMENT',
          ipAddress: ip,
          userAgent,
          metadata: { from: assignment.status, to: dto.status, note: dto.note },
        },
      });

      return updatedAssignment;
    });

    // ── Fire NATS events OUTSIDE transaction (Rule 9)
    if (dto.status === 'COMPLETED') {
      // ── Update stats first
      await this.updateStatsOnCompletion(assignment);

      // ── Fire collector.job_completed → triggers report.completed chain
      this.natsClient.emit('collector.job_completed', {
        assignmentId,
        reportId: assignment.reportId,
        collectorAuthId: assignment.collectorAuthId,
        completedAt: now.toISOString(),
        note: dto.note,
        timestamp: now.toISOString(),
      });
    }

    return updated;
  }

  // ============================================================
  // PING LOCATION — GPS update every 30 seconds
  // Only accepted during ON_ROUTE or COLLECTING status
  // ============================================================
  async pingLocation(user: JwtPayload, dto: UpdateLocationDto) {
    // ── Find active assignment
    const assignment = await this.prisma.collectorAssignment.findFirst({
      where: {
        collectorAuthId: user.sub,
        status: { in: ['ON_ROUTE', 'COLLECTING'] },
      },
    });

    if (!assignment) {
      throw new BadRequestException(
        'No active assignment found. Location tracking only active during assignments.',
      );
    }

    // ── Rate limit — max 1 ping per 20 seconds (prevent abuse)
    const rateLimitKey = `gps_ping:${user.sub}`;
    const results = await this.redis.pipeline()
      .incr(rateLimitKey)
      .expire(rateLimitKey, 20)
      .exec();

    const pingCount = results?.[0]?.[1] as number;
    if (pingCount > 1) {
      throw new BadRequestException(
        'GPS ping rate limit exceeded. Minimum interval is 20 seconds.',
      );
    }

    // ── 90-day expiry for NDPA compliance
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90);

    // ── Append-only insert — never update existing pings
    await this.prisma.collectorLocation.create({
      data: {
        assignmentId: assignment.id,
        collectorAuthId: user.sub,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters: dto.accuracyMeters,
        speedKmh: dto.speedKmh,
        headingDegrees: dto.headingDegrees,
        expiresAt,
      },
    });

    // ── Update last known position in stats
    await this.prisma.collectorStats.update({
      where: { collectorAuthId: user.sub },
      data: {
        lastPingAt: new Date(),
        lastKnownLat: dto.latitude,
        lastKnownLng: dto.longitude,
        isOnline: true,
      },
    });

    // ── Calculate ETA to report location
    const eta = this.calculateEta(
      dto.latitude,
      dto.longitude,
      assignment.reportLatitude,
      assignment.reportLongitude,
    );

    // ── Cache latest location in Redis for fast reads by admins/citizens
    const locationCacheKey = `collector_location:${user.sub}`;
    await this.redis.set(
      locationCacheKey,
      JSON.stringify({
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters: dto.accuracyMeters,
        speedKmh: dto.speedKmh,
        assignmentId: assignment.id,
        reportId: assignment.reportId,
        etaMinutes: eta,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      120, // Expire after 2 minutes — stale if collector goes offline
    );

    // ── Fire NATS event — feed-service updates ETA on nearby posts
    // Rule 9: emit OUTSIDE any transaction — this is already outside
    this.natsClient.emit('collector.location_updated', {
      collectorAuthId: user.sub,
      assignmentId: assignment.id,
      reportId: assignment.reportId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      etaMinutes: eta,
      timestamp: new Date().toISOString(),
    });

    return {
      received: true,
      assignmentId: assignment.id,
      etaMinutes: eta,
    };
  }

  // ============================================================
  // GET ACTIVE ASSIGNMENT — Collector's current job
  // ============================================================
  async getMyActiveAssignment(user: JwtPayload) {
    const assignment = await this.prisma.collectorAssignment.findFirst({
      where: {
        collectorAuthId: user.sub,
        status: { in: ['PENDING', 'ON_ROUTE', 'COLLECTING'] },
      },
      orderBy: { assignedAt: 'desc' },
    });

    if (!assignment) {
      return { hasActiveAssignment: false, assignment: null };
    }

    // ── Fetch cached ETA from Redis
    const locationCacheKey = `collector_location:${user.sub}`;
    const cachedLocation = await this.redis.get(locationCacheKey);
    const location = cachedLocation ? JSON.parse(cachedLocation) : null;

    return {
      hasActiveAssignment: true,
      assignment,
      currentLocation: location,
    };
  }

  // ============================================================
  // GET MY ASSIGNMENTS — History
  // ============================================================
  async getMyAssignments(user: JwtPayload, page: number = 1, limit: number = 20, status?: string) {
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const where: any = { collectorAuthId: user.sub };
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.collectorAssignment.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { assignedAt: 'desc' },
        select: {
          id: true,
          reportId: true,
          lgaId: true,
          status: true,
          assignedAt: true,
          startedAt: true,
          arrivedAt: true,
          completedAt: true,
          reportAddress: true,
        },
      }),
      this.prisma.collectorAssignment.count({ where }),
    ]);

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ============================================================
  // GET LIVE COLLECTOR MAP — Admin only
  // Returns all active collectors in an LGA with cached positions
  // ============================================================
  async getLiveCollectorMap(user: JwtPayload, lgaId: LagosLGA) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // ── AGENCY_ADMIN can only see their own LGA
    if (user.role === UserRole.AGENCY_ADMIN && user.lgaId !== lgaId) {
      throw new ForbiddenException('You can only view collectors in your LGA');
    }

    // ── Get all active assignments in this LGA
    const activeAssignments = await this.prisma.collectorAssignment.findMany({
      where: {
        lgaId,
        status: { in: ['ON_ROUTE', 'COLLECTING'] },
      },
      select: {
        id: true,
        collectorAuthId: true,
        reportId: true,
        status: true,
        reportLatitude: true,
        reportLongitude: true,
        reportAddress: true,
        startedAt: true,
      },
    });

    // ── Single MGET for all collector locations
    const cacheKeys = activeAssignments.map(
      (a) => `collector_location:${a.collectorAuthId}`
    );

    const cachedValues = cacheKeys.length > 0
      ? await this.redis.mget(...cacheKeys)
      : [];

    const collectorsWithLocation = activeAssignments.map((assignment, index) => {
      const raw = cachedValues[index];
      const location = raw ? JSON.parse(raw) : null;
      return {
        ...assignment,
        currentLocation: location,
        isLocationStale: !location,
      };
    });

    return {
      lgaId,
      activeCount: activeAssignments.length,
      collectors: collectorsWithLocation,
    };
  }

  // ============================================================
  // GET COLLECTOR STATS
  // ============================================================
  async getCollectorStats(user: JwtPayload, collectorAuthId?: string) {
    // ── Collector can only see their own stats
    // ── Admin can see any collector's stats
    const targetId =
      collectorAuthId && (user.role === UserRole.SYS_ADMIN || user.role === UserRole.AGENCY_ADMIN)
        ? collectorAuthId
        : user.sub;

    const stats = await this.prisma.collectorStats.findUnique({
      where: { collectorAuthId: targetId },
    });

    if (!stats) {
      return {
        collectorAuthId: targetId,
        totalAssignments: 0,
        totalCompleted: 0,
        completionRate: 0,
        averageRating: 0,
        isOnline: false,
        isAvailable: true,
      };
    }

    // ── AGENCY_ADMIN can only view stats for collectors in their LGA
    if (
      stats &&
      user.role === UserRole.AGENCY_ADMIN &&
      stats.lgaId !== user.lgaId
    ) {
      throw new ForbiddenException(
        'You can only view stats for collectors in your LGA'
      );
    }

    return stats;
  }

  // ============================================================
  // RATE COLLECTOR — Citizen rates after completion
  // ============================================================
  async rateCollector(user: JwtPayload, assignmentId: string, dto: RateCollectorDto) {
    const assignment = await this.prisma.collectorAssignment.findUnique({
      where: { id: assignmentId },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');

    // ── Only completed assignments can be rated
    if (assignment.status !== 'COMPLETED') {
      throw new BadRequestException('Can only rate completed assignments');
    }

    // ── FIX BUG 1: Verify the citizen is the original reporter
    const reporterAuthId = await this.getReporterAuthId(assignment.reportId);

    if (reporterAuthId && reporterAuthId !== user.sub) {
      throw new ForbiddenException(
        'Only the citizen who submitted this report can rate the collector'
      );
    }

    // ── FIX BUG 2: Check DB for existing rating (not just Redis)
    if (assignment.ratedByAuthId) {
      throw new BadRequestException('This assignment has already been rated');
    }

    // ── Additional Redis check for fast rejection (belt-and-suspenders)
    const ratingKey = `rating:${user.sub}:${assignmentId}`;
    const alreadyRated = await this.redis.get(ratingKey);
    if (alreadyRated) {
      throw new BadRequestException('You have already rated this assignment');
    }

    // ── Update stats and store rating atomically
    const stats = await this.prisma.collectorStats.findUnique({
      where: { collectorAuthId: assignment.collectorAuthId },
    });

    await this.prisma.$transaction(async (tx) => {
      // ── Store rating on the assignment (permanent source of truth)
      await tx.collectorAssignment.update({
        where: { id: assignmentId },
        data: {
          citizenRating: dto.rating,
          citizenComment: dto.comment ?? null,
          ratedByAuthId: user.sub,
          ratedAt: new Date(),
        },
      });

      // ── Update collector stats
      if (stats) {
        const newTotal = stats.totalRatings + 1;
        const newAvg = (stats.averageRating * stats.totalRatings + dto.rating) / newTotal;

        await tx.collectorStats.update({
          where: { collectorAuthId: assignment.collectorAuthId },
          data: {
            averageRating: Math.round(newAvg * 100) / 100,
            totalRatings: newTotal,
          },
        });
      }

      // ── Audit log
      await tx.collectorAuditLog.create({
        data: {
          actorId: user.sub,
          actorRole: user.role,
          action: 'COLLECTOR_RATED',
          targetId: assignmentId,
          targetType: 'ASSIGNMENT',
          metadata: { rating: dto.rating, comment: dto.comment },
        },
      });
    });

    // ── Set Redis cache for fast duplicate prevention (belt-and-suspenders)
    await this.redis.set(ratingKey, dto.rating.toString(), 'EX', 30 * 24 * 60 * 60);

    return { message: 'Rating submitted successfully' };
  }

  // ============================================================
  // CLEANUP EXPIRED LOCATION PINGS — NDPA Compliance
  // Called by scheduled cron job
  // ============================================================
  async cleanupExpiredLocationPings(): Promise<void> {
    const deleted = await this.prisma.collectorLocation.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    if (deleted.count > 0) {
      this.logger.log(`NDPA cleanup: deleted ${deleted.count} expired GPS location pings`);
    }
  }

  // ============================================================
  // GET AVAILABLE COLLECTORS — Called by report-service via NATS
  // ============================================================
  async getAvailableCollectors(data: {
    lgaId: string;
    latitude: number;
    longitude: number;
  }): Promise<{
    collectors: Array<{
      authId: string;
      lastKnownLat: number | null;
      lastKnownLng: number | null;
      lastPingAt: Date | null;
      activeAssignments: number;
      averageRating: number;
      completionRate: number;
      isOnline: boolean;
      isAvailable: boolean;
      lgaId: string | null;
    }>;
  }> {
    // ── Get available collectors in this LGA first
    let collectors = await this.prisma.collectorStats.findMany({
      where: {
        lgaId: data.lgaId as PrismaLagosLGA,
        isAvailable: true,
        isOnline: true,
      },
    });

    // ── If fewer than 2 in LGA, expand to all available collectors
    if (collectors.length < 2) {
      this.logger.warn(
        `Fewer than 2 available collectors in LGA ${data.lgaId} — expanding search`
      );
      collectors = await this.prisma.collectorStats.findMany({
        where: {
          isAvailable: true,
          isOnline: true,
        },
        take: 10, // Limit expansion
      });
    }

    // ── Count active assignments per collector for workload balancing
    // (Normally isAvailable=false when on assignment, but check as extra safety)
    const activeAssignmentCounts = await Promise.all(
      collectors.map(async (c) => {
        const count = await this.prisma.collectorAssignment.count({
          where: {
            collectorAuthId: c.collectorAuthId,
            status: { in: ['PENDING', 'ON_ROUTE', 'COLLECTING'] },
          },
        });
        return { authId: c.collectorAuthId, count };
      })
    );

    const countMap = new Map(activeAssignmentCounts.map(a => [a.authId, a.count]));

    return {
      collectors: collectors.map((c) => ({
        authId: c.collectorAuthId,
        lastKnownLat: c.lastKnownLat,
        lastKnownLng: c.lastKnownLng,
        lastPingAt: c.lastPingAt,
        activeAssignments: countMap.get(c.collectorAuthId) ?? 0,
        averageRating: c.averageRating,
        completionRate: c.completionRate,
        isOnline: c.isOnline,
        isAvailable: c.isAvailable,
        lgaId: c.lgaId,
      })),
    };
  }

  // ============================================================
  // AUTO-CLOSE ASSIGNMENT — Triggered by report.completed event
  // ============================================================
  async autoCloseAssignment(reportId: string, collectorAuthId: string): Promise<void> {
    const assignment = await this.prisma.collectorAssignment.findFirst({
      where: {
        reportId,
        collectorAuthId,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
    });

    if (!assignment) {
      this.logger.warn(
        `No open assignment for report ${reportId} — already closed or not found`
      );
      return;
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // ── Close the assignment
      await tx.collectorAssignment.update({
        where: { id: assignment.id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          completionNote: 'Auto-closed via report.completed event',
          metadata: {
            ...(assignment.metadata as object),
            autoClosedAt: now.toISOString(),
            closedBy: 'system',
          },
        },
      });

      // ── Mark collector as available again
      await tx.collectorStats.update({
        where: { collectorAuthId: assignment.collectorAuthId },
        data: {
          isAvailable: true,
          isOnline: true,
        },
      });

      // ── Audit log
      await tx.collectorAuditLog.create({
        data: {
          actorId: 'system',
          actorRole: 'SYSTEM',
          action: 'ASSIGNMENT_AUTO_CLOSED',
          targetId: assignment.id,
          targetType: 'ASSIGNMENT',
          metadata: {
            reportId,
            collectorAuthId,
            reason: 'report.completed event received',
          },
        },
      });
    });

    // ── Update completion stats BEFORE emitting anything
    await this.updateStatsOnCompletion(assignment);

    this.logger.log(
      `Assignment ${assignment.id} auto-closed for report ${reportId}`
    );
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async getReporterAuthId(reportId: string): Promise<string | null> {
    try {
      const result = await firstValueFrom(
        this.natsClient.send('report.get_reporter', { reportId }).pipe(
          timeout(5000),
        )
      );
      return result?.reporterAuthId ?? null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch reporter for report ${reportId}: ${(error as Error).message}`
      );
      return null; // Note: report-service must implement @MessagePattern('report.get_reporter')
    }
  }

  private calculateEta(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
    // ── Haversine distance formula
    const R = 6371; // Earth radius in km
    const dLat = this.toRad(toLat - fromLat);
    const dLng = this.toRad(toLng - fromLng);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(fromLat)) *
        Math.cos(this.toRad(toLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = R * c;

    const speedKmh = this.configService.get<number>('collector.eta.averageSpeedKmh') ?? 40;
    const etaHours = distanceKm / speedKmh;
    const etaMins = Math.ceil(etaHours * 60);

    return etaMins;
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  private validateStatusTransition(current: string, next: string): void {
    const validTransitions: Record<string, string[]> = {
      PENDING: ['ON_ROUTE', 'CANCELLED'],
      ON_ROUTE: ['COLLECTING', 'CANCELLED'],
      COLLECTING: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
    };

    if (!validTransitions[current]?.includes(next)) {
      throw new BadRequestException(`Invalid status transition: ${current} → ${next}`);
    }
  }

  private async updateStatsOnCompletion(assignment: any): Promise<void> {
    try {
      const locationCount = await this.prisma.collectorLocation.count({
        where: { assignmentId: assignment.id },
      });

      // ── Rough distance: number of pings × 30s × average speed
      const speedKmh = this.configService.get<number>('collector.eta.averageSpeedKmh') ?? 40;
      const distanceKm = ((locationCount * 30) / 3600) * speedKmh;

      const startTime = assignment.startedAt ?? assignment.assignedAt;
      const completedAt = new Date();
      const durationMins = (completedAt.getTime() - startTime.getTime()) / 60000;

      const stats = await this.prisma.collectorStats.findUnique({
        where: { collectorAuthId: assignment.collectorAuthId },
      });

      if (!stats) return;

      const newCompleted = stats.totalCompleted + 1;
      const newAvgDuration =
        (stats.averageCompletionMinutes * stats.totalCompleted + durationMins) / newCompleted;

      const totalAssignments = stats.totalAssignments;
      const completionRate = newCompleted / totalAssignments;

      await this.prisma.collectorStats.update({
        where: { collectorAuthId: assignment.collectorAuthId },
        data: {
          totalCompleted: newCompleted,
          totalDistanceKm: { increment: distanceKm },
          averageCompletionMinutes: Math.round(newAvgDuration * 100) / 100,
          completionRate: Math.round(completionRate * 100) / 100,
          isAvailable: true,
          isOnline: true,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to update stats for collector ${assignment.collectorAuthId}: ` +
          `${(error as Error).message}`,
      );
    }
  }
}
