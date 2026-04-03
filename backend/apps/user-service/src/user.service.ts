import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JwtPayload, LagosLGA, PaginatedResponse, UserRole } from '@app/shared';
import { CreateProfileDto } from './dto/create-profile.dto.js';
import type { UpdateProfileDto, UpdateLocationDto } from './dto/update-profile.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(private readonly prisma: PrismaService) {}

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
        firstName: '', // Empty — user fills via PATCH /users/me
        lastName: '', // Empty — user fills via PATCH /users/me
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

    // Calculate profile completeness after update
    const updated = await this.prisma.userProfile.update({
      where: { authId: user.sub },
      data: {
        ...dto,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        lastProfileUpdate: new Date(),
      },
    });

    // Recalculate completeness
    const completeness = this.calculateCompleteness(updated);
    await this.prisma.userProfile.update({
      where: { authId: user.sub },
      data: {
        profileCompleteness: completeness,
        isProfileComplete: completeness === 100,
      },
    });

    return { ...updated, profileCompleteness: completeness };
  }

  // ============================================================
  // GET PUBLIC PROFILE
  // ============================================================
  async getPublicProfile(profileId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
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

    // Increment profile views
    await this.prisma.userProfile.update({
      where: { id: profileId },
      data: { profileViews: { increment: 1 } },
    });

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
  ) {
    if (actor.role !== UserRole.AGENCY_ADMIN && actor.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only Agency Admins can verify KYC');
    }

    const profile = await this.prisma.userProfile.findUnique({
      where: { id: profileId },
    });

    if (!profile) throw new NotFoundException('Profile not found');

    // AGENCY_ADMIN can only verify users in their LGA
    if (actor.role === UserRole.AGENCY_ADMIN && profile.lgaId !== actor.lgaId) {
      throw new ForbiddenException('You can only verify users in your LGA');
    }

    const updated = await this.prisma.userProfile.update({
      where: { id: profileId },
      data: {
        kycStatus: status,
        kycVerifiedAt: status === 'VERIFIED' ? new Date() : null,
        kycRejectedReason: status === 'REJECTED' ? reason : null,
        isVerified: status === 'VERIFIED',
      },
    });

    // Write to audit log
    await this.prisma.auditLog.create({
      data: {
        actorId: actor.sub,
        actorRole: actor.role,
        action: `KYC_${status}`,
        targetId: profileId,
        targetType: 'USER_PROFILE',
        metadata: { reason: reason ?? null },
      },
    });

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

    // Avoid duplicates — only add if not already present
    if (!profile.fcmTokens.includes(token)) {
      await this.prisma.userProfile.update({
        where: { authId: user.sub },
        data: { fcmTokens: { push: token } },
      });
    }

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
  private calculateCompleteness(profile: any): number {
    const fields = [
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

    const filled = fields.filter((f) => profile[f] !== null && profile[f] !== '').length;
    return Math.round((filled / fields.length) * 100);
  }
}
