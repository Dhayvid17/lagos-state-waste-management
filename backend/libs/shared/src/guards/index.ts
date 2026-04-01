import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Permission, UserRole } from '../enums/index.js';
import { JwtPayload } from '../interfaces/index.js';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, ROLES_KEY } from '../decorators/index.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if route is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as JwtPayload;

    if (!user) throw new ForbiddenException('No user found in request');

    // SYS_ADMIN bypasses all checks
    if (user.role === UserRole.SYS_ADMIN) return true;

    if (requiredRoles?.length) {
      const hasRole = requiredRoles.includes(user.role);
      if (!hasRole)
        throw new ForbiddenException(`Role '${user.role}' is not allowed to access this resource`);
    }

    if (requiredPermissions?.length) {
      const hasPermission = requiredPermissions.every((p) => user.permissions.includes(p));
      if (!hasPermission) throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
