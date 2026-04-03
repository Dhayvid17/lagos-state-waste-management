"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_PERMISSIONS = exports.NATS_CONFIG = exports.PAGINATION = exports.RATE_LIMIT = exports.JWT_CONSTANTS = void 0;
exports.JWT_CONSTANTS = {
    ACCESS_EXPIRY: '15m',
    REFRESH_EXPIRY: '7d',
};
exports.RATE_LIMIT = {
    AUTH_TTL: 60,
    AUTH_LIMIT: 10,
    GLOBAL_TTL: 60,
    GLOBAL_LIMIT: 100,
};
exports.PAGINATION = {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
};
exports.NATS_CONFIG = {
    QUEUE_GROUP: 'lagos-waste-queue',
};
exports.ROLE_PERMISSIONS = {
    CITIZEN: ['read:own_reports', 'write:reports'],
    COLLECTOR: ['read:assigned_routes', 'execute:route_completion'],
    AGENCY_ADMIN: ['read:lga_reports', 'execute:verify_report'],
    SYS_ADMIN: ['read:audit_logs', 'execute:ban_user', 'admin:all'],
};
//# sourceMappingURL=index.js.map