import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { UserRole, UserStatus } from '@app/shared';

// ── Sub-document: one active device session
export interface DeviceRefreshToken {
  tokenFamily: string; // Unique family ID per device login
  tokenHash: string; // Hashed refresh token (never store raw)
  deviceName: string; // e.g. "Chrome on Windows"
  deviceIp: string;
  issuedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
}

export type UserDocument = User & Document;

@Schema({
  timestamps: true,
  collection: 'users',
})
export class User {
  // ============================================================
  // AUTHENTICATION CREDENTIALS
  // ============================================================

  @Prop({
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  })
  email: string;

  @Prop({
    required: true,
    select: false, // Never returned in queries accidentally
  })
  passwordHash: string; // bcrypt hash — NEVER raw password

  @Prop({
    unique: true,
    sparse: true, // Allows multiple nulls (not all users have phone)
    trim: true,
  })
  phoneNumber?: string; // Strictly +234XXXXXXXXXX format

  // ============================================================
  // ROLE & PERMISSIONS
  // ============================================================

  @Prop({
    type: String,
    enum: UserRole,
    default: UserRole.CITIZEN,
    index: true,
  })
  role: UserRole;

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({
    type: String,
    default: null,
  })
  lgaId?: string; // Required for AGENCY_ADMIN — must match one of 20 Lagos LGAs

  // ============================================================
  // ACCOUNT STATUS
  // ============================================================

  @Prop({
    type: String,
    enum: UserStatus,
    default: UserStatus.ACTIVE,
    index: true,
  })
  status: UserStatus;

  @Prop()
  blockedReason?: string;

  @Prop()
  suspendedUntil?: Date;

  // ============================================================
  // EMAIL VERIFICATION
  // ============================================================

  @Prop({ default: false })
  isEmailVerified: boolean;

  @Prop({ select: false })
  emailVerificationToken?: string;

  @Prop()
  emailVerificationExpires?: Date;

  // ============================================================
  // PHONE VERIFICATION
  // ============================================================

  @Prop({ default: false })
  isPhoneVerified: boolean;

  @Prop({ select: false })
  phoneVerificationCode?: string;

  @Prop()
  phoneVerificationExpires?: Date;

  // ============================================================
  // PASSWORD RESET
  // ============================================================

  @Prop({ select: false })
  passwordResetToken?: string;

  @Prop()
  passwordResetExpires?: Date;

  @Prop()
  lastPasswordChangedAt?: Date;

  // ============================================================
  // TWO-FACTOR AUTHENTICATION (TOTP — Google Authenticator)
  // ============================================================

  @Prop({ default: false })
  twoFactorEnabled: boolean;

  @Prop({ select: false })
  twoFactorSecret?: string;

  @Prop({ type: [String], select: false, default: [] })
  backupCodes?: string[]; // Hashed one-time use backup codes

  // ============================================================
  // SESSION & DEVICE MANAGEMENT
  // ============================================================

  @Prop()
  lastLoginAt?: Date;

  @Prop()
  lastLoginIp?: string;

  @Prop({ default: 0 })
  failedLoginAttempts: number;

  @Prop()
  accountLockedUntil?: Date; // Auto-lock after 5 failed attempts

  // Array of active device sessions — enables "logout all other devices"
  @Prop({
    type: [
      {
        tokenFamily: { type: String, required: true },
        tokenHash: { type: String, required: true, select: false },
        deviceName: { type: String, default: 'Unknown device' },
        deviceIp: { type: String, required: true },
        issuedAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        lastUsedAt: { type: Date, required: true },
      },
    ],
    default: [],
    select: false,
  })
  deviceRefreshTokens: DeviceRefreshToken[];

  // ============================================================
  // NDPA COMPLIANCE (Nigerian Data Protection Act — MANDATORY)
  // ============================================================

  @Prop({ default: false })
  ndpaConsentGiven: boolean;

  @Prop()
  ndpaConsentTimestamp?: Date;

  @Prop()
  ndpaConsentIp?: string;

  // ============================================================
  // METADATA
  // ============================================================

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const UserSchema = SchemaFactory.createForClass(User);

// ============================================================
// INDEXES
// ============================================================
UserSchema.index({ createdAt: -1 });
UserSchema.index({ 'deviceRefreshTokens.tokenFamily': 1 }); // Fast device lookup
UserSchema.index({ accountLockedUntil: 1 }); // TTL cleanup queries
UserSchema.index({ 'deviceRefreshTokens.expiresAt': 1 }, { expireAfterSeconds: 0 }); // Auto-remove expired device sessions — MongoDB handles this natively with a TTL index on the expiresAt field. We just need to ensure that expired tokens are cleaned up regularly (e.g. via a daily cron job) to prevent database bloat.

// ============================================================
// JSON CLEANUP
// ============================================================
UserSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    delete ret.__v;
    delete ret.passwordHash; // Extra safety net
    delete ret.twoFactorSecret;
    delete ret.deviceRefreshTokens;
    delete ret.backupCodes;
    return ret;
  },
});
