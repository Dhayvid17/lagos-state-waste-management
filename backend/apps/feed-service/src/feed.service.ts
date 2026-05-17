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
import type { JwtPayload } from '@app/shared';
import { LagosLGA, NatsEvents, UserRole } from '@app/shared';
import type Redis from 'ioredis';
import {
  LagosLGA as PrismaLagosLGA,
  WasteType as PrismaWasteType,
  ReportSeverity as PrismaReportSeverity,
  ReportStatus as PrismaReportStatus,
} from './generated/prisma/enums';

import { PrismaService } from './prisma/prisma.service';

// ── Payload shapes from NATS events
export interface ReportCreatedPayload {
  reportId: string;
  reporterAuthId: string;
  title: string;
  wasteType: string;
  severity: string;
  lgaId: string;
  latitude: number;
  longitude: number;
  thumbnailKey?: string;
  timestamp: string;
}

export interface ReportStatusPayload {
  reportId: string;
  reporterAuthId: string;
  status: string;
  wasteType?: string;
  lgaId?: string;
  pointsAwarded?: number;
  timestamp: string;
  mediaKeys?: string[];           // Original report photos (before)
  completionMediaKeys?: string[]; // Collector's completion photos (after)
}

export interface MediaProcessedPayload {
  originalKey: string;
  compressedKey: string;
  thumbnailKey: string;
  uploadedById: string;
  mediaType: string;
}

export interface CollectorLocationPayload {
  collectorAuthId: string;
  assignmentId: string;
  reportId: string;
  etaMinutes: number;
  timestamp: string;
}

export interface SocialEngagementPayload {
  reportId: string;
  upvoteCount?: number;
  commentCount?: number;
  repostCount?: number;
}

@Injectable()
export class FeedService {
  private readonly logger = new Logger(FeedService.name);

  private readonly severityWeights: Record<string, number>;
  private readonly scoreWeights: Record<string, number>;
  private readonly completedDerankFactor: number;
  private readonly archiveAfterDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {
    this.severityWeights = this.configService.get('feed.ranking.severityWeights') ?? {
      LOW: 1.0,
      MEDIUM: 2.0,
      HIGH: 3.5,
      CRITICAL: 5.0,
    };
    this.scoreWeights = this.configService.get('feed.ranking.scoreWeights') ?? {
      severity: 0.45,
      upvotes: 0.35,
      recency: 0.20,
    };
    this.completedDerankFactor =
      this.configService.get<number>('feed.ranking.completedDerankFactor') ?? 0.2;
    this.archiveAfterDays =
      this.configService.get<number>('feed.ranking.archiveAfterDays') ?? 30;
  }

  // ============================================================
  // GET FEED — Main feed with ranking
  // ============================================================
  async getFeed(
    user: JwtPayload,
    page: number = 1,
    limit: number = 20,
    lgaId?: LagosLGA,
    viewAll: boolean = false,
  ) {
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    // ── Build where clause
    // ARCHIVED and REMOVED never appear in main feed
    const where: any = {
      feedStatus: { in: ['ACTIVE', 'RESOLVED'] },
    };

    if (!viewAll) {
      // Default — user's own LGA only
      // Use explicitly provided lgaId, or fall back to the user's registered LGA
      where.lgaId = lgaId ?? (user.lgaId ? (user.lgaId as PrismaLagosLGA) : undefined);
    } else {
      // All Lagos view — no LGA filter unless user explicitly narrows by lgaId
      if (lgaId) where.lgaId = lgaId;
    }

    const [posts, total] = await Promise.all([
      this.prisma.feedPost.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: [{ rankScore: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          reportId: true,
          reporterAuthId: true,
          lgaId: true,
          wasteType: true,
          severity: true,
          title: true,
          thumbnailKey: true,
          reportStatus: true,
          feedStatus: true,
          upvoteCount: true,
          commentCount: true,
          repostCount: true,
          rankScore: true,
          collectorEtaMinutes: true,
          resolvedAt: true,
          createdAt: true,
          latitude: true,
          longitude: true,
        },
      }),
      this.prisma.feedPost.count({ where }),
    ]);

    // ── Get presigned URLs for thumbnails from Redis cache in a single MGET
    const thumbnailCacheKeys = posts.map((p) =>
      p.thumbnailKey ? `presign:${p.thumbnailKey}` : null,
    );

    const validCacheKeys = thumbnailCacheKeys.filter(Boolean) as string[];
    const cachedUrls =
      validCacheKeys.length > 0 ? await this.redis.mget(...validCacheKeys) : [];

    let urlIndex = 0;
    const postsWithUrls = posts.map((post, i) => ({
      ...post,
      thumbnailPresignedUrl: thumbnailCacheKeys[i] ? (cachedUrls[urlIndex++] ?? null) : null,
    }));

    return {
      data: postsWithUrls,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ============================================================
  // GET SINGLE POST
  // ============================================================
  async getPost(postId: string) {
    const post = await this.prisma.feedPost.findUnique({
      where: { id: postId },
    });

    if (!post) throw new NotFoundException('Post not found');
    if (post.feedStatus === 'REMOVED') {
      throw new NotFoundException('Post not found');
    }

    return post;
  }

  // ============================================================
  // GET POST BY REPORT ID
  // ============================================================
  async getPostByReportId(reportId: string) {
    const post = await this.prisma.feedPost.findUnique({
      where: { reportId },
    });

    if (!post || post.feedStatus === 'REMOVED') {
      throw new NotFoundException('Post not found');
    }

    return post;
  }

  // ============================================================
  // DELETE POST — Citizen (24h + PENDING only) or SYS_ADMIN
  // ============================================================
  async deletePost(
    user: JwtPayload,
    postId: string,
    reason?: string,
    ip?: string,
    userAgent?: string,
  ) {
    const post = await this.prisma.feedPost.findUnique({
      where: { id: postId },
    });

    if (!post || post.feedStatus === 'REMOVED') {
      throw new NotFoundException('Post not found');
    }

    // ── SYS_ADMIN can delete anything — mandatory reason
    if (user.role === UserRole.SYS_ADMIN) {
      if (!reason) {
        throw new BadRequestException('SYS_ADMIN must provide a reason when deleting posts');
      }

      return this.removePost(post.id, user, reason, ip, userAgent);
    }

    // ── AGENCY_ADMIN should use the archive endpoint, not delete
    if (user.role === UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException(
        'Agency admins should use the archive endpoint (PATCH /feed/:id/archive) ' +
          'to remove posts from the main feed',
      );
    }

    // ── Citizen delete rules
    if (post.reporterAuthId !== user.sub) {
      throw new ForbiddenException('You can only delete your own posts');
    }

    // ── Must still be PENDING (admin has not touched it)
    if (post.reportStatus !== PrismaReportStatus.PENDING) {
      throw new ForbiddenException(
        'This report is under review and cannot be deleted. ' +
          'Contact support@lagoswaste.gov.ng if you believe this was submitted in error.',
      );
    }

    // ── Must be within 24 hours
    if (new Date() > post.citizenCanDeleteUntil) {
      throw new ForbiddenException(
        'The 24-hour deletion window has passed. ' +
          'Contact support@lagoswaste.gov.ng if you believe this was submitted in error.',
      );
    }

    return this.removePost(post.id, user, reason ?? 'Citizen requested deletion', ip, userAgent);
  }

  // ============================================================
  // ARCHIVE POST — AGENCY_ADMIN only
  // ============================================================
  async archivePost(user: JwtPayload, postId: string, ip?: string, userAgent?: string) {
    if (user.role !== UserRole.AGENCY_ADMIN && user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const post = await this.prisma.feedPost.findUnique({
      where: { id: postId },
    });

    if (!post) throw new NotFoundException('Post not found');

    // ── AGENCY_ADMIN can only archive posts in their LGA
    if (user.role === UserRole.AGENCY_ADMIN && post.lgaId !== user.lgaId) {
      throw new ForbiddenException('You can only archive posts in your LGA');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.feedPost.update({
        where: { id: postId },
        data: { feedStatus: 'ARCHIVED' },
      });

      await tx.feedAuditLog.create({
        data: {
          actorId: user.sub,
          actorRole: user.role,
          action: 'POST_ARCHIVED',
          targetId: postId,
          targetType: 'FEED_POST',
          ipAddress: ip,
          userAgent,
          metadata: { lgaId: post.lgaId },
        },
      });
    });

    return { message: 'Post archived successfully' };
  }

  // ============================================================
  // SEARCH FEED — Including archived
  // ============================================================
  async searchFeed(
    query: string,
    lgaId?: LagosLGA,
    wasteType?: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const where: any = {
      feedStatus: { not: 'REMOVED' }, // Only hide REMOVED posts
      title: { contains: query, mode: 'insensitive' },
    };

    if (lgaId) where.lgaId = lgaId;
    if (wasteType) where.wasteType = wasteType;

    const [posts, total] = await Promise.all([
      this.prisma.feedPost.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { rankScore: 'desc' },
        select: {
          id: true,
          reportId: true,
          reporterAuthId: true,
          lgaId: true,
          wasteType: true,
          severity: true,
          title: true,
          thumbnailKey: true,
          reportStatus: true,
          feedStatus: true,
          upvoteCount: true,
          commentCount: true,
          repostCount: true,
          createdAt: true,
        },
      }),
      this.prisma.feedPost.count({ where }),
    ]);

    // ── Get presigned URLs for thumbnails from Redis cache in a single MGET
    const thumbnailCacheKeys = posts.map((p) =>
      p.thumbnailKey ? `presign:${p.thumbnailKey}` : null,
    );

    const validCacheKeys = thumbnailCacheKeys.filter(Boolean) as string[];
    const cachedUrls =
      validCacheKeys.length > 0 ? await this.redis.mget(...validCacheKeys) : [];

    let urlIndex = 0;
    const postsWithUrls = posts.map((post, i) => ({
      ...post,
      thumbnailPresignedUrl: thumbnailCacheKeys[i] ? (cachedUrls[urlIndex++] ?? null) : null,
    }));

    return {
      data: postsWithUrls,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ============================================================
  // NATS — Handle report.created → create feed post
  // ============================================================
  async handleReportCreated(payload: ReportCreatedPayload): Promise<void> {
    const now = new Date();
    const citizenDeleteUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const initialScore = this.calculateScore({
      severity: payload.severity,
      upvoteCount: 0,
      createdAt: now,
      isCompleted: false,
    });

    try {
      const post = await this.prisma.feedPost.create({
        data: {
          reportId: payload.reportId,
          reporterAuthId: payload.reporterAuthId,
          lgaId: payload.lgaId as PrismaLagosLGA,
          wasteType: payload.wasteType as PrismaWasteType,
          severity: payload.severity as PrismaReportSeverity,
          latitude: payload.latitude,
          longitude: payload.longitude,
          title: payload.title,
          thumbnailKey: payload.thumbnailKey ?? null,
          reportStatus: PrismaReportStatus.PENDING,
          feedStatus: 'ACTIVE',
          rankScore: initialScore,
          rankScoreUpdatedAt: now,
          citizenCanDeleteUntil: citizenDeleteUntil,
        },
      });

      this.logger.log(`FeedPost created: ${post.id} for report ${payload.reportId}`);

      // ── Fire NATS event — social-service initializes engagement counters
      // Rule 9: outside transaction
      this.natsClient.emit('feed.post_created', {
        feedPostId: post.id,
        reportId: payload.reportId,
        lgaId: payload.lgaId,
        timestamp: now.toISOString(),
      });
    } catch (error) {
      // ── P2002 = unique constraint violation = duplicate event
      if ((error as any).code === 'P2002') {
        this.logger.warn(
          `FeedPost already exists for reportId: ${payload.reportId} — duplicate event skipped`,
        );
        return; // Idempotent — this is not an error
      }
      throw error; // Real errors get rethrown for NATS retry
    }
  }

  // ============================================================
  // NATS — Handle report status changes
  // ============================================================
  async handleReportStatusChanged(payload: ReportStatusPayload): Promise<void> {
    const post = await this.prisma.feedPost.findUnique({
      where: { reportId: payload.reportId },
    });

    if (!post) {
      this.logger.warn(
        `No FeedPost found for reportId: ${payload.reportId} — skipping status update`,
      );
      return;
    }

    const updateData: any = { reportStatus: payload.status as PrismaReportStatus };

    if (payload.status === 'COMPLETED') {
      if (post.resolvedAt) {
        this.logger.warn(
          `Duplicate COMPLETED event for report ${payload.reportId} — resolvedAt already set, skipping`,
        );
        return; // Already handled
      }

      const resolvedAt = new Date();
      const archiveAfter = new Date(
        resolvedAt.getTime() + this.archiveAfterDays * 24 * 60 * 60 * 1000,
      );

      updateData.feedStatus = 'RESOLVED';
      updateData.resolvedAt = resolvedAt;
      updateData.archiveAfter = archiveAfter;

      // ── Populate before/after media evidence
      // TODO: Ensure report-service includes mediaKeys and completionMediaKeys in report.completed payload
      if (payload.mediaKeys?.length) {
        updateData.beforeMediaKeys = payload.mediaKeys;
      }
      if (payload.completionMediaKeys?.length) {
        updateData.afterMediaKeys = payload.completionMediaKeys;
      }

      // ── Recalculate score with derank
      updateData.rankScore = this.calculateScore({
        severity: post.severity,
        upvoteCount: post.upvoteCount,
        createdAt: post.createdAt,
        isCompleted: true,
      });
    } else if (payload.status === 'REJECTED' || payload.status === 'CANCELLED') {
      // ── Rejected/cancelled reports archived immediately
      updateData.feedStatus = 'ARCHIVED';
    }

    await this.prisma.feedPost.update({
      where: { reportId: payload.reportId },
      data: updateData,
    });

    this.logger.log(`FeedPost updated: report ${payload.reportId} → status ${payload.status}`);
  }

  // ============================================================
  // NATS — Handle media.processed → update thumbnail key
  // ============================================================
  async handleMediaProcessed(payload: MediaProcessedPayload): Promise<void> {
    // ── Find posts that reference the original key as thumbnail
    const post = await this.prisma.feedPost.findFirst({
      where: { thumbnailKey: payload.originalKey },
    });

    if (!post) return;

    await this.prisma.feedPost.update({
      where: { id: post.id },
      data: { thumbnailKey: payload.thumbnailKey },
    });

    this.logger.log(`FeedPost thumbnail updated: ${payload.originalKey} → ${payload.thumbnailKey}`);
  }

  // ============================================================
  // NATS — Handle collector.location_updated → update ETA
  // ============================================================
  async handleCollectorLocationUpdated(payload: CollectorLocationPayload): Promise<void> {
    await this.prisma.feedPost.updateMany({
      where: { reportId: payload.reportId, feedStatus: 'ACTIVE' },
      data: {
        collectorEtaMinutes: payload.etaMinutes,
        collectorEtaUpdatedAt: new Date(),
      },
    });
  }

  // ============================================================
  // NATS — Handle social engagement updates
  // social-service fires these to keep feed counts in sync
  // ============================================================
  async handleEngagementUpdated(payload: SocialEngagementPayload): Promise<void> {
    const post = await this.prisma.feedPost.findUnique({
      where: { reportId: payload.reportId },
    });

    if (!post) return;

    const updateData: any = {};
    if (payload.upvoteCount !== undefined) updateData.upvoteCount = payload.upvoteCount;
    if (payload.commentCount !== undefined) updateData.commentCount = payload.commentCount;
    if (payload.repostCount !== undefined) updateData.repostCount = payload.repostCount;

    // ── Recalculate score with new upvote count
    if (payload.upvoteCount !== undefined) {
      updateData.rankScore = this.calculateScore({
        severity: post.severity,
        upvoteCount: payload.upvoteCount,
        createdAt: post.createdAt,
        isCompleted: post.feedStatus === 'RESOLVED',
      });
      updateData.rankScoreUpdatedAt = new Date();
    }

    await this.prisma.feedPost.update({
      where: { reportId: payload.reportId },
      data: updateData,
    });
  }

  // ============================================================
  // RECALCULATE ALL SCORES — Called by cron every 5 minutes
  // Recency score decays over time — must be recalculated
  // ============================================================
  async recalculateAllScores(): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const posts = await this.prisma.feedPost.findMany({
      where: {
        feedStatus: { in: ['ACTIVE', 'RESOLVED'] },
        createdAt: { gte: sevenDaysAgo }, // Only recent posts change score meaningfully
      },
      select: {
        id: true,
        severity: true,
        upvoteCount: true,
        createdAt: true,
        feedStatus: true,
      },
      orderBy: { rankScore: 'desc' },
      take: 500, // Never load more than 500 at once
    });

    if (!posts.length) return;

    // ── Batch update in groups of 50
    const batchSize = 50;
    for (let i = 0; i < posts.length; i += batchSize) {
      const batch = posts.slice(i, i + batchSize);

      await this.prisma.$transaction(
        batch.map((post) => {
          const score = this.calculateScore({
            severity: post.severity,
            upvoteCount: post.upvoteCount,
            createdAt: post.createdAt,
            isCompleted: post.feedStatus === 'RESOLVED',
          });

          return this.prisma.feedPost.update({
            where: { id: post.id },
            data: { rankScore: score, rankScoreUpdatedAt: new Date() },
          });
        }),
      );
    }

    this.logger.log(`Recalculated scores for ${posts.length} recent feed posts`);
  }

  // ============================================================
  // RECALCULATE OLD POST SCORES — Called daily by cron at 3 AM
  // Older posts decay slowly and have static recency score
  // ============================================================
  async recalculateOldPostScores(): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const posts = await this.prisma.feedPost.findMany({
      where: {
        feedStatus: { in: ['ACTIVE', 'RESOLVED'] },
        createdAt: { lt: sevenDaysAgo },
      },
      select: {
        id: true,
        severity: true,
        upvoteCount: true,
        createdAt: true,
        feedStatus: true,
      },
      take: 1000,
    });

    if (!posts.length) return;

    const batchSize = 50;
    for (let i = 0; i < posts.length; i += batchSize) {
      const batch = posts.slice(i, i + batchSize);
      await this.prisma.$transaction(
        batch.map((post) => {
          const score = this.calculateScore({
            severity: post.severity,
            upvoteCount: post.upvoteCount,
            createdAt: post.createdAt,
            isCompleted: post.feedStatus === 'RESOLVED',
          });
          return this.prisma.feedPost.update({
            where: { id: post.id },
            data: { rankScore: score, rankScoreUpdatedAt: new Date() },
          });
        }),
      );
    }

    this.logger.log(`Full recalculated ${posts.length} older feed post scores`);
  }

  // ============================================================
  // AUTO-ARCHIVE COMPLETED POSTS — Called by cron daily
  // ============================================================
  async autoArchiveExpiredPosts(): Promise<void> {
    const result = await this.prisma.feedPost.updateMany({
      where: {
        feedStatus: 'RESOLVED',
        archiveAfter: { lt: new Date() },
      },
      data: { feedStatus: 'ARCHIVED' },
    });

    if (result.count > 0) {
      this.logger.log(`Auto-archived ${result.count} resolved feed posts`);
    }
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private calculateScore(params: {
    severity: string;
    upvoteCount: number;
    createdAt: Date;
    isCompleted: boolean;
  }): number {
    const severityScore = this.severityWeights[params.severity] ?? 1;
    const upvoteScore = Math.log10(params.upvoteCount + 1); // Log scale
    const recencyScore = this.calculateRecencyScore(params.createdAt);

    const rawScore =
      severityScore * this.scoreWeights.severity +
      upvoteScore * this.scoreWeights.upvotes +
      recencyScore * this.scoreWeights.recency;

    // ── De-rank completed posts by 80%
    return params.isCompleted ? rawScore * this.completedDerankFactor : rawScore;
  }

  private calculateRecencyScore(createdAt: Date): number {
    const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

    if (ageHours < 1) return 10; // Full score < 1 hour
    if (ageHours < 6) return 8; // 1-6 hours
    if (ageHours < 24) return 5; // 6-24 hours
    if (ageHours < 72) return 3; // 1-3 days
    if (ageHours < 168) return 1; // 3-7 days
    return 0.5; // Older than 7 days
  }

  private async removePost(
    postId: string,
    actor: JwtPayload,
    reason: string,
    ip?: string,
    userAgent?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.feedPost.update({
        where: { id: postId },
        data: {
          feedStatus: 'REMOVED',
          removedAt: new Date(),
          removedByAuthId: actor.sub,
          removalReason: reason,
        },
      });

      await tx.feedAuditLog.create({
        data: {
          actorId: actor.sub,
          actorRole: actor.role,
          action: 'POST_REMOVED',
          targetId: postId,
          targetType: 'FEED_POST',
          ipAddress: ip,
          userAgent,
          metadata: { reason },
        },
      });
    });

    return { message: 'Post removed successfully' };
  }
}
