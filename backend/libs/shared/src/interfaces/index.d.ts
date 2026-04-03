import { UserRole, Permission, LagosLGA } from '../enums/index.js';
export interface JwtPayload {
    sub: string;
    email: string;
    role: UserRole;
    permissions: Permission[];
    lgaId?: LagosLGA;
    iat?: number;
    exp?: number;
}
export interface NatsEventPayload<T = unknown> {
    event: string;
    data: T;
    timestamp: string;
    traceId: string;
}
export interface ApiResponse<T = unknown> {
    success: boolean;
    statusCode: number;
    message: string;
    data?: T;
    timestamp: string;
    path?: string;
}
export interface PaginatedResponse<T = unknown> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}
export interface GeoLocation {
    latitude: number;
    longitude: number;
    address?: string;
    lgaId?: LagosLGA;
}
declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload;
        }
    }
}
