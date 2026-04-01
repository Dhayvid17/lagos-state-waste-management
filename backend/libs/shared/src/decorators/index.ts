import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission, UserRole } from '../enums/index.js';
import { JwtPayload } from '../interfaces/index.js';
import { Request } from 'express';

export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';
export const IS_PUBLIC_KEY = 'isPublic';

// ── Mark a route as public (skip JWT guard)
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

// ── Require specific roles
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

// ── Require specific permissions
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

// ── Extract current user from request
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as JwtPayload;
  },
);
