import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
// PrismaClient is handled by PrismaService which extends it
import { JwtPayload, LagosLGA, PaginatedResponse, UserRole } from '@app/shared';
import { CreateProfileDto } from './dto/create-profile.dto';
import type { UpdateProfileDto, UpdateLocationDto } from './dto/update-profile.dto';
import { PrismaService } from './prisma/prisma.service';
import { UserProfile } from './generated/prisma/client';
import type Redis from 'ioredis';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  // ============================================================
  // NATS EVENT HANDLER — Create profile automatically
  // ============================================================
  async createProfileFromEvent(payload: CreateProfileDto) {
    // Idempotent — if profile already exists, skip silently
    const existing = await this.prisma.userProfile.findUnique({
      where: { authId: payload.authId },
    });

    if (existing) {
      this.logger.warn(`Profile already exists for authId: ${payload.authId}`);
      return existing;
    }

    // Scaffold new profile with defaults — user can update via PATCH /users/me
    const profile = await this.prisma.userProfile.create({
      data: {
        authId: payload.authId,
        firstName: null, // Scaffolding: user fills via profile completion
        lastName: null, // Scaffolding: user fills via profile completion
        phoneNumber: payload.phoneNumber ?? null,
        metadata: { registeredAt: payload.timestamp },
      },
    });

    this.logger.log(`Profile scaffolded for authId: ${payload.authId}`);
    return profile;
  }

  // ============================================================
  // GET OWN PROFILE
  // ============================================================
  async getMyProfile(user: JwtPayload) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId: user.sub },
    });

    if (!profile) {
      throw new NotFoundException('Profile not found. Please try again shortly.');
    }

    return profile;
  }

  // ============================================================
  // UPDATE OWN PROFILE
  // ============================================================
  async updateMyProfile(user: JwtPayload, dto: UpdateProfileDto) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId: user.sub },
    });

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    // ── Single transaction — both updates succeed or both rollback
    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Update profile fields
      const updatedProfile = await tx.userProfile.update({
        where: { authId: user.sub },
        data: {
          ...dto,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          lastProfileUpdate: new Date(),
        },
      });

      // 2. Recalculate and update completeness in same transaction
      const completeness = this.calculateCompleteness(updatedProfile);

      return tx.userProfile.update({
        where: { authId: user.sub },
        data: {
          profileCompleteness: completeness,
          isProfileComplete: completeness === 100,
        },
      });
    });

    return updated;
  }

  // ============================================================
  // GET PUBLIC PROFILE
  // ============================================================
  async getPublicProfile(profileId: string, viewerIp: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        firstName: true, // Note: Can be null if profile is not yet completed
        lastName: true, // Note: Can be null if profile is not yet completed
        avatarUrl: true,
        bio: true,
        lgaId: true,
        city: true,
        isVerified: true,
        badges: true,
        totalPointsEarned: true,
        profileCompleteness: true,
        createdAt: true,
        // ── Never expose sensitive fields publicly
        // authId, phoneNumber, ndpa fields, fcmTokens etc. NOT included
      },
    });

    if (!profile) throw new NotFoundException('Profile not found');

    // ── Redis view deduplication
    // One view per IP per profile per hour
    const viewKey = `profile_view:${profileId}:${viewerIp}`;
    const alreadyViewed = await this.redis.get(viewKey);

    if (!alreadyViewed) {
      // Mark as viewed — expires after 1 hour
      await this.redis.set(viewKey, '1', 'EX', 60 * 60);

      // Increment view count only for unique views
      await this.prisma.userProfile.update({
        where: { id: profileId },
        data: { profileViews: { increment: 1 } },
      });
    }

    return profile;
  }

  // ============================================================
  // LIST ALL USERS — SYS_ADMIN only
  // ============================================================
  async getAllUsers(
    user: JwtPayload,
    page: number = 1,
    limit: number = 20,
    lgaId?: LagosLGA,
  ): Promise<PaginatedResponse> {
    // ── Defensive checks (Never trust the controller)
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    if (user.role !== UserRole.SYS_ADMIN && user.role !== UserRole.AGENCY_ADMIN) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // AGENCY_ADMIN can only see users in their own LGA
    const whereClause: any = {};
    if (user.role === UserRole.AGENCY_ADMIN) {
      whereClause.lgaId = user.lgaId;
    } else if (lgaId) {
      whereClause.lgaId = lgaId;
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          authId: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          lgaId: true,
          kycStatus: true,
          isVerified: true,
          totalPointsEarned: true,
          createdAt: true,
        },
      }),
      this.prisma.userProfile.count({ where: whereClause }),
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
  // UPDATE KYC STATUS — AGENCY_ADMIN only
  // ============================================================
  async updateKycStatus(
    actor: JwtPayload,
    profileId: string,
    status: 'VERIFIED' | 'REJECTED',
    reason?: string,
    ip?: string,
    userAgent?: string,
  ) {
    if (actor.role !== UserRole.AGENCY_ADMIN && actor.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only Agency Admins can verify KYC');
    }

    // ── Transaction wraps both the update and audit log
    const updated = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.userProfile.findUnique({
        where: { id: profileId },
      });

      if (!profile) throw new NotFoundException('Profile not found');

      // AGENCY_ADMIN can only verify users in their LGA
      if (actor.role === UserRole.AGENCY_ADMIN && profile.lgaId !== actor.lgaId) {
        throw new ForbiddenException('You can only verify users in your LGA');
      }

      // ── Prevent re-verifying already verified profiles
      if (profile.kycStatus === 'VERIFIED' && status === 'VERIFIED') {
        throw new BadRequestException('Profile is already verified');
      }

      // ── Prevent re-rejecting already rejected profiles
      if (profile.kycStatus === 'REJECTED' && status === 'REJECTED') {
        throw new BadRequestException('Profile is already rejected');
      }

      // 1. Update KYC status
      const updatedProfile = await tx.userProfile.update({
        where: { id: profileId },
        data: {
          kycStatus: status,
          kycVerifiedAt: status === 'VERIFIED' ? new Date() : null,
          kycRejectedReason: status === 'REJECTED' ? (reason ?? null) : null,
          isVerified: status === 'VERIFIED',
        },
      });

      // 2. Write audit log in same transaction
      await tx.auditLog.create({
        data: {
          actorId: actor.sub,
          actorRole: actor.role,
          action: `KYC_${status}`,
          targetId: profileId,
          targetType: 'USER_PROFILE',
          ipAddress: ip ?? null,
          userAgent: userAgent ?? null,
          metadata: { reason: reason ?? null },
        },
      });

      return updatedProfile;
    });

    // Log the KYC action with details
    this.logger.log(`KYC ${status} for profile ${profileId} by ${actor.sub}`);
    return updated;
  }

  // ============================================================
  // FCM TOKEN MANAGEMENT
  // ============================================================
  async addFcmToken(user: JwtPayload, token: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId: user.sub },
    });

    if (!profile) throw new NotFoundException('Profile not found');

    // ── Already registered
    if (profile.fcmTokens.includes(token)) {
      return { message: 'FCM token already registered' };
    }

    // ── Cap at 5 devices — remove oldest if limit reached
    const updatedTokens = [...profile.fcmTokens, token];
    if (updatedTokens.length > 5) {
      updatedTokens.shift(); // Remove oldest token
      this.logger.warn(`FCM token cap reached for user ${user.sub} — oldest removed`);
    }

    await this.prisma.userProfile.update({
      where: { authId: user.sub },
      data: { fcmTokens: updatedTokens },
    });

    return { message: 'FCM token registered successfully' };
  }

  async removeFcmToken(user: JwtPayload, token: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId: user.sub },
    });

    if (!profile) throw new NotFoundException('Profile not found');

    await this.prisma.userProfile.update({
      where: { authId: user.sub },
      data: {
        fcmTokens: profile.fcmTokens.filter((t) => t !== token),
      },
    });

    return { message: 'FCM token removed successfully' };
  }

  // ============================================================
  // NATS MESSAGE HANDLERS — Logic for cross-service requests
  // ============================================================

  /**
   * Internal method called via NATS to resolve contact info for notifications.
   * Pattern: 'user.get_contact'
   */
  async getContactInfo(authId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId },
      select: { phoneNumber: true, fcmTokens: true },
    });

    if (!profile) return null;

    // ── Rule 14: Data Fragmentation Resolve
    // The email is stored in auth-service (MongoDB), while profile is here in postgres.
    // We must ask auth-service for the email.
    let email = '';
    try {
      email = await firstValueFrom(
        this.natsClient.send('auth.get_email', { authId }).pipe(timeout(3000)),
      );
    } catch (error) {
      this.logger.error(`Failed to resolve email from auth-service: ${(error as Error).message}`);
    }

    return {
      email: email || '',
      phoneNumber: profile.phoneNumber,
      fcmTokens: profile.fcmTokens,
    };
  }

  /**
   * Internal method called via NATS to remove invalid FCM tokens in batch.
   */
  async handleRemoveFcmTokens(authId: string, tokens: string[]) {
    this.logger.log(`Removing ${tokens.length} invalid FCM tokens for user ${authId}`);
    try {
      const profile = await this.prisma.userProfile.findUnique({
        where: { authId },
        select: { fcmTokens: true },
      });

      if (!profile) return;

      await this.prisma.userProfile.update({
        where: { authId },
        data: {
          fcmTokens: {
            set: profile.fcmTokens.filter((t) => !tokens.includes(t)),
          },
        },
      });
    } catch (error) {
      this.logger.error(`Failed to remove tokens for ${authId}: ${(error as Error).message}`);
    }
  }

  // ============================================================
  // UPDATE LOCATION
  // ============================================================
  async updateLocation(user: JwtPayload, dto: UpdateLocationDto) {
    await this.prisma.userProfile.update({
      where: { authId: user.sub },
      data: {
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    });

    return { message: 'Location updated successfully' };
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  private calculateCompleteness(profile: UserProfile): number {
    const fields: (keyof UserProfile)[] = [
      'firstName',
      'lastName',
      'avatarUrl',
      'bio',
      'dateOfBirth',
      'gender',
      'phoneNumber',
      'lgaId',
      'address',
      'city',
    ];

    const filled = fields.filter((f) => {
      const val = profile[f];
      return val !== null && val !== undefined && val !== '';
    }).length;
    
    return Math.round((filled / fields.length) * 100);
  }
}
