import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JwtPayload } from '@app/shared';
import { LagosLGA, UserRole } from '@app/shared';
import * as crypto from 'crypto';
import type Redis from 'ioredis';

import { PrismaService } from './prisma/prisma.service';

// ── NATS event payload shapes
export interface ReportEventPayload {
  reportId: string;
  reporterAuthId?: string;
  collectorAuthId?: string;
  lgaId?: string;
  wasteType?: string;
  severity?: string;
  latitude?: number;
  longitude?: number;
  pointsAwarded?: number;
  timestamp: string;
}

export interface UserRegisteredPayload {
  authId: string;
  role: string;
  timestamp: string;
}

export interface PaymentEventPayload {
  authId: string;
  amountKobo?: number;
  timestamp: string;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  private readonly dashboardTtl: number;
  private readonly heatmapTtl: number;
  private readonly leaderboardTtl: number;
  private readonly rawEventDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {
    this.dashboardTtl = this.configService.get<number>('analytics.cache.dashboardTtlSeconds')!;
    this.heatmapTtl = this.configService.get<number>('analytics.cache.heatmapTtlSeconds')!;
    this.leaderboardTtl = this.configService.get<number>('analytics.cache.leaderboardTtlSeconds')!;
    this.rawEventDays = this.configService.get<number>('analytics.retention.rawEventDays')!;
  }

  // ============================================================
  // LGA DASHBOARD — Admin view for a specific LGA
  // ============================================================
  async getLgaDashboard(user: JwtPayload, lgaId: LagosLGA, days: number = 30) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // ── Resolve effective lgaId
    // AGENCY_ADMIN always uses their own LGA — ignore any provided lgaId
    // SYS_ADMIN uses the provided lgaId (required for SYS_ADMIN)
    let effectiveLgaId: LagosLGA;

    if (user.role === UserRole.AGENCY_ADMIN) {
      if (!user.lgaId) {
        throw new ForbiddenException(
          'Your account has no LGA assigned. Contact SYS_ADMIN to set your LGA.'
        );
      }
      effectiveLgaId = user.lgaId as LagosLGA;
    } else {
      // SYS_ADMIN
      if (!lgaId) {
        throw new BadRequestException('lgaId is required for platform-wide admins');
      }
      effectiveLgaId = lgaId;
    }

    const safeDays = Math.min(Math.max(days, 1), 365);
    const cacheKey = `dashboard:lga:${effectiveLgaId}:${safeDays}d`;

    // ── Try cache
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { ...JSON.parse(cached), fromCache: true };
    }

    const since = new Date();
    since.setDate(since.getDate() - safeDays);

    // ── Fetch aggregated data
    const [aggregates, currentPending] = await Promise.all([
      this.prisma.lgaDailyAggregate.findMany({
        where: { lgaId: effectiveLgaId, date: { gte: since } },
        orderBy: { date: 'asc' },
      }),
      // ── Live count of pending reports (raw events — last 24h)
      this.prisma.analyticsEvent.count({
        where: {
          lgaId: effectiveLgaId,
          eventType: 'REPORT_CREATED',
          createdAt: { gte: since },
        },
      }),
    ]);

    // ── Compute totals from aggregates
    const totals = aggregates.reduce(
      (acc, row) => ({
        reportsCreated: acc.reportsCreated + row.reportsCreated,
        reportsCompleted: acc.reportsCompleted + row.reportsCompleted,
        reportsRejected: acc.reportsRejected + row.reportsRejected,
        totalPointsAwarded: acc.totalPointsAwarded + row.totalPointsAwarded,
        newUsers: acc.newUsers + row.newUsers,
        hazardousCount: acc.hazardousCount + row.hazardousCount,
        criticalCount: acc.criticalCount + row.criticalCount,
      }),
      {
        reportsCreated: 0,
        reportsCompleted: 0,
        reportsRejected: 0,
        totalPointsAwarded: 0,
        newUsers: 0,
        hazardousCount: 0,
        criticalCount: 0,
      },
    );

    const avgCompletionRate = aggregates.length
      ? aggregates.reduce((sum, r) => sum + r.completionRate, 0) / aggregates.length
      : 0;

    const avgResolutionHours = aggregates.length
      ? aggregates.reduce((sum, r) => sum + r.avgResolutionHours, 0) / aggregates.length
      : 0;

    // ── Trend data — daily series for charts
    const trend = aggregates.map((row) => ({
      date: row.date,
      reportsCreated: row.reportsCreated,
      reportsCompleted: row.reportsCompleted,
      completionRate: row.completionRate,
      hazardousCount: row.hazardousCount,
    }));

    const result = {
      lgaId: effectiveLgaId,
      period: `${safeDays} days`,
      totals,
      avgCompletionRate: Math.round(avgCompletionRate * 100) / 100,
      avgResolutionHours: Math.round(avgResolutionHours * 10) / 10,
      currentPending,
      trend,
      generatedAt: new Date().toISOString(),
    };

    // ── Cache result
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.dashboardTtl);

    return { ...result, fromCache: false };
  }

  // ============================================================
  // PLATFORM DASHBOARD — SYS_ADMIN only — Lagos-wide view
  // ============================================================
  async getPlatformDashboard(user: JwtPayload, days: number = 30) {
    if (user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only SYS_ADMIN can view platform dashboard');
    }

    const safeDays = Math.min(Math.max(days, 1), 365);
    const cacheKey = `dashboard:platform:${safeDays}d`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { ...JSON.parse(cached), fromCache: true };
    }

    const since = new Date();
    since.setDate(since.getDate() - safeDays);

    const aggregates = await this.prisma.platformDailyAggregate.findMany({
      where: { date: { gte: since } },
      orderBy: { date: 'asc' },
    });

    const totals = aggregates.reduce(
      (acc, row) => ({
        totalReports: acc.totalReports + row.totalReports,
        totalCompleted: acc.totalCompleted + row.totalCompleted,
        newUsers: acc.newUsers + row.newUsersToday,
        totalPointsAwarded: acc.totalPointsAwarded + row.totalPointsAwarded,
        totalWithdrawalsNgn: acc.totalWithdrawalsNgn + row.totalWithdrawalsNgn,
      }),
      {
        totalReports: 0,
        totalCompleted: 0,
        newUsers: 0,
        totalPointsAwarded: 0,
        totalWithdrawalsNgn: 0,
      },
    );

    const avgCompletionRate = aggregates.length
      ? aggregates.reduce((sum, r) => sum + r.platformCompletionRate, 0) / aggregates.length
      : 0;

    // ── LGA breakdown for this period
    const lgaBreakdown = await this.prisma.lgaDailyAggregate.groupBy({
      by: ['lgaId'],
      where: { date: { gte: since } },
      _sum: {
        reportsCreated: true,
        reportsCompleted: true,
        hazardousCount: true,
      },
      _avg: {
        completionRate: true,
        avgResolutionHours: true,
      },
      orderBy: { _sum: { reportsCreated: 'desc' } },
    });

    const trend = aggregates.map((row) => ({
      date: row.date,
      totalReports: row.totalReports,
      totalCompleted: row.totalCompleted,
      newUsers: row.newUsersToday,
      completionRate: row.platformCompletionRate,
    }));

    const result = {
      period: `${safeDays} days`,
      totals,
      avgCompletionRate: Math.round(avgCompletionRate * 100) / 100,
      lgaBreakdown: lgaBreakdown.map((lga) => ({
        lgaId: lga.lgaId,
        reportsCreated: lga._sum.reportsCreated ?? 0,
        reportsCompleted: lga._sum.reportsCompleted ?? 0,
        hazardousCount: lga._sum.hazardousCount ?? 0,
        completionRate: Math.round((lga._avg.completionRate ?? 0) * 100) / 100,
        avgResolutionHours: Math.round((lga._avg.avgResolutionHours ?? 0) * 10) / 10,
      })),
      trend,
      generatedAt: new Date().toISOString(),
    };

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.dashboardTtl);

    return { ...result, fromCache: false };
  }

  // ============================================================
  // HEATMAP — Waste density grid for map visualization
  // ============================================================
  async getHeatmap(user: JwtPayload, lgaId?: LagosLGA) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (user.role === UserRole.AGENCY_ADMIN && lgaId && user.lgaId !== lgaId) {
      throw new ForbiddenException('You can only view your own LGA heatmap');
    }

    const cacheKey = `heatmap:${lgaId ?? 'all'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { points: JSON.parse(cached), fromCache: true };
    }

    const where: any = {};
    if (lgaId) where.lgaId = lgaId;
    else if (user.role === UserRole.AGENCY_ADMIN) {
      where.lgaId = user.lgaId;
    }

    const points = await this.prisma.heatmapPoint.findMany({
      where,
      orderBy: { reportCount: 'desc' },
      take: 500, // Cap at 500 points for performance
      select: {
        latGrid: true,
        lngGrid: true,
        lgaId: true,
        reportCount: true,
        activeCount: true,
        resolvedCount: true,
        severity: true,
      },
    });

    await this.redis.set(cacheKey, JSON.stringify(points), 'EX', this.heatmapTtl);

    return { points, fromCache: false };
  }

  // ============================================================
  // LGA LEADERBOARD — Weekly rankings
  // ============================================================
  async getLgaLeaderboard(user: JwtPayload) {
    const cacheKey = 'leaderboard:lga:weekly';
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { rankings: JSON.parse(cached), fromCache: true };
    }

    // ── Get most recent week
    const latest = await this.prisma.lgaLeaderboard.findFirst({
      orderBy: { weekStart: 'desc' },
      select: { weekStart: true },
    });

    if (!latest) {
      return { rankings: [], fromCache: false };
    }

    const rankings = await this.prisma.lgaLeaderboard.findMany({
      where: { weekStart: latest.weekStart },
      orderBy: { rank: 'asc' },
    });

    await this.redis.set(cacheKey, JSON.stringify(rankings), 'EX', this.leaderboardTtl);

    return { rankings, fromCache: false };
  }

  // ============================================================
  // WASTE TYPE BREAKDOWN — For charts
  // ============================================================
  async getWasteTypeBreakdown(user: JwtPayload, lgaId?: LagosLGA, days: number = 30) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const safeDays = Math.min(Math.max(days, 1), 365);
    const since = new Date();
    since.setDate(since.getDate() - safeDays);

    let targetLga: LagosLGA | undefined;

    if (user.role === UserRole.AGENCY_ADMIN) {
      if (!user.lgaId) {
        throw new ForbiddenException(
          'Your account has no LGA assigned. Contact SYS_ADMIN to set your LGA.'
        );
      }
      targetLga = user.lgaId as LagosLGA;
    } else {
      targetLga = lgaId; // SYS_ADMIN can leave this undefined for platform-wide view
    }

    const cacheKey = `breakdown:wastetype:${targetLga ?? 'all'}:${safeDays}d`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { data: JSON.parse(cached), fromCache: true };

    const where: any = { date: { gte: since } };
    if (targetLga) where.lgaId = targetLga;

    const rows = await this.prisma.lgaDailyAggregate.aggregate({
      where,
      _sum: {
        generalCount: true,
        recyclableCount: true,
        organicCount: true,
        electronicCount: true,
        hazardousCount: true,
        constructionCount: true,
      },
    });

    const data = [
      { wasteType: 'GENERAL', count: rows._sum.generalCount ?? 0 },
      { wasteType: 'RECYCLABLE', count: rows._sum.recyclableCount ?? 0 },
      { wasteType: 'ORGANIC', count: rows._sum.organicCount ?? 0 },
      { wasteType: 'ELECTRONIC', count: rows._sum.electronicCount ?? 0 },
      { wasteType: 'HAZARDOUS', count: rows._sum.hazardousCount ?? 0 },
      { wasteType: 'CONSTRUCTION', count: rows._sum.constructionCount ?? 0 },
    ].sort((a, b) => b.count - a.count);

    await this.redis.set(cacheKey, JSON.stringify(data), 'EX', this.dashboardTtl);

    return { data, fromCache: false };
  }

  // ============================================================
  // NATS — Ingest raw events from all services
  // ============================================================
  async ingestEvent(
    eventType: string,
    payload: ReportEventPayload | UserRegisteredPayload | PaymentEventPayload,
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.rawEventDays);

    // ── Build sanitized metadata — no PII
    const sanitizedMetadata = {
      eventType,
      lgaId: (payload as any).lgaId ?? null,
      wasteType: (payload as any).wasteType ?? null,
      severity: (payload as any).severity ?? null,
      timestamp: (payload as any).timestamp ?? null,
      // Numeric aggregation fields only — no text, no user identifiers
      pointsAwarded: (payload as any).pointsAwarded ?? null,
      amountKobo: (payload as any).amountKobo ?? null,
    };

    try {
      await this.prisma.analyticsEvent.create({
        data: {
          eventType: eventType as any,
          lgaId: (payload as any).lgaId ?? null,
          wasteType: (payload as any).wasteType ?? null,
          severity: (payload as any).severity ?? null,
          reportId: (payload as any).reportId ?? null,
          collectorAuthId: (payload as any).collectorAuthId ?? null,
          citizenAuthId: (payload as any).reporterAuthId ?? (payload as any).authId ?? null,
          pointsAmount: (payload as any).pointsAwarded ?? null,
          amountKobo: (payload as any).amountKobo ?? null,
          latitude: (payload as any).latitude ?? null,
          longitude: (payload as any).longitude ?? null,
          metadata: sanitizedMetadata,
          expiresAt,
        },
      });

      // ── Update heatmap point if location provided
      if ((payload as any).latitude && (payload as any).longitude) {
        await this.updateHeatmapPoint(
          (payload as any).latitude,
          (payload as any).longitude,
          (payload as any).lgaId,
          eventType,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to ingest analytics event ${eventType}: ${(error as Error).message}`,
      );
      // ── Don't rethrow analytics failures — never block business operations
    }
  }

  // ============================================================
  // RECALCULATE DAILY AGGREGATES — Called by cron at midnight
  // ============================================================
  async recalculateDailyAggregates(): Promise<void> {
    // ── Calculate yesterday's boundaries in Lagos time (WAT = UTC+1)
    const lagosOffsetMs = 60 * 60 * 1000; // UTC+1

    const nowUtc = new Date();

    // Yesterday in Lagos time
    const lagosNow = new Date(nowUtc.getTime() + lagosOffsetMs);
    const lagosYesterday = new Date(lagosNow);
    lagosYesterday.setUTCDate(lagosYesterday.getUTCDate() - 1);
    lagosYesterday.setUTCHours(0, 0, 0, 0);

    // Convert back to UTC for DB queries
    const from = new Date(lagosYesterday.getTime() - lagosOffsetMs);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

    this.logger.log(
      `Recalculating daily aggregates for Lagos date: ` +
        `${lagosYesterday.toISOString().split('T')[0]} ` +
        `(UTC window: ${from.toISOString()} → ${to.toISOString()})`,
    );

    // ── Process LGAs in parallel — max 5 concurrent to avoid DB overload
    const lgaValues = Object.values(LagosLGA);
    const chunkSize = 5;

    for (let i = 0; i < lgaValues.length; i += chunkSize) {
      const chunk = lgaValues.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map((lgaId) => this.recalculateLgaAggregate(lgaId as LagosLGA, from, to, lagosYesterday)),
      );
      this.logger.log(
        `Processed LGA chunk ${Math.floor(i / chunkSize) + 1}/` +
          `${Math.ceil(lgaValues.length / chunkSize)}`,
      );
    }

    await this.recalculatePlatformAggregate(from, to, lagosYesterday);

    // ── Weekly leaderboard on Lagos Sundays
    const lagosYesterdayLocal = new Date(lagosYesterday.getTime() + lagosOffsetMs);
    if (lagosYesterdayLocal.getUTCDay() === 0) {
      // Sunday in Lagos time
      await this.recalculateWeeklyLeaderboard(lagosYesterday);
    }

    this.logger.log('Daily aggregates recalculated successfully');
  }

  // ============================================================
  // CLEANUP EXPIRED RAW EVENTS — Called by cron
  // ============================================================
  async cleanupExpiredEvents(): Promise<void> {
    const now = new Date();
    let totalDeleted = 0;
    let batchNumber = 0;

    this.logger.log('Starting batched analytics event cleanup...');

    while (true) {
      batchNumber++;

      // ── Fetch a batch of expired event IDs
      const expiredBatch = await this.prisma.analyticsEvent.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        take: 1000, // Process 1000 at a time
      });

      if (expiredBatch.length === 0) break; // No more expired events

      // ── Delete this batch
      const result = await this.prisma.analyticsEvent.deleteMany({
        where: { id: { in: expiredBatch.map((e) => e.id) } },
      });

      totalDeleted += result.count;

      this.logger.log(
        `Cleanup batch ${batchNumber}: deleted ${result.count} events ` +
          `(total so far: ${totalDeleted})`,
      );

      // ── Small delay between batches — prevents table lock saturation
      // and allows other queries to proceed between deletes
      await new Promise((resolve) => setTimeout(resolve, 200));

      // ── Safety valve: stop after 50 batches per run (50,000 events max)
      // Remaining events will be cleaned up in tomorrow's run
      if (batchNumber >= 50) {
        this.logger.warn(
          `Cleanup reached batch limit (50 batches / 50,000 events). ` +
            `Stopping — remaining events will be processed tomorrow.`,
        );
        break;
      }
    }

    if (totalDeleted > 0) {
      this.logger.log(
        `Analytics cleanup complete: ${totalDeleted} expired events removed ` +
          `in ${batchNumber} batches`,
      );
    } else {
      this.logger.log('Analytics cleanup: no expired events found');
    }
  }

  // ============================================================
  // PRIVATE — Heatmap point update
  // ============================================================
  private async updateHeatmapPoint(
    latitude: number,
    longitude: number,
    lgaId: string,
    eventType: string,
  ): Promise<void> {
    // ── Round to 3 decimal places (~100m grid)
    const latGrid = Math.round(latitude * 1000) / 1000;
    const lngGrid = Math.round(longitude * 1000) / 1000;

    const isCreated = eventType === 'REPORT_CREATED';
    const isCompleted = eventType === 'REPORT_COMPLETED';
    // Cancelled and rejected reports are no longer active
    const isTerminal =
      isCompleted || eventType === 'REPORT_CANCELLED' || eventType === 'REPORT_REJECTED';

    try {
      if (isCreated) {
        // New report — use native PostgreSQL raw UPSERT to guarantee 100% atomicity
        // This eliminates Prisma P2002 Race Condition crashes on concurrent identical grids
        const id = crypto.randomUUID();
        await this.prisma.$executeRaw`
          INSERT INTO analytics.heatmap_points ("id", "updatedAt", "latGrid", "lngGrid", "lgaId", "reportCount", "activeCount", "resolvedCount", "severity")
          VALUES (${id}, NOW(), ${latGrid}, ${lngGrid}, ${lgaId}::"LagosLGA", 1, 1, 0, 0)
          ON CONFLICT ("latGrid", "lngGrid") DO UPDATE
          SET 
            "reportCount" = heatmap_points."reportCount" + 1,
            "activeCount" = heatmap_points."activeCount" + 1,
            "updatedAt" = NOW()
        `;
      } else if (isTerminal) {
        // Report resolved/cancelled/rejected — use raw SQL with camelCase to prevent negative values
        await this.prisma.$executeRaw`
          UPDATE analytics.heatmap_points
          SET 
            "reportCount" = "reportCount" + 1,
            "activeCount" = GREATEST(0, "activeCount" - 1),
            "resolvedCount" = "resolvedCount" + ${isCompleted ? 1 : 0},
            "updatedAt" = NOW()
          WHERE "latGrid" = ${latGrid} AND "lngGrid" = ${lngGrid}
        `;
      }
      // Intermediate status events (VERIFIED, ASSIGNED) — 
      // don't change active/resolved counts, just log the event
    } catch (error) {
      this.logger.warn(
        `Heatmap update failed for [${latGrid},${lngGrid}]: ${(error as Error).message}`,
      );
    }
  }

  // ============================================================
  // PRIVATE — LGA daily aggregate recalculation
  // ============================================================
  private async recalculateLgaAggregate(lgaId: LagosLGA, from: Date, to: Date, aggregateDate: Date): Promise<void> {
    // ── Count events by type for this LGA and day
    const [
      reportsCreated,
      reportsVerified,
      reportsCompleted,
      reportsRejected,
      reportsCancelled,
      newUsers,
      pointsResult,
      wasteTypeCounts,
      severityCounts,
      completedEvents,
    ] = await Promise.all([
      this.prisma.analyticsEvent.count({
        where: { lgaId, eventType: 'REPORT_CREATED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { lgaId, eventType: 'REPORT_VERIFIED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { lgaId, eventType: 'REPORT_COMPLETED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { lgaId, eventType: 'REPORT_REJECTED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { lgaId, eventType: 'REPORT_CANCELLED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { lgaId, eventType: 'USER_REGISTERED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.aggregate({
        where: { lgaId, eventType: 'POINTS_AWARDED', createdAt: { gte: from, lt: to } },
        _sum: { pointsAmount: true },
      }),
      // ── Waste type breakdown
      this.prisma.analyticsEvent.groupBy({
        by: ['wasteType'],
        where: {
          lgaId,
          eventType: 'REPORT_CREATED',
          createdAt: { gte: from, lt: to },
          wasteType: { not: null },
        },
        _count: { wasteType: true },
      }),
      // ── Severity breakdown
      this.prisma.analyticsEvent.groupBy({
        by: ['severity'],
        where: {
          lgaId,
          eventType: 'REPORT_CREATED',
          createdAt: { gte: from, lt: to },
          severity: { not: null },
        },
        _count: { severity: true },
      }),
      // ── Fetch completed report IDs and their completion timestamps
      this.prisma.analyticsEvent.findMany({
        where: {
          lgaId,
          eventType: 'REPORT_COMPLETED',
          createdAt: { gte: from, lt: to },
          reportId: { not: null },
        },
        select: { reportId: true, createdAt: true },
      }),
    ]);

    const completionRate = reportsCreated > 0 ? reportsCompleted / reportsCreated : 0;

    // ── Map waste type counts
    const wasteMap: Record<string, number> = {};
    wasteTypeCounts.forEach((w) => {
      wasteMap[w.wasteType ?? ''] = w._count.wasteType;
    });

    const severityMap: Record<string, number> = {};
    severityCounts.forEach((s) => {
      severityMap[s.severity ?? ''] = s._count.severity;
    });

    // ── Calculate average resolution time
    let avgResolutionHours = 0;

    if (completedEvents.length > 0) {
      const reportIds = completedEvents.map((e) => e.reportId!);

      const createdEvents = await this.prisma.analyticsEvent.findMany({
        where: {
          reportId: { in: reportIds },
          eventType: 'REPORT_CREATED',
        },
        select: { reportId: true, createdAt: true },
      });

      const createdMap = new Map(createdEvents.map((e) => [e.reportId!, e.createdAt]));
      const resolutionTimes: number[] = [];

      for (const completed of completedEvents) {
        const createdAt = createdMap.get(completed.reportId!);
        if (createdAt) {
          const hours = (completed.createdAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
          if (hours >= 0) resolutionTimes.push(hours);
        }
      }

      if (resolutionTimes.length > 0) {
        avgResolutionHours =
          resolutionTimes.reduce((sum, h) => sum + h, 0) / resolutionTimes.length;
      }
    }

    avgResolutionHours = Math.round(avgResolutionHours * 10) / 10;

    // ── Upsert aggregate row using the clean calendar date
    await this.prisma.lgaDailyAggregate.upsert({
      where: { date_lgaId: { date: aggregateDate, lgaId } },
      create: {
        date: aggregateDate,
        lgaId,
        reportsCreated,
        reportsVerified,
        reportsCompleted,
        reportsRejected,
        reportsCancelled,
        newUsers,
        totalPointsAwarded: pointsResult._sum.pointsAmount ?? 0,
        completionRate: Math.round(completionRate * 100) / 100,
        avgResolutionHours,
        generalCount: wasteMap['GENERAL'] ?? 0,
        recyclableCount: wasteMap['RECYCLABLE'] ?? 0,
        organicCount: wasteMap['ORGANIC'] ?? 0,
        electronicCount: wasteMap['ELECTRONIC'] ?? 0,
        hazardousCount: wasteMap['HAZARDOUS'] ?? 0,
        constructionCount: wasteMap['CONSTRUCTION'] ?? 0,
        lowCount: severityMap['LOW'] ?? 0,
        mediumCount: severityMap['MEDIUM'] ?? 0,
        highCount: severityMap['HIGH'] ?? 0,
        criticalCount: severityMap['CRITICAL'] ?? 0,
      },
      update: {
        reportsCreated,
        reportsVerified,
        reportsCompleted,
        reportsRejected,
        reportsCancelled,
        newUsers,
        totalPointsAwarded: pointsResult._sum.pointsAmount ?? 0,
        completionRate: Math.round(completionRate * 100) / 100,
        avgResolutionHours,
        generalCount: wasteMap['GENERAL'] ?? 0,
        recyclableCount: wasteMap['RECYCLABLE'] ?? 0,
        organicCount: wasteMap['ORGANIC'] ?? 0,
        electronicCount: wasteMap['ELECTRONIC'] ?? 0,
        hazardousCount: wasteMap['HAZARDOUS'] ?? 0,
        constructionCount: wasteMap['CONSTRUCTION'] ?? 0,
        lowCount: severityMap['LOW'] ?? 0,
        mediumCount: severityMap['MEDIUM'] ?? 0,
        highCount: severityMap['HIGH'] ?? 0,
        criticalCount: severityMap['CRITICAL'] ?? 0,
      },
    });
  }

  // ============================================================
  // PRIVATE — Platform daily aggregate
  // ============================================================
  private async recalculatePlatformAggregate(from: Date, to: Date, aggregateDate: Date): Promise<void> {
    const [totalReports, totalCompleted, newUsers, pointsResult] = await Promise.all([
      this.prisma.analyticsEvent.count({
        where: { eventType: 'REPORT_CREATED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { eventType: 'REPORT_COMPLETED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.count({
        where: { eventType: 'USER_REGISTERED', createdAt: { gte: from, lt: to } },
      }),
      this.prisma.analyticsEvent.aggregate({
        where: { eventType: 'POINTS_AWARDED', createdAt: { gte: from, lt: to } },
        _sum: { pointsAmount: true },
      }),
    ]);

    const completionRate = totalReports > 0 ? totalCompleted / totalReports : 0;

    await this.prisma.platformDailyAggregate.upsert({
      where: { date: aggregateDate },
      create: {
        date: aggregateDate,
        totalReports,
        totalCompleted,
        newUsersToday: newUsers,
        totalPointsAwarded: pointsResult._sum.pointsAmount ?? 0,
        platformCompletionRate: Math.round(completionRate * 100) / 100,
      },
      update: {
        totalReports,
        totalCompleted,
        newUsersToday: newUsers,
        totalPointsAwarded: pointsResult._sum.pointsAmount ?? 0,
        platformCompletionRate: Math.round(completionRate * 100) / 100,
      },
    });
  }

  // ============================================================
  // PRIVATE — Weekly LGA leaderboard
  // ============================================================
  private async recalculateWeeklyLeaderboard(weekEnd: Date): Promise<void> {
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);

    const lgaAggregates = await this.prisma.lgaDailyAggregate.groupBy({
      by: ['lgaId'],
      where: { date: { gte: weekStart, lte: weekEnd } },
      _sum: {
        reportsCreated: true,
        reportsCompleted: true,
      },
      _avg: {
        completionRate: true,
        avgResolutionHours: true,
      },
    });

    // ── Score formula: completionRate × 0.6 + (1/avgResolutionHours) × 0.4
    const scored = lgaAggregates.map((lga) => {
      const completionRate = lga._avg.completionRate ?? 0;
      const avgResolutionHours = lga._avg.avgResolutionHours ?? 24;
      const resolutionScore = avgResolutionHours > 0 ? Math.min(1 / avgResolutionHours, 1) : 0;

      const score = completionRate * 0.6 + resolutionScore * 0.4;

      return {
        lgaId: lga.lgaId,
        score: Math.round(score * 10000) / 10000,
        completionRate: Math.round(completionRate * 100) / 100,
        avgResolutionHours: Math.round(avgResolutionHours * 10) / 10,
        totalReports: lga._sum.reportsCreated ?? 0,
        totalCompleted: lga._sum.reportsCompleted ?? 0,
      };
    });

    // ── Sort by score descending and assign ranks
    scored.sort((a, b) => b.score - a.score);

    await Promise.all(
      scored.map((lga, index) =>
        this.prisma.lgaLeaderboard.upsert({
          where: { weekStart_lgaId: { weekStart, lgaId: lga.lgaId } },
          create: { weekStart, rank: index + 1, ...lga },
          update: { rank: index + 1, ...lga },
        }),
      ),
    );

    this.logger.log(`Weekly leaderboard updated for week starting ${weekStart.toISOString()}`);
  }
}
