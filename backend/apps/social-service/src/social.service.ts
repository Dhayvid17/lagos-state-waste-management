import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import type { JwtPayload } from '@app/shared';
import { NatsEvents, UserRole } from '@app/shared';
import { firstValueFrom, timeout } from 'rxjs';
import type Redis from 'ioredis';

import { PrismaService } from './prisma/prisma.service';
import type {
  AddCommentDto,
  DeleteCommentDto,
  RepostDto,
  FlagReportDto,
  ResolveFlagDto,
} from './dto/social.dto';

// ── Report status check interface
// social-service does NOT own report data
// It receives status via NATS and caches allowed statuses in Redis
const COMMENTABLE_STATUSES = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'ASSIGNED'];
const UPVOTABLE_STATUSES = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'ASSIGNED'];

@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);

  private readonly maxCommentsPerHour: number;
  private readonly maxUpvotesPerHour: number;
  private readonly maxRepostsPerHour: number;
  private readonly maxFlagsPerDay: number;
  private readonly flagEscalationThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {
    this.maxCommentsPerHour = this.configService.get<number>('social.limits.maxCommentsPerHour')!;
    this.maxUpvotesPerHour = this.configService.get<number>('social.limits.maxUpvotesPerHour')!;
    this.maxRepostsPerHour = this.configService.get<number>('social.limits.maxRepostsPerHour')!;
    this.maxFlagsPerDay = this.configService.get<number>('social.limits.maxFlagsPerUserPerDay')!;
    this.flagEscalationThreshold = this.configService.get<number>('social.limits.flagEscalationThreshold')!;
  }

  // ============================================================
  // UPVOTE — Civic verification "I confirm this dump exists"
  // ============================================================
  async upvoteReport(user: JwtPayload, reportId: string) {
    // ── CORRECT ORDER: status → ownership → rate limit
    // Non-destructive checks before consuming rate limit

    // 1. Check report status allows upvoting
    await this.assertReportStatus(reportId, UPVOTABLE_STATUSES, 'upvoted');

    // 2. Cannot upvote own report — check BEFORE rate limit
    const isOwnReport = await this.isOwnReport(user.sub, reportId);
    if (isOwnReport) {
      throw new BadRequestException('You cannot upvote your own report');
    }

    // 3. Rate limit — only consume AFTER other checks pass
    await this.enforceRateLimit(user.sub, 'upvote', 3600, this.maxUpvotesPerHour);

    // 4. Create upvote — use unique constraint as atomic gate (no pre-check)
    try {
      const counter = await this.prisma.$transaction(async (tx) => {
        // If duplicate, P2002 is caught below — no findUnique pre-check needed
        await tx.upvote.create({
          data: { reportId, citizenAuthId: user.sub },
        });

        try {
          return await tx.engagementCounter.update({
            where: { reportId },
            data: { upvoteCount: { increment: 1 } },
          });
        } catch (err) {
          if ((err as any).code === 'P2025') {
            try {
              return await tx.engagementCounter.create({
                data: { reportId, upvoteCount: 1 },
              });
            } catch (createErr) {
              if ((createErr as any).code === 'P2002') {
                // Concurrency Trap: Row was created by racing thread — safely update now!
                return await tx.engagementCounter.update({
                  where: { reportId },
                  data: { upvoteCount: { increment: 1 } },
                });
              }
              throw createErr;
            }
          }
          throw err;
        }
      });

      // ── Invalidate Redis cache hash
      await this.redis.del(`engagement:${reportId}`);

      // ── Fire NATS event OUTSIDE transaction (Rule 9)
      // feed-service updates rank score
      // notification-service alerts reporter
      this.natsClient.emit('social.engagement_updated', {
        reportId,
        upvoteCount: counter.upvoteCount,
        timestamp: new Date().toISOString(),
      });

      return {
        message: 'Upvote recorded — thank you for civic verification',
        upvoteCount: counter.upvoteCount,
      };
    } catch (error) {
      // ── P2002 = unique constraint = already upvoted
      if ((error as any).code === 'P2002') {
        throw new ConflictException('You have already upvoted this report');
      }
      throw error;
    }
  }

  // ============================================================
  // REMOVE UPVOTE
  // ============================================================
  async removeUpvote(user: JwtPayload, reportId: string) {
    const existing = await this.prisma.upvote.findUnique({
      where: {
        reportId_citizenAuthId: {
          reportId,
          citizenAuthId: user.sub,
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('You have not upvoted this report');
    }

    const counter = await this.prisma.$transaction(async (tx) => {
      await tx.upvote.delete({
        where: {
          reportId_citizenAuthId: {
            reportId,
            citizenAuthId: user.sub,
          },
        },
      });

      await tx.$executeRaw`
        UPDATE social.engagement_counters
        SET upvote_count = GREATEST(0, upvote_count - 1),
            updated_at = NOW()
        WHERE report_id = ${reportId}
      `;

      return tx.engagementCounter.findUnique({ where: { reportId } });
    });

    const upvoteCount = Math.max(0, counter?.upvoteCount ?? 0);

    // ── Invalidate Redis cache hash
    await this.redis.del(`engagement:${reportId}`);

    // ── Fire NATS event outside transaction
    this.natsClient.emit('social.engagement_updated', {
      reportId,
      upvoteCount,
      timestamp: new Date().toISOString(),
    });

    return {
      message: 'Upvote removed',
      upvoteCount,
    };
  }

  // ============================================================
  // ADD COMMENT
  // ============================================================
  async addComment(user: JwtPayload, reportId: string, dto: AddCommentDto, ip?: string) {
    // ── Comments only allowed on active reports
    await this.assertReportStatus(reportId, COMMENTABLE_STATUSES, 'commented on');

    // ── Rate limit
    await this.enforceRateLimit(user.sub, 'comment', 3600, this.maxCommentsPerHour);

    // ── Get reporterAuthId — try Redis cache first, then NATS fallback
    let reporterAuthId = await this.redis.get(`report_owner:${reportId}`);

    if (!reporterAuthId || reporterAuthId === 'undefined') {
      try {
        const result = await firstValueFrom(
          this.natsClient.send<{ reporterAuthId: string }>('report.get_reporter', { reportId }).pipe(
            timeout(5000),
          ),
        );
        reporterAuthId = result?.reporterAuthId ?? null;

        if (reporterAuthId && reporterAuthId !== 'undefined') {
          await this.redis.set(
            `report_owner:${reportId}`,
            reporterAuthId,
            'EX',
            90 * 24 * 60 * 60,
          );
        }
      } catch (error) {
        this.logger.warn(`Could not fetch reporter for ${reportId}: ${(error as Error).message}`);
        reporterAuthId = null; // Explicitly null, not empty string
      }
    }

    const comment = await this.prisma.$transaction(async (tx) => {
      const newComment = await tx.comment.create({
        data: {
          reportId,
          authorAuthId: user.sub,
          reporterAuthId: reporterAuthId ?? null, // ← null, never empty string
          content: dto.content,
        },
      });

      // ── Update engagement counter
      try {
        await tx.engagementCounter.update({
          where: { reportId },
          data: { commentCount: { increment: 1 } },
        });
      } catch (err) {
        if ((err as any).code === 'P2025') {
          try {
            await tx.engagementCounter.create({
              data: { reportId, commentCount: 1 },
            });
          } catch (createErr) {
            if ((createErr as any).code === 'P2002') {
              // Concurrency Trap: Row was created by racing thread — safely update now!
              await tx.engagementCounter.update({
                where: { reportId },
                data: { commentCount: { increment: 1 } },
              });
            } else {
              throw createErr;
            }
          }
        } else {
          throw err;
        }
      }

      return newComment;
    });

    // ── Invalidate Redis cache hash
    await this.redis.del(`engagement:${reportId}`);

    // ── Fire NATS events outside transaction (Rule 9)
    // Notify post owner someone commented
    if (reporterAuthId && reporterAuthId !== user.sub) {
      this.natsClient.emit('social.comment_added', {
        commentId: comment.id,
        reportId,
        authorAuthId: user.sub,
        reporterAuthId,
        contentPreview: dto.content.slice(0, 100),
        timestamp: new Date().toISOString(),
      });
    }

    // ── Sync engagement counts to feed-service
    const counter = await this.prisma.engagementCounter.findUnique({
      where: { reportId },
    });

    this.natsClient.emit('social.engagement_updated', {
      reportId,
      commentCount: counter?.commentCount ?? 1,
      timestamp: new Date().toISOString(),
    });

    return comment;
  }

  // ============================================================
  // GET COMMENTS — Paginated, excludes soft-deleted
  // ============================================================
  async getComments(reportId: string, page: number = 1, limit: number = 20) {
    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const [data, counter] = await Promise.all([
      this.prisma.comment.findMany({
        where: { reportId, isDeleted: false },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'asc' }, // Chronological for comments
        select: {
          id: true,
          reportId: true,
          authorAuthId: true,
          content: true,
          createdAt: true,
        },
      }),
      this.prisma.engagementCounter.findUnique({
        where: { reportId },
        select: { commentCount: true },
      }),
    ]);

    const total = counter?.commentCount ?? 0;

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ============================================================
  // DELETE COMMENT — Soft delete only
  // Reporter can delete on own report
  // AGENCY_ADMIN / SYS_ADMIN can delete any
  // ============================================================
  async deleteComment(
    user: JwtPayload,
    commentId: string,
    dto: DeleteCommentDto,
    ip?: string,
    userAgent?: string,
  ) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment || comment.isDeleted) {
      throw new NotFoundException('Comment not found');
    }

    // ── Permission check
    const isAuthor = comment.authorAuthId === user.sub;
    const isReporter = comment.reporterAuthId === user.sub;
    const isAdmin = user.role === UserRole.SYS_ADMIN || user.role === UserRole.AGENCY_ADMIN;

    if (!isAuthor && !isReporter && !isAdmin) {
      throw new ForbiddenException('You do not have permission to delete this comment');
    }

    await this.prisma.$transaction(async (tx) => {
      // ── Soft delete — never hard delete
      await tx.comment.update({
        where: { id: commentId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedByAuthId: user.sub,
          deletedByRole: user.role,
          deletionReason: dto.reason ?? 'No reason provided',
        },
      });

      // ── Decrement counter
      await tx.$executeRaw`
        UPDATE social.engagement_counters
        SET comment_count = GREATEST(0, comment_count - 1),
            updated_at = NOW()
        WHERE report_id = ${comment.reportId}
      `;

      // ── Audit log for admin deletions
      if (isAdmin) {
        await tx.socialAuditLog.create({
          data: {
            actorId: user.sub,
            actorRole: user.role,
            action: 'COMMENT_DELETED',
            targetId: commentId,
            targetType: 'COMMENT',
            ipAddress: ip,
            userAgent,
            metadata: {
              reason: dto.reason,
              commentAuthor: comment.authorAuthId,
              reportId: comment.reportId,
            },
          },
        });
      }
    });

    // ── Invalidate Redis cache hash
    await this.redis.del(`engagement:${comment.reportId}`);

    // ── Sync to feed-service outside transaction
    const counter = await this.prisma.engagementCounter.findUnique({
      where: { reportId: comment.reportId },
    });

    this.natsClient.emit('social.engagement_updated', {
      reportId: comment.reportId,
      commentCount: Math.max(0, counter?.commentCount ?? 0),
      timestamp: new Date().toISOString(),
    });

    return { message: 'Comment deleted successfully' };
  }

  // ============================================================
  // REPOST — Citizen shares report to increase visibility
  // ============================================================
  async repostReport(user: JwtPayload, reportId: string, dto: RepostDto) {
    // ── Check report status — allow repost on active AND completed reports
    // (showing resolved issues is fine — proof platform works)
    // Block only on REJECTED (fake/abusive) reports
    await this.assertReportStatus(
      reportId,
      ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'ASSIGNED', 'COMPLETED'],
      'reposted',
    );

    // ── Rate limit
    await this.enforceRateLimit(user.sub, 'repost', 3600, this.maxRepostsPerHour);

    // ── Check already reposted
    const existing = await this.prisma.repost.findUnique({
      where: {
        reportId_citizenAuthId: {
          reportId,
          citizenAuthId: user.sub,
        },
      },
    });

    if (existing) {
      throw new ConflictException('You have already reposted this report');
    }

    const counter = await this.prisma.$transaction(async (tx) => {
      await tx.repost.create({
        data: {
          reportId,
          citizenAuthId: user.sub,
          note: dto.note,
        },
      });

      try {
        return await tx.engagementCounter.update({
          where: { reportId },
          data: { repostCount: { increment: 1 } },
        });
      } catch (err) {
        if ((err as any).code === 'P2025') {
          try {
            return await tx.engagementCounter.create({
              data: { reportId, repostCount: 1 },
            });
          } catch (createErr) {
            if ((createErr as any).code === 'P2002') {
              // Concurrency Trap: Row was created by racing thread — safely update now!
              return await tx.engagementCounter.update({
                where: { reportId },
                data: { repostCount: { increment: 1 } },
              });
            }
            throw createErr;
          }
        }
        throw err;
      }
    });

    // ── Invalidate Redis cache hash
    await this.redis.del(`engagement:${reportId}`);

    // ── Sync to feed-service outside transaction
    this.natsClient.emit('social.engagement_updated', {
      reportId,
      repostCount: counter.repostCount,
      timestamp: new Date().toISOString(),
    });

    return {
      message: 'Report reposted successfully',
      repostCount: counter.repostCount,
    };
  }

  // ============================================================
  // FLAG REPORT — Citizen flags abusive/fake content
  // ============================================================
  async flagReport(user: JwtPayload, reportId: string, dto: FlagReportDto, ip?: string) {
    // ── Rate limit — max flags per day
    await this.enforceRateLimit(
      user.sub,
      'flag',
      86400, // 24 hours
      this.maxFlagsPerDay,
    );

    // ── Cannot flag own report
    const isOwnReport = await this.isOwnReport(user.sub, reportId);
    if (isOwnReport) {
      throw new BadRequestException('You cannot flag your own report');
    }

    // ── Check already flagged
    const existing = await this.prisma.reportFlag.findUnique({
      where: {
        reportId_flaggedByAuthId: {
          reportId,
          flaggedByAuthId: user.sub,
        },
      },
    });

    if (existing) {
      throw new ConflictException('You have already flagged this report');
    }

    // ── Get lgaId from Redis cache (set when feed.post_created fired)
    let lgaId = await this.redis.get(`report_lga:${reportId}`);

    if (!lgaId || lgaId === 'undefined') {
      try {
        const result = await firstValueFrom(
          this.natsClient.send<{ lgaId: string }>('report.get_lga', { reportId }).pipe(
            timeout(5000),
          ),
        );
        lgaId = result?.lgaId ?? null;

        if (lgaId && lgaId !== 'undefined') {
          await this.redis.set(
            `report_lga:${reportId}`,
            lgaId,
            'EX',
            90 * 24 * 60 * 60,
          );
        }
      } catch (error) {
        this.logger.warn(`Could not fetch LGA for report ${reportId}: ${(error as Error).message}`);
        lgaId = null;
      }
    }

    const counter = await this.prisma.$transaction(async (tx) => {
      await tx.reportFlag.create({
        data: {
          reportId,
          flaggedByAuthId: user.sub,
          reason: dto.reason as any,
          details: dto.details,
          lgaId: lgaId ?? null,
        },
      });

        try {
          return await tx.engagementCounter.update({
            where: { reportId },
            data: { flagCount: { increment: 1 } },
          });
        } catch (err) {
          if ((err as any).code === 'P2025') {
            try {
              return await tx.engagementCounter.create({
                data: { reportId, flagCount: 1 },
              });
            } catch (createErr) {
              if ((createErr as any).code === 'P2002') {
                // Concurrency Trap: Row was created by racing thread — safely update now!
                return await tx.engagementCounter.update({
                  where: { reportId },
                  data: { flagCount: { increment: 1 } },
                });
              }
              throw createErr;
            }
          }
          throw err;
        }
      });

      // ── Invalidate Redis cache hash
      await this.redis.del(`engagement:${reportId}`);

    // ── Auto-escalate if flag threshold reached
    // Rule 9: fire NATS outside transaction
    if (counter.flagCount >= this.flagEscalationThreshold) {
      this.logger.warn(`Report ${reportId} has ${counter.flagCount} flags — escalating to admin`);

      this.natsClient.emit('social.post_reported', {
        reportId,
        flagCount: counter.flagCount,
        latestFlag: {
          reason: dto.reason,
          details: dto.details,
        },
        timestamp: new Date().toISOString(),
      });
    }

    return {
      message: 'Report flagged for review',
      flagCount: counter.flagCount,
    };
  }

  // ============================================================
  // GET FLAGS — Admin moderation queue
  // ============================================================
  async getFlagQueue(user: JwtPayload, page: number = 1, limit: number = 20) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const safePage = !Number.isInteger(page) || page < 1 ? 1 : page;
    const safeLimit = !Number.isInteger(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const whereClause = {
      resolved: false,
      ...(user.role === UserRole.AGENCY_ADMIN && { lgaId: user.lgaId }),
    };

    const [data, total] = await Promise.all([
      this.prisma.reportFlag.findMany({
        where: whereClause,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.reportFlag.count({ where: whereClause }),
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
  // RESOLVE FLAG — Admin closes moderation item
  // ============================================================
  async resolveFlag(
    user: JwtPayload,
    flagId: string,
    dto: ResolveFlagDto,
    ip?: string,
    userAgent?: string,
  ) {
    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const flag = await this.prisma.reportFlag.findUnique({
      where: { id: flagId },
    });

    if (!flag) throw new NotFoundException('Flag not found');
    if (flag.resolved) throw new BadRequestException('Flag already resolved');

    await this.prisma.$transaction(async (tx) => {
      await tx.reportFlag.update({
        where: { id: flagId },
        data: {
          resolved: true,
          resolvedAt: new Date(),
          resolvedByAuthId: user.sub,
          resolution: dto.resolution,
        },
      });

      await tx.socialAuditLog.create({
        data: {
          actorId: user.sub,
          actorRole: user.role,
          action: 'FLAG_RESOLVED',
          targetId: flagId,
          targetType: 'REPORT_FLAG',
          ipAddress: ip,
          userAgent,
          metadata: {
            reportId: flag.reportId,
            resolution: dto.resolution,
            reason: flag.reason,
          },
        },
      });
    });

    return { message: 'Flag resolved successfully' };
  }

  // ============================================================
  // GET ENGAGEMENT — Single source of truth for counts
  // ============================================================
  async getEngagement(reportId: string) {
    const cacheKey = `engagement:${reportId}`;

    // ── Try Redis Hash cache first
    const cached = await this.redis.hgetall(cacheKey);

    if (cached && Object.keys(cached).length > 0) {
      return {
        reportId,
        upvoteCount: parseInt(cached.upvotes || '0', 10),
        commentCount: parseInt(cached.comments || '0', 10),
        repostCount: parseInt(cached.reposts || '0', 10),
        fromCache: true,
      };
    }

    // ── Cache miss — fetch from DB and cache
    const counter = await this.prisma.engagementCounter.findUnique({
      where: { reportId },
    });

    const result = {
      reportId,
      upvoteCount: counter?.upvoteCount ?? 0,
      commentCount: counter?.commentCount ?? 0,
      repostCount: counter?.repostCount ?? 0,
      fromCache: false,
    };

    // ── Populate cache in a unified hash key with 5 minute TTL
    await this.redis.hset(cacheKey, {
      upvotes: result.upvoteCount.toString(),
      comments: result.commentCount.toString(),
      reposts: result.repostCount.toString(),
    });
    await this.redis.expire(cacheKey, 300);

    return result;
  }

  // ============================================================
  // NATS — Handle feed.post_created
  // Cache the reporterAuthId for comment ownership checks
  // ============================================================
  async handleFeedPostCreated(payload: {
    feedPostId: string;
    reportId: string;
    reporterAuthId: string;
    lgaId: string;
    timestamp: string;
  }): Promise<void> {
    // ── Guard: never cache undefined or empty string
    if (!payload.reporterAuthId || payload.reporterAuthId === 'undefined') {
      this.logger.error(
        `feed.post_created missing reporterAuthId for report ${payload.reportId} — ` +
          'own-report protection and comment notifications will be broken. ' +
          'Fix: add reporterAuthId to feed.post_created emit in feed-service.',
      );
      // Still initialize the engagement counter — but skip the ownership cache
      await this.prisma.engagementCounter.upsert({
        where: { reportId: payload.reportId },
        create: { reportId: payload.reportId },
        update: {},
      });
      return;
    }

    // ── Cache report ownership for comment permission checks
    // TTL = 90 days (report lifecycle)
    await Promise.all([
      this.redis.set(
        `report_owner:${payload.reportId}`,
        payload.reporterAuthId,
        'EX',
        90 * 24 * 60 * 60,
      ),
      payload.lgaId
        ? this.redis.set(
            `report_lga:${payload.reportId}`,
            payload.lgaId,
            'EX',
            90 * 24 * 60 * 60,
          )
        : Promise.resolve(),
    ]);

    // ── Initialize engagement counter
    await this.prisma.engagementCounter.upsert({
      where: { reportId: payload.reportId },
      create: { reportId: payload.reportId },
      update: {},
    });

    this.logger.log(
      `Engagement initialized for report: ${payload.reportId}, owner: ${payload.reporterAuthId}`,
    );
  }

  // ============================================================
  // NATS — Handle report status changes
  // When COMPLETED or ARCHIVED — block new comments/upvotes
  // ============================================================
  async handleReportStatusChanged(payload: { reportId: string; status: string }): Promise<void> {
    // ── Cache current status for fast permission checks
    await this.redis.set(
      `report_status:${payload.reportId}`,
      payload.status,
      'EX',
      90 * 24 * 60 * 60,
    );

    this.logger.log(`Report status cached: ${payload.reportId} → ${payload.status}`);
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async enforceRateLimit(
    userId: string,
    action: string,
    ttlSecs: number,
    max: number,
  ): Promise<void> {
    const key = `rate:${action}:${userId}`;
    const count = await this.redis.incr(key);

    if (count === 1) {
      // ── Rule 10: atomic EXPIRE with NX flag
      await (this.redis as any).call('EXPIRE', key, ttlSecs, 'NX');
    }

    if (count > max) {
      throw new BadRequestException(
        `Rate limit exceeded: max ${max} ${action}s per ${ttlSecs === 3600 ? 'hour' : 'day'}`,
      );
    }
  }

  private async assertReportStatus(
    reportId: string,
    allowedStatuses: string[],
    action: string,
  ): Promise<void> {
    let status = await this.redis.get(`report_status:${reportId}`);

    if (!status) {
      // ── Cache miss — fetch from report-service via NATS request-reply
      // TODO: Ensure report-service implements message pattern handler for 'report.get_status'
      try {
        const result = await firstValueFrom(
          this.natsClient.send<{ status: string }>('report.get_status', { reportId }).pipe(
            timeout(5000),
          ),
        );
        status = result?.status ?? null;

        if (status) {
          // Re-cache the fetched status
          await this.redis.set(
            `report_status:${reportId}`,
            status,
            'EX',
            90 * 24 * 60 * 60,
          );
          this.logger.log(`Status re-cached for report ${reportId}: ${status}`);
        }
      } catch (error) {
        this.logger.error(
          `Could not fetch status for report ${reportId}: ${(error as Error).message}`,
        );
      }
    }

    // ── If status still unknown after NATS fetch, deny the action
    // Better to temporarily block than allow engagement on a closed report
    if (!status) {
      throw new BadRequestException(
        `Cannot ${action} this report — status could not be verified. ` +
          'Please try again in a moment.',
      );
    }

    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException(
        `This report cannot be ${action} — current status: ${status}`,
      );
    }
  }

  private async isOwnReport(authId: string, reportId: string): Promise<boolean> {
    let ownerId = await this.redis.get(`report_owner:${reportId}`);

    if (!ownerId || ownerId === 'undefined') {
      // ── Cache miss — fetch from report-service via NATS request-reply
      // TODO: Ensure report-service implements message pattern handler for 'report.get_reporter'
      try {
        const result = await firstValueFrom(
          this.natsClient.send<{ reporterAuthId: string }>('report.get_reporter', { reportId }).pipe(
            timeout(5000),
          ),
        );
        ownerId = result?.reporterAuthId ?? null;

        if (ownerId && ownerId !== 'undefined') {
          // Re-cache the fetched owner
          await this.redis.set(
            `report_owner:${reportId}`,
            ownerId,
            'EX',
            90 * 24 * 60 * 60,
          );
        }
      } catch (error) {
        this.logger.error(
          `Could not fetch owner for report ${reportId}: ${(error as Error).message}`,
        );
        // On failure, conservatively return false (allow the action)
        // Better to allow a self-upvote than block legitimate upvotes
        return false;
      }
    }

    return ownerId === authId;
  }
}
