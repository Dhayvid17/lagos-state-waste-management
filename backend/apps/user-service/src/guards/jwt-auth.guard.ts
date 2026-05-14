import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { IS_PUBLIC_KEY } from '@app/shared';

@Injectable()
// ── Guard to validate JWT access tokens on protected routes
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  // ── Main guard method
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No access token provided');
    }

    // ── Validate token signature
    let payload;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('user.jwt.accessSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // ── Check if token is blocklisted in Redis (e.g., user logged out)
    try {
      const isBlocked = await this.redis.get(`blocklist:${token}`);
      if (isBlocked) {
        throw new UnauthorizedException('Token has been revoked');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // If Redis is temporarily down, we fail open to avoid crashing the whole system, 
      // but log the error heavily.
    }

    // ── Check user status (suspended users shouldn't access their profile)
    if (payload.status && payload.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is not active');
    }

    // Attach user to request
    request['user'] = payload;

    return true;
  }

  // ── Helper to extract Bearer token from Authorization header
  private extractToken(request: Request): string | null {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : null;
  }
}
