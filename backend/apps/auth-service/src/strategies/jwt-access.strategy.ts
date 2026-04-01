import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Model } from 'mongoose';
import { JwtPayload } from '@app/shared';
import { User, UserDocument } from '../schemas/user.schema.js';
import { UserStatus } from '@app/shared';
import { TokenBlocklistService } from '../blocklist/token-blocklist.service.js';

@Injectable()
// Validate access tokens on protected routes except public routes
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt-access') {
  constructor(
    private readonly configService: ConfigService,
    private readonly tokenBlocklist: TokenBlocklistService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
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

    // Check if token is in blocklist (e.g. after logout or password change)
    if (!rawToken) {
      throw new UnauthorizedException('No token provided');
    }
    const isBlocked = await this.tokenBlocklist.isBlocked(rawToken);
    if (isBlocked) {
      throw new UnauthorizedException('Token has been revoked. Please log in again.');
    }

    // Find user in database to verify they still exist and are active
    const user = await this.userModel
      .findById(payload.sub)
      .select('status role permissions lgaId')
      .lean();

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
}
