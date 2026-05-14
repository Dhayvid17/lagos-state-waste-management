import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Model } from 'mongoose';
import { JwtPayload } from '@app/shared';
import { User, UserDocument } from '../schemas/user.schema.js';
import { UserStatus } from '@app/shared';
import { TokenBlocklistService } from '../blocklist/token-blocklist.service.js';
import Redis from 'ioredis';

@Injectable()
// Validate access tokens on protected routes except public routes
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt-access') {
  constructor(
    private readonly configService: ConfigService,
    private readonly tokenBlocklist: TokenBlocklistService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('auth.jwt.accessSecret')!,
      passReqToCallback: true, // we need access to original request to extract the raw token string and verify it in database
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<JwtPayload> {
    // Extract raw token string from Authorization header
    const rawToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req);

    // Hard stop for 2FA pending tokens (Defense in Depth)
    // Even if secrets are accidentally shared, a pending token can NEVER access protected routes
    if ((payload as any).type === '2fa_pending') {
      throw new UnauthorizedException('2FA verification required. Please complete login.');
    }

    // Check if token is in blocklist (e.g. after logout or password change)
    if (!rawToken) {
      throw new UnauthorizedException('No token provided');
    }
    const isBlocked = await this.tokenBlocklist.isBlocked(rawToken);
    if (isBlocked) {
      throw new UnauthorizedException('Token has been revoked. Please log in again.');
    }

    // Try to get from Redis cache first
    const cacheKey = `user_status:${payload.sub}`;
    let userStr: string | null = null;
    
    try {
      userStr = await this.redis.get(cacheKey);
    } catch (err) {
      // Fail open if Redis is down
    }

    let user;
    if (userStr) {
      user = JSON.parse(userStr);
    } else {
      // Find user in database to verify they still exist and are active
      user = await this.userModel
        .findById(payload.sub)
        .select('status role permissions lgaId')
        .lean();

      if (!user) {
        throw new UnauthorizedException('User no longer exists');
      }

      // Cache the subset of user data for 30 seconds
      try {
        await this.redis.set(cacheKey, JSON.stringify(user), 'EX', 30);
      } catch (err) {
        // Fail open if Redis is down
      }
    }

    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException(`Account is ${user.status.toLowerCase()}. Contact support.`);
    }

    // Return enriched payload — attached to request.user
    return {
      sub: payload.sub,
      email: payload.email,
      role: user.role,
      permissions: user.permissions as any,
      lgaId: user.lgaId as any,
    };
  }

  // ── Call this method from AuthService when user is banned, suspended, or role changes
  async invalidateUserCache(userId: string): Promise<void> {
    try {
      await this.redis.del(`user_status:${userId}`);
    } catch (err) {
      // Fail open
    }
  }
}
