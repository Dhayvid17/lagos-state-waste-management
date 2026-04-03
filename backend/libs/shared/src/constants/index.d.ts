export declare const JWT_CONSTANTS: {
    readonly ACCESS_EXPIRY: "15m";
    readonly REFRESH_EXPIRY: "7d";
};
export declare const RATE_LIMIT: {
    readonly AUTH_TTL: 60;
    readonly AUTH_LIMIT: 10;
    readonly GLOBAL_TTL: 60;
    readonly GLOBAL_LIMIT: 100;
};
export declare const PAGINATION: {
    readonly DEFAULT_PAGE: 1;
    readonly DEFAULT_LIMIT: 20;
    readonly MAX_LIMIT: 100;
};
export declare const NATS_CONFIG: {
    readonly QUEUE_GROUP: "lagos-waste-queue";
};
export declare const ROLE_PERMISSIONS: {
    readonly CITIZEN: readonly ["read:own_reports", "write:reports"];
    readonly COLLECTOR: readonly ["read:assigned_routes", "execute:route_completion"];
    readonly AGENCY_ADMIN: readonly ["read:lga_reports", "execute:verify_report"];
    readonly SYS_ADMIN: readonly ["read:audit_logs", "execute:ban_user", "admin:all"];
};
