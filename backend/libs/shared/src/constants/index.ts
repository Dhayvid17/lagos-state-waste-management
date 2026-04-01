export const JWT_CONSTANTS = {
  ACCESS_EXPIRY: '15m',
  REFRESH_EXPIRY: '7d',
} as const;

export const RATE_LIMIT = {
  AUTH_TTL: 60, // seconds
  AUTH_LIMIT: 10, // max requests per TTL
  GLOBAL_TTL: 60,
  GLOBAL_LIMIT: 100,
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const NATS_CONFIG = {
  QUEUE_GROUP: 'lagos-waste-queue',
} as const;

export const ROLE_PERMISSIONS = {
  CITIZEN: ['read:own_reports', 'write:reports'],
  COLLECTOR: ['read:assigned_routes', 'execute:route_completion'],
  AGENCY_ADMIN: ['read:lga_reports', 'execute:verify_report'],
  SYS_ADMIN: ['read:audit_logs', 'execute:ban_user', 'admin:all'],
} as const;
