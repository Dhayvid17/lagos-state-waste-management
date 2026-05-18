import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import type { JwtPayload } from '@app/shared';
import { LagosLGA, UserRole } from '@app/shared';
import type Redis from 'ioredis';

import { PrismaService } from './prisma/prisma.service';

import { BadgeType } from './generated/prisma/client';

export interface ReportCompletedPayload {
  reportId: string;
  reporterAuthId: string;
  wasteType: string;
  severity: string;
  lgaId: string;
  pointsAwarded: number;
  timestamp: string;
}

export interface UserRegisteredPayload {
  authId: string;
  role: string;
  lgaId?: string;
  timestamp: string;
}

export interface KycVerifiedPayload {
  authId: string;
  timestamp: string;
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  // ── Config values
  private readonly leaderboardTtl: number;
  private readonly badgesTtl: number;
  private readonly dailyStreakBonus: number;
  private readonly maxStreakBonus: number;
  private readonly streakResetHours: number;
  private readonly badgeThresholds: Record<string, number>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {
    this.leaderboardTtl = this.configService.get<number>('rewards.cache.leaderboardTtlSeconds')!;
    this.badgesTtl = this.configService.get<number>('rewards.cache.badgesTtlSeconds')!;
    this.dailyStreakBonus = this.configService.get<number>(
      'rewards.streaks.dailyReportStreakBonusPoints',
    )!;
    this.maxStreakBonus = this.configService.get<number>('rewards.streaks.maxStreakBonusPoints')!;
    this.streakResetHours = this.configService.get<number>('rewards.streaks.streakResetHours')!;
    this.badgeThresholds = this.configService.get('rewards.badges')!;
  }

  // ============================================================
  // GET MY REWARDS PROFILE
  // ============================================================
  async getMyProfile(user: JwtPayload) {
    return this.prisma.citizenRewardsProfile.upsert({
      where: { authId: user.sub },
      update: {}, // Already exists — return current state unchanged
      create: { authId: user.sub, lgaId: (user.lgaId as any) ?? null },
      include: { badges: { orderBy: { awardedAt: 'desc' } } },
    });
  }

  // ============================================================
  // GET MY BADGES
  // ============================================================
  async getMyBadges(user: JwtPayload) {
    const cacheKey = `badges:${user.sub}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { badges: JSON.parse(cached), fromCache: true };

    const profile = await this.prisma.citizenRewardsProfile.findUnique({
      where: { authId: user.sub },
      include: { badges: { orderBy: { awardedAt: 'desc' } } },
    });

    const badges = profile?.badges ?? [];

    await this.redis.set(cacheKey, JSON.stringify(badges), 'EX', this.badgesTtl);

    return { badges, fromCache: false };
  }

  // ============================================================
  // GET STREAK INFO
  // ============================================================
  async getMyStreak(user: JwtPayload) {
    const cacheKey = `streak:${user.sub}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), fromCache: true };

    const profile = await this.prisma.citizenRewardsProfile.findUnique({
      where: { authId: user.sub },
    });

    if (!profile) {
      return {
        currentStreakDays: 0,
        longestStreakDays: 0,
        lastReportDate: null,
        fromCache: false,
      };
    }

    const result = {
      currentStreakDays: profile.currentStreakDays,
      longestStreakDays: profile.longestStreakDays,
      lastReportDate: profile.lastReportDate,
    };

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.badgesTtl);

    return { ...result, fromCache: false };
  }

  // ============================================================
  // GET LGA LEADERBOARD
  // ============================================================
  async getLgaLeaderboard(lgaId: LagosLGA, page: number = 1, limit: number = 20) {
    // ── Validate lgaId is provided and is a valid LagosLGA
    if (!lgaId) {
      throw new BadRequestException(
        'lgaId is required. Use GET /rewards/leaderboard/lga?lgaId=IKEJA'
      );
    }

    const validLgaIds = Object.values(LagosLGA) as string[];
    if (!validLgaIds.includes(lgaId as string)) {
      throw new BadRequestException(
        `Invalid lgaId: '${lgaId}'. Must be one of: ${validLgaIds.join(', ')}`
      );
    }

    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);

    const cacheKey = `leaderboard:lga:${lgaId}:${safePage}:${safeLimit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), fromCache: true };

    // ── Get latest week
    const latest = await this.prisma.lgaLeaderboardSnapshot.findFirst({
      where: { lgaId },
      orderBy: { weekStart: 'desc' },
      select: { weekStart: true },
    });

    if (!latest) return { data: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };

    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.lgaLeaderboardSnapshot.findMany({
        where: { lgaId, weekStart: latest.weekStart },
        orderBy: { rank: 'asc' },
        skip,
        take: safeLimit,
        select: {
          rank: true,
          authId: true,
          totalPoints: true,
          totalReports: true,
          badgeCount: true,
        },
      }),
      this.prisma.lgaLeaderboardSnapshot.count({
        where: { lgaId, weekStart: latest.weekStart },
      }),
    ]);

    const result = {
      lgaId,
      weekStart: latest.weekStart,
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.leaderboardTtl);

    return { ...result, fromCache: false };
  }

  // ============================================================
  // GET PLATFORM LEADERBOARD — Top 100 Lagos-wide
  // ============================================================
  async getPlatformLeaderboard(page: number = 1, limit: number = 20) {
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);

    const cacheKey = `leaderboard:platform:${safePage}:${safeLimit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), fromCache: true };

    const latest = await this.prisma.platformLeaderboardSnapshot.findFirst({
      orderBy: { weekStart: 'desc' },
      select: { weekStart: true },
    });

    if (!latest) return { data: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };

    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.platformLeaderboardSnapshot.findMany({
        where: { weekStart: latest.weekStart },
        orderBy: { rank: 'asc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.platformLeaderboardSnapshot.count({
        where: { weekStart: latest.weekStart },
      }),
    ]);

    const result = {
      weekStart: latest.weekStart,
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.leaderboardTtl);

    return { ...result, fromCache: false };
  }

  // ============================================================
  // NATS — Handle report.completed → update rewards
  // ============================================================
  async handleReportCompleted(payload: ReportCompletedPayload): Promise<void> {
    // ── DB-level idempotency — survives Redis restarts
    try {
      await this.prisma.processedRewardEvent.create({
        data: {
          reportId: payload.reportId,
          authId: payload.reporterAuthId,
          pointsAwarded: payload.pointsAwarded,
        },
      });
    } catch (error) {
      // ── P2002 = unique constraint = already processed
      if ((error as any).code === 'P2002') {
        this.logger.warn(
          `Report ${payload.reportId} rewards already processed (DB check) — skipping`
        );
        return;
      }
      throw error;
    }

    // ── Get or create profile using upsert to prevent TOCTOU race conditions
    const profile = await this.prisma.citizenRewardsProfile.upsert({
      where: { authId: payload.reporterAuthId },
      update: {}, // If exists — do nothing, just return current state
      create: { authId: payload.reporterAuthId, lgaId: (payload.lgaId as any) ?? null },
    });

    const isHazardous = payload.wasteType === 'HAZARDOUS';
    const isCritical = payload.severity === 'CRITICAL';

    // ── Calculate streak bonus
    const streakBonus = await this.calculateStreakBonus(profile, payload.timestamp);

    const totalPoints = payload.pointsAwarded + streakBonus;

    // ── Update profile + check badges inside transaction
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.citizenRewardsProfile.update({
        where: { authId: payload.reporterAuthId },
        data: {
          totalReports: { increment: 1 },
          totalCompletedReports: { increment: 1 },
          totalPointsEarned: { increment: totalPoints },
          hazardousReports: isHazardous ? { increment: 1 } : undefined,
          criticalReports: isCritical ? { increment: 1 } : undefined,
        },
      });

      // ── Update streak
      await this.updateStreak(tx, updated, payload.timestamp, streakBonus);
    });

    // ── Fetch fresh profile AFTER transaction completes
    // This includes the updated streak values from updateStreak
    const freshProfile = await this.prisma.citizenRewardsProfile.findUnique({
      where: { authId: payload.reporterAuthId },
    });

    if (!freshProfile) return; // Should never happen — just a safety guard

    // ── Check and award badges OUTSIDE transaction (non-critical)
    // Rule 9: NATS emit outside transaction
    // ── Check badges with fully updated stats including new streak
    await this.checkAndAwardBadges(freshProfile);

    // ── Remove the old Redis set call at the bottom of the method entirely
    // The DB record IS the idempotency proof — no Redis needed

    // ── Invalidate caches
    await this.redis.del(`badges:${payload.reporterAuthId}`);
    await this.redis.del(`streak:${payload.reporterAuthId}`);

    this.logger.log(
      `Rewards processed for ${payload.reporterAuthId}: ` +
        `+${totalPoints} points (${payload.pointsAwarded} base + ${streakBonus} streak bonus)`,
    );
  }

  // ============================================================
  // NATS — Handle user.created → create rewards profile
  // ============================================================
  async handleUserCreated(payload: UserRegisteredPayload): Promise<void> {
    const { created, profile } = await (async () => {
      // Use upsert — if exists, update returns same data
      const existing = await this.prisma.citizenRewardsProfile.findUnique({
        where: { authId: payload.authId },
      });
      if (existing) return { created: false, profile: existing };

      try {
        const p = await this.prisma.citizenRewardsProfile.create({
          data: { authId: payload.authId, lgaId: (payload.lgaId as any) ?? null },
        });
        return { created: true, profile: p };
      } catch (error) {
        if ((error as any).code === 'P2002') {
          const p = await this.prisma.citizenRewardsProfile.findUnique({
            where: { authId: payload.authId },
          })!;
          return { created: false, profile: p! };
        }
        throw error;
      }
    })();

    if (!created) {
      this.logger.warn(`Profile already exists for ${payload.authId} — skipping`);
      return;
    }

    // ── Check early adopter badge
    // Platform launch date — if registered within first 30 days
    const platformLaunchDate = new Date('2026-01-01');
    const registrationDate = new Date(payload.timestamp);
    const daysSinceLaunch = Math.floor(
      (registrationDate.getTime() - platformLaunchDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysSinceLaunch <= 30) {
      await this.awardBadge(profile.id, BadgeType.EARLY_ADOPTER, {
        registrationDate: payload.timestamp,
        daysSinceLaunch,
      });
    }

    this.logger.log(`Rewards profile created for ${payload.authId}`);
  }

  // ============================================================
  // NATS — Handle KYC verified → award badge
  // ============================================================
  async handleKycVerified(payload: KycVerifiedPayload): Promise<void> {
    const profile = await this.prisma.citizenRewardsProfile.findUnique({
      where: { authId: payload.authId },
    });

    if (!profile) return;

    await this.awardBadge(profile.id, BadgeType.VERIFIED_CITIZEN, {
      verifiedAt: payload.timestamp,
    });

    this.logger.log(`VERIFIED_CITIZEN badge awarded to ${payload.authId}`);
  }

  // ============================================================
  // RECALCULATE LEADERBOARDS — Called by cron weekly (Sunday)
  // ============================================================
  async recalculateLeaderboards(): Promise<void> {
    this.logger.log('Recalculating weekly leaderboards...');

    // ── Use Lagos midnight (WAT UTC+1) as the week boundary
    // so snapshots align with the same day citizens experience
    const { lagosDate: todayLagos } = this.getLagosDateBoundaries(new Date().toISOString());

    // Roll back to last Sunday (0 = Sunday in getUTCDay after +1h shift)
    const lagosDay = new Date(todayLagos.getTime() + 60 * 60 * 1000).getUTCDay();
    const weekStart = new Date(todayLagos.getTime() - lagosDay * 24 * 60 * 60 * 1000);

    // ── Platform leaderboard first
    await this.recalculatePlatformLeaderboard(weekStart);

    // ── LGA leaderboards — parallel with concurrency limit of 5
    const lgaValues = Object.values(LagosLGA);
    const chunkSize = 5;

    for (let i = 0; i < lgaValues.length; i += chunkSize) {
      const chunk = lgaValues.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map((lgaId) =>
          this.recalculateLgaLeaderboard(weekStart, lgaId as LagosLGA)
        )
      );
      this.logger.log(
        `Processed LGA leaderboard chunk ` +
        `${Math.floor(i / chunkSize) + 1}/${Math.ceil(lgaValues.length / chunkSize)}`
      );
    }

    // ── FIX: Use SCAN + UNLINK instead of KEYS + DEL
    // SCAN is non-blocking cursor-based iteration
    // UNLINK is async delete (doesn't block while freeing memory)
    let cursor = '0';
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'leaderboard:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.unlink(...keys); // Non-blocking async delete
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');

    this.logger.log(
      `Weekly leaderboards recalculated — ${totalDeleted} cache keys cleared`
    );
  }

  // ============================================================
  // PRIVATE — Streak calculation
  // ============================================================
  private getLagosDateBoundaries(timestamp: string): {
    lagosDate: Date;   // Midnight WAT (UTC+1) — stored as UTC
    lagosDateEnd: Date; // Next midnight WAT
  } {
    const lagosOffsetMs = 60 * 60 * 1000; // UTC+1

    const utcTime = new Date(timestamp);
    // Shift to Lagos time to get the correct date
    const lagosTime = new Date(utcTime.getTime() + lagosOffsetMs);

    // Get Lagos midnight (start of day in Lagos time)
    const lagosStartOfDay = new Date(lagosTime);
    lagosStartOfDay.setUTCHours(0, 0, 0, 0);

    // Convert back to UTC for DB storage and comparison
    const lagosDate = new Date(lagosStartOfDay.getTime() - lagosOffsetMs);
    const lagosDateEnd = new Date(lagosDate.getTime() + 24 * 60 * 60 * 1000);

    return { lagosDate, lagosDateEnd };
  }

  private async calculateStreakBonus(profile: any, timestamp: string): Promise<number> {
    if (!profile.lastReportDate) return 0;

    const { lagosDate } = this.getLagosDateBoundaries(timestamp);
    const { lagosDate: lastLagosDate } = this.getLagosDateBoundaries(
      profile.lastReportDate.toISOString()
    );

    // Same Lagos day — no additional streak bonus
    if (lagosDate.getTime() === lastLagosDate.getTime()) return 0;

    // More than streakResetHours since last Lagos day — streak broken
    const hoursDiff =
      (lagosDate.getTime() - lastLagosDate.getTime()) / (1000 * 60 * 60);

    if (hoursDiff > this.streakResetHours) return 0;

    // Streak continues
    const newStreakDay = profile.currentStreakDays + 1;
    return Math.min(newStreakDay * this.dailyStreakBonus, this.maxStreakBonus);
  }

  private async updateStreak(
    tx: any,
    profile: any,
    timestamp: string,
    bonus: number,
  ): Promise<void> {
    const { lagosDate: reportDate } = this.getLagosDateBoundaries(timestamp);

    if (!profile.lastReportDate) {
      // ── First report
      await tx.citizenRewardsProfile.update({
        where: { authId: profile.authId },
        data: {
          currentStreakDays: 1,
          longestStreakDays: 1,
          lastReportDate: reportDate,
        },
      });

      await tx.streakLog.upsert({
        where: {
          profileId_reportDate: {
            profileId: profile.id,
            reportDate,
          },
        },
        create: {
          profileId: profile.id,
          reportDate,
          streakDay: 1,
          bonusPoints: bonus,
        },
        update: {},
      });

      return;
    }

    const { lagosDate: lastDate } = this.getLagosDateBoundaries(
      profile.lastReportDate.toISOString()
    );

    const hoursDiff = (reportDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60);

    if (reportDate.getTime() === lastDate.getTime() || hoursDiff < 20) {
      // ── Same day — just log
      return;
    }

    if (hoursDiff > this.streakResetHours) {
      // ── Streak broken — reset
      await tx.citizenRewardsProfile.update({
        where: { authId: profile.authId },
        data: {
          currentStreakDays: 1,
          lastReportDate: reportDate,
          streakBrokenAt: new Date(),
        },
      });
    } else {
      // ── Streak continues
      const newStreak = profile.currentStreakDays + 1;
      const longest = Math.max(newStreak, profile.longestStreakDays);

      await tx.citizenRewardsProfile.update({
        where: { authId: profile.authId },
        data: {
          currentStreakDays: newStreak,
          longestStreakDays: longest,
          lastReportDate: reportDate,
        },
      });

      await tx.streakLog.upsert({
        where: {
          profileId_reportDate: {
            profileId: profile.id,
            reportDate,
          },
        },
        create: {
          profileId: profile.id,
          reportDate,
          streakDay: newStreak,
          bonusPoints: bonus,
        },
        update: {},
      });
    }
  }

  // ============================================================
  // PRIVATE — Badge engine
  // ============================================================
  private async checkAndAwardBadges(profile: any): Promise<void> {
    // ── Fetch ALL of this citizen's badges in one query
    const existingBadges = await this.prisma.citizenBadge.findMany({
      where: { profileId: profile.id },
      select: { badgeType: true },
    });
    const awardedSet = new Set(existingBadges.map((b) => b.badgeType as string));

    const checks: Array<{ badge: string; condition: boolean; metadata?: any }> = [
      {
        badge: BadgeType.FIRST_REPORT,
        condition: profile.totalReports >= this.badgeThresholds.firstReportThreshold,
      },
      {
        badge: BadgeType.ACTIVE_REPORTER,
        condition: profile.totalReports >= this.badgeThresholds.activeReporterThreshold,
      },
      {
        badge: BadgeType.WASTE_WARRIOR,
        condition: profile.totalReports >= this.badgeThresholds.wasteWarriorThreshold,
      },
      {
        badge: BadgeType.LAGOS_CHAMPION,
        condition: profile.totalReports >= this.badgeThresholds.lagosChampionThreshold,
      },
      {
        badge: BadgeType.ELITE_REPORTER,
        condition: profile.totalReports >= this.badgeThresholds.eliteReporterThreshold,
      },
      {
        badge: BadgeType.POINTS_COLLECTOR,
        condition: profile.totalPointsEarned >= this.badgeThresholds.pointsCollectorThreshold,
      },
      {
        badge: BadgeType.POINTS_HUNTER,
        condition: profile.totalPointsEarned >= this.badgeThresholds.pointsHunterThreshold,
      },
      {
        badge: BadgeType.POINTS_MASTER,
        condition: profile.totalPointsEarned >= this.badgeThresholds.pointsMasterThreshold,
      },
      { badge: BadgeType.HAZARD_HERO, condition: profile.hazardousReports >= 5 },
      { badge: BadgeType.CRITICAL_RESPONDER, condition: profile.criticalReports >= 3 },
      {
        badge: BadgeType.STREAK_7,
        condition: profile.currentStreakDays >= 7 || profile.longestStreakDays >= 7,
      },
      {
        badge: BadgeType.STREAK_30,
        condition: profile.currentStreakDays >= 30 || profile.longestStreakDays >= 30,
      },
    ];

    // ── Filter to only badges that qualify AND aren't already awarded
    const toAward = checks.filter(
      (check) => check.condition && !awardedSet.has(check.badge)
    );

    if (toAward.length === 0) return;

    // ── Award all qualifying new badges
    for (const check of toAward) {
      await this.awardBadge(profile.id, check.badge, check.metadata ?? {});

      this.natsClient.emit('rewards.badge_awarded', {
        authId: profile.authId,
        badgeType: check.badge,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Badge awarded: ${check.badge} to ${profile.authId}`);
    }
  }

  private async awardBadge(
    profileId: string,
    badgeType: string,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    try {
      await this.prisma.citizenBadge.create({
        data: {
          profileId,
          badgeType: badgeType as any,
          metadata,
        },
      });
    } catch (error) {
      // ── Unique constraint violation = badge already awarded — silent skip
      if ((error as any).code === 'P2002') return;
      throw error;
    }
  }

  // ============================================================
  // PRIVATE — Leaderboard recalculation
  // ============================================================
  private async recalculatePlatformLeaderboard(weekStart: Date): Promise<void> {
    const topCitizens = await this.prisma.citizenRewardsProfile.findMany({
      orderBy: { totalPointsEarned: 'desc' },
      take: 100,
      include: { badges: { select: { id: true } } },
    });

    // ── Delete existing week's snapshot entries first
    await this.prisma.platformLeaderboardSnapshot.deleteMany({
      where: { weekStart },
    });

    // ── Create fresh entries
    if (topCitizens.length > 0) {
      await this.prisma.platformLeaderboardSnapshot.createMany({
        data: topCitizens.map((citizen, index) => ({
          weekStart,
          rank: index + 1,
          authId: citizen.authId,
          totalPoints: citizen.totalPointsEarned,
          totalReports: citizen.totalReports,
          badgeCount: citizen.badges.length,
          lgaId: citizen.lgaId,
        })),
      });
    }
  }

  private async recalculateLgaLeaderboard(weekStart: Date, lgaId: LagosLGA): Promise<void> {
    const topCitizens = await this.prisma.citizenRewardsProfile.findMany({
      where: { lgaId },
      orderBy: { totalPointsEarned: 'desc' },
      take: 50,
      include: { badges: { select: { id: true } } },
    });

    await this.prisma.lgaLeaderboardSnapshot.deleteMany({
      where: { weekStart, lgaId },
    });

    if (topCitizens.length > 0) {
      await this.prisma.lgaLeaderboardSnapshot.createMany({
        data: topCitizens.map((citizen, index) => ({
          weekStart, lgaId, rank: index + 1,
          authId: citizen.authId,
          totalPoints: citizen.totalPointsEarned,
          totalReports: citizen.totalReports,
          badgeCount: citizen.badges.length,
        })),
      });
    }
  }
}
