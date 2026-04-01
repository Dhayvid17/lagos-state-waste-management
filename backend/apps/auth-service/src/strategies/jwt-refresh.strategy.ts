import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { Model } from 'mongoose';
import { JwtPayload } from '@app/shared';
import { User, UserDocument } from '../schemas/user.schema.js';

@Injectable()
// Validate refresh tokens when user wants new access token(refresh token is stored in database)
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(
    private readonly configService: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    super({
      // HYBRID APPROACH: Extract JWT from cookies and If not then body (for mobile clients)
      jwtFromRequest: ExtractJwt.fromExtractors([
        // First try httpOnly cookie
        (req: Request) => req?.cookies?.refresh_token ?? null,
        // Fallback to body (mobile clients)
        ExtractJwt.fromBodyField('refreshToken'),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('auth.jwt.refreshSecret')!,
      passReqToCallback: true, // we need access to original request to extract the raw token string and verify it in database
    });
  }

  // After refresh token is verified, validate refresh token
  // Check if token exists in DB which allows us to revoke tokens(logout) and logout all devices(clear all refresh tokens)
  async validate(req: Request, payload: JwtPayload) {
    // Extract raw refresh token from cookie or body
    const rawToken = req.cookies?.refresh_token ?? req.body?.refreshToken;

    if (!rawToken) {
      throw new UnauthorizedException('Refresh token not provided');
    }

    // Find user and check if refresh token exists in the refreshTokens array
    const user = await this.userModel.findById(payload.sub).select('+deviceRefreshTokens').lean();

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return { ...payload, rawRefreshToken: rawToken };
  }
}
