export enum UserRole {
  CITIZEN = 'CITIZEN',
  COLLECTOR = 'COLLECTOR',
  AGENCY_ADMIN = 'AGENCY_ADMIN',
  SYS_ADMIN = 'SYS_ADMIN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLOCKED = 'BLOCKED',
}

export enum Permission {
  // Citizen
  READ_OWN_REPORTS = 'read:own_reports',
  WRITE_REPORTS = 'write:reports',

  // Collector
  READ_ASSIGNED_ROUTES = 'read:assigned_routes',
  EXECUTE_ROUTE = 'execute:route_completion',

  // Agency Admin
  READ_LGA_REPORTS = 'read:lga_reports',
  VERIFY_REPORT = 'execute:verify_report',

  // Sys Admin
  READ_AUDIT_LOGS = 'read:audit_logs',
  BAN_USER = 'execute:ban_user',
  ADMIN_ALL = 'admin:all',
}

export enum ReportStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  ASSIGNED = 'ASSIGNED',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
}

export enum WasteType {
  GENERAL = 'GENERAL',
  RECYCLABLE = 'RECYCLABLE',
  HAZARDOUS = 'HAZARDOUS',
  ORGANIC = 'ORGANIC',
  ELECTRONIC = 'ELECTRONIC',
}

export enum KycStatus {
  NOT_SUBMITTED = 'NOT_SUBMITTED',
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

export enum Theme {
  LIGHT = 'light',
  DARK = 'dark',
  AUTO = 'auto',
}

export enum NatsEvents {
  // Report events
  REPORT_CREATED = 'report.created',
  REPORT_VERIFIED = 'report.verified',
  REPORT_ASSIGNED = 'report.assigned',
  REPORT_COMPLETED = 'report.completed',

  // Payment events
  PAYMENT_SUCCESS = 'payment.success',
  PAYMENT_FAILED = 'payment.failed',

  // User events
  USER_CREATED = 'user.created',
  USER_BANNED = 'user.banned',

  // Notification events
  SEND_SMS = 'notification.send_sms',
  SEND_EMAIL = 'notification.send_email',
}

export enum LagosLGA {
  AGEGE = 'AGEGE',
  AJEROMI = 'AJEROMI',
  ALIMOSHO = 'ALIMOSHO',
  AMUWO_ODOFIN = 'AMUWO_ODOFIN',
  APAPA = 'APAPA',
  BADAGRY = 'BADAGRY',
  EPE = 'EPE',
  ETI_OSA = 'ETI_OSA',
  IBEJU_LEKKI = 'IBEJU_LEKKI',
  IFAKO_IJAIYE = 'IFAKO_IJAIYE',
  IKEJA = 'IKEJA',
  IKORODU = 'IKORODU',
  KOSOFE = 'KOSOFE',
  LAGOS_ISLAND = 'LAGOS_ISLAND',
  LAGOS_MAINLAND = 'LAGOS_MAINLAND',
  MUSHIN = 'MUSHIN',
  OJO = 'OJO',
  OSHODI_ISOLO = 'OSHODI_ISOLO',
  SHOMOLU = 'SHOMOLU',
  SURULERE = 'SURULERE',
}
