import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Request } from 'express';

import { JwtPayload, NatsEvents, UserRole, UserStatus, ROLE_PERMISSIONS } from '@app/shared';

import { User, UserDocument, DeviceRefreshToken } from './schemas/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  VerifyEmailDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from './dto/verify-email.dto';
import { TwoFactorDto } from './dto/login.dto';
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import { TokenBlocklistService } from './blocklist/token-blocklist.service';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tokenBlocklist: TokenBlocklistService,
    @Inject('NATS_SERVICE') private readonly natsClient: ClientProxy,
  ) {}

  // ============================================================
  // REGISTER
  // ============================================================
  async register(dto: RegisterDto, req: Request) {
    // 1. Check NDPA consent — Nigerian law requires explicit consent
    if (!dto.ndpaConsent) {
      throw new BadRequestException('You must accept the data privacy policy to create an account');
    }

    // 2. Check if email already exists
    const existingUser = await this.userModel.findOne({
      email: dto.email.toLowerCase().trim(),
    });

    if (existingUser) {
      throw new ConflictException('An account with this email already exists');
    }

    // 3. Hash password
    const rounds = this.configService.get<number>('auth.security.bcryptRounds')!;
    const passwordHash = await bcrypt.hash(dto.password, rounds);

    // 4. Generate email verification token
    const rawEmailToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationToken = this.hashToken(rawEmailToken);
    const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // 5. Assign default permissions based on role
    // Hardcoded to CITIZEN to prevent privilege escalation
    const role = UserRole.CITIZEN;
    const permissions = [...ROLE_PERMISSIONS[role]];

    // ── Start MongoDB session for atomic operation
    const session = await this.userModel.db.startSession();
    let user: any;

    try {
      session.startTransaction();
      // 6. Create user
      const [createdUser] = await this.userModel.create(
        [
          {
            email: dto.email.toLowerCase().trim(),
            passwordHash,
            phoneNumber: dto.phoneNumber,
            role,
            permissions,
            emailVerificationToken,
            emailVerificationExpires,
            ndpaConsentGiven: true,
            ndpaConsentTimestamp: new Date(),
            ndpaConsentIp: req.ip,
          },
        ],
        { session },
      );
      user = createdUser;

      // 7. Commit database changes
      await session.commitTransaction();
      this.logger.log(`New user registered in DB: ${user.email} [${role}]`);
    } catch (error) {
      // ── Rollback DB if creation failed
      await session.abortTransaction();
      if (error instanceof ConflictException) throw error;
      this.logger.error(`Registration DB transaction failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Registration failed. Please try again.');
    } finally {
      // ── Always end session whether success or failure
      await session.endSession();
    }

    // 8. Fire NATS event OUTSIDE transaction
    // If this fails, the user is still created successfully.
    try {
      await this.natsClient
        .emit(NatsEvents.USER_CREATED, {
          authId: String(user._id),
          email: user.email,
          role: user.role,
          phoneNumber: user.phoneNumber,
          // TODO: Send rawEmailToken in the NATS payload so the notification-service can generate the clickable link
          // emailVerificationToken: rawEmailToken,
        })
        .toPromise();
      this.logger.log(`NATS event fired: ${NatsEvents.USER_CREATED}`);
    } catch (natsError) {
      this.logger.error(
        `NATS emit failed after user creation — manual reconciliation may be needed: ${
          (natsError as Error).message
        }`,
      );
    }

    return {
      message: 'Registration successful. Please verify your email.',
      userId: String(user._id),
    };
  }

  // ============================================================
  // LOGIN
  // ============================================================
  async login(dto: LoginDto, req: Request) {
    const maxAttempts = this.configService.get<number>('auth.security.maxFailedAttempts')!;
    const lockMins = this.configService.get<number>('auth.security.lockDurationMins')!;

    // 1. Find user — explicitly select passwordHash
    const user = await this.userModel
      .findOne({ email: dto.email.toLowerCase().trim() })
      .select('+passwordHash +deviceRefreshTokens');

    if (!user) {
      // Generic message — don't reveal if email exists
      throw new UnauthorizedException('Invalid email or password');
    }

    // 2. Check if account is locked
    if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
      const unlockTime = user.accountLockedUntil.toISOString();
      throw new ForbiddenException(
        `Account locked due to too many failed attempts. Try again after ${unlockTime}`,
      );
    }

    // 3. Check account status
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException(
        `Account is ${user.status.toLowerCase()}. ${user.blockedReason ?? 'Contact support.'}`,
      );
    }

    // 4. Verify password
    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);

    if (!isPasswordValid) {
      // Increment failed attempts
      const newAttempts = (user.failedLoginAttempts ?? 0) + 1;
      const updateData: Partial<UserDocument> = { failedLoginAttempts: newAttempts } as any;

      if (newAttempts >= maxAttempts) {
        updateData.accountLockedUntil = new Date(Date.now() + lockMins * 60 * 1000);
        this.logger.warn(`Account locked: ${user.email} after ${newAttempts} failed attempts`);
      }

      await this.userModel.updateOne({ _id: user._id }, updateData);
      throw new UnauthorizedException('Invalid email or password');
    }

    // 5. Reset failed attempts on successful login
    await this.userModel.updateOne(
      { _id: user._id },
      {
        failedLoginAttempts: 0,
        accountLockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: req.ip,
      },
    );

    // 6. Check if 2FA is enabled
    if (user.twoFactorEnabled) {
      const tempToken = this.generateTempToken(String(user._id));
      return { requiresTwoFactor: true, tempToken };
    }

    // 7. Generate tokens
    const tokens = await this.generateTokenPair(
      user,
      req.ip ?? 'unknown',
      dto.deviceName ?? 'Unknown device',
    );

    this.logger.log(`User logged in: ${user.email}`);
    return tokens;
  }

  // ============================================================
  // REFRESH TOKENS
  // ============================================================
  async refreshTokens(userId: string, rawToken: string, ip: string, deviceName: string) {
    const user = await this.userModel.findById(userId).select('+deviceRefreshTokens');

    if (!user) throw new UnauthorizedException('User not found');

    // Find matching device session by comparing hashed token
    const tokenHash = this.hashToken(rawToken);
    const deviceIndex = user.deviceRefreshTokens.findIndex((d) => d.tokenHash === tokenHash);

    if (deviceIndex === -1) {
      // Token not found — possible reuse attack, invalidate ALL sessions
      this.logger.warn(`Refresh token reuse attack detected for user: ${userId}`);
      await this.userModel.updateOne({ _id: userId }, { $set: { deviceRefreshTokens: [] } });
      throw new UnauthorizedException(
        'Invalid refresh token. All sessions have been invalidated for your security.',
      );
    }

    // Check expiry
    const device = user.deviceRefreshTokens[deviceIndex];
    if (device.expiresAt < new Date()) {
      await this.userModel.updateOne(
        { _id: userId },
        { $pull: { deviceRefreshTokens: { tokenHash } } },
      );
      throw new UnauthorizedException('Refresh token expired. Please login again.');
    }

    // Issue new token pair (token rotation)
    const tokens = await this.generateTokenPair(user, ip, deviceName, tokenHash);
    return tokens;
  }

  // ============================================================
  // LOGOUT
  // ============================================================
  // Logout from single device by removing the specific refresh token
  async logout(userId: string, rawToken: string, accessToken: string) {
    // Remove the refresh token from DB to invalidate the session
    const tokenHash = this.hashToken(rawToken);
    await this.userModel.updateOne(
      { _id: userId },
      { $pull: { deviceRefreshTokens: { tokenHash } } },
    );

    // Blacklist the access token until it naturally expires
    if (accessToken) {
      const ttl = this.getRemainingTtl(accessToken);
      if (ttl > 0) await this.tokenBlocklist.blockToken(accessToken, ttl);
    }

    return { message: 'Logged out successfully' };
  }

  // Logout from all devices by clearing the entire refresh token array
  async logoutAllDevices(userId: string, accessToken?: string) {
    // Clear all device sessions
    await this.userModel.updateOne({ _id: userId }, { $set: { deviceRefreshTokens: [] } });

    // Blacklist current access token
    if (accessToken) {
      const ttl = this.getRemainingTtl(accessToken);
      if (ttl > 0) await this.tokenBlocklist.blockToken(accessToken, ttl);
    }

    return { message: 'Logged out from all devices successfully' };
  }

  // ============================================================
  // EMAIL VERIFICATION
  // ============================================================
  async verifyEmail(dto: VerifyEmailDto) {
    const hashedToken = this.hashToken(dto.token);

    const user = await this.userModel.findOne({
      email: dto.email.toLowerCase(),
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: new Date() },
    });

    // Always return same message — don't reveal if email exists or token is valid
    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    // Mark email as verified and clear verification token
    await this.userModel.updateOne(
      { _id: user._id },
      {
        isEmailVerified: true,
        emailVerificationToken: undefined,
        emailVerificationExpires: undefined,
      },
    );

    return { message: 'Email verified successfully' };
  }

  // ============================================================
  // FORGOT PASSWORD
  // ============================================================
  // Initiate password reset by generating a reset token and sending email
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.userModel.findOne({
      email: dto.email.toLowerCase(),
    });

    // Always return same message — don't reveal if email exists
    if (!user) {
      return { message: 'If that email exists, a reset link has been sent.' };
    }

    // Generate reset token and expiry
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // ── Hash token before storing — same pattern as refresh tokens
    // The raw token goes in the email link; we only ever store the hash
    const hashedResetToken = this.hashToken(resetToken);

    await this.userModel.updateOne(
      { _id: user._id },
      {
        passwordResetToken: hashedResetToken,
        passwordResetExpires: resetExpires,
      },
    );

    // TODO: Fire NATS event → notification-service sends reset email
    // The link should contain the RAW token: /reset-password?token=<resetToken>
    this.logger.log(`Password reset requested for: ${user.email}`);

    return { message: 'If that email exists, a reset link has been sent.' };
  }

  // ============================================================
  // RESET PASSWORD
  // ============================================================
  // Reset password using the token sent to email
  async resetPassword(dto: ResetPasswordDto) {
    // Hash the incoming token before lookup — we only store hashes, never raw tokens
    const hashedToken = this.hashToken(dto.token);

    const user = await this.userModel
      .findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: new Date() },
      })
      .select('+passwordResetToken');

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Hash new password and update user record, also invalidate all sessions
    const rounds = this.configService.get<number>('auth.security.bcryptRounds')!;
    const passwordHash = await bcrypt.hash(dto.newPassword, rounds);

    // Clear reset token and expire time, update password, and invalidate sessions
    await this.userModel.updateOne(
      { _id: user._id },
      {
        passwordHash,
        passwordResetToken: undefined,
        passwordResetExpires: undefined,
        lastPasswordChangedAt: new Date(),
        // Invalidate all sessions on password reset
        deviceRefreshTokens: [],
      },
    );

    return { message: 'Password reset successful. Please login again.' };
  }

  // ============================================================
  // CHANGE PASSWORD (Authenticated)
  // ============================================================
  // Change password for logged-in users, requires current password for security
  async changePassword(userId: string, dto: ChangePasswordDto, accessToken: string) {
    const user = await this.userModel.findById(userId).select('+passwordHash');

    if (!user) throw new NotFoundException('User not found');

    // Verify current password
    const isValid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!isValid) throw new BadRequestException('Current password is incorrect');

    // Hash new password and update, also invalidate all sessions
    const rounds = this.configService.get<number>('auth.security.bcryptRounds')!;
    const passwordHash = await bcrypt.hash(dto.newPassword, rounds);

    // Clear all refresh tokens to force re-login on all devices after password change
    await this.userModel.updateOne(
      { _id: userId },
      {
        $set: {
          passwordHash,
          lastPasswordChangedAt: new Date(),
          deviceRefreshTokens: [], // Force re-login on all devices
        },
      },
    );

    // Blacklist the current access token
    const ttl = this.getRemainingTtl(accessToken);
    if (ttl > 0) await this.tokenBlocklist.blockToken(accessToken, ttl);

    return { message: 'Password changed successfully' };
  }

  /**
   * Internal method for cross-service email resolution.
   * Pattern: 'auth.get_email'
   */
  async getEmailByAuthId(authId: string): Promise<string | null> {
    try {
      const user = await this.userModel.findById(authId).select('email').lean();
      return user?.email ?? null;
    } catch (error) {
      this.logger.error(`Error resolving email for ${authId}: ${(error as Error).message}`);
      return null;
    }
  }

  // ============================================================
  // VERIFY 2FA
  // ============================================================
  async verifyTwoFactor(dto: TwoFactorDto, req: Request) {
    let decoded: { sub: string; type: string };
    try {
      decoded = this.jwtService.verify(dto.tempToken, {
        secret: this.configService.get<string>('auth.jwt.twoFactorSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired temporary token');
    }

    if (decoded.type !== '2fa_pending') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.userModel.findById(decoded.sub).select('+twoFactorSecret');
    if (!user) throw new NotFoundException('User not found');

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled for this account');
    }

    const totp = new TOTP({
      crypto: new NobleCryptoPlugin(),
      base32: new ScureBase32Plugin()
    });

    try {
      const result = await totp.verify(dto.code, { secret: user.twoFactorSecret });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid 2FA code');
      }
    } catch (err) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    const ip = req.ip ?? 'unknown';
    const deviceName = req.headers['user-agent'] ?? 'Unknown device';
    return this.generateTokenPair(user, ip, deviceName);
  }

  // ============================================================
  // VALIDATE TOKEN (Used by other services via NATS)
  // ============================================================
  // Validate access token and return payload if valid
  async validateToken(token: string): Promise<JwtPayload> {
    try {
      return this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('auth.jwt.accessSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  // Verify refresh token signature and return payload (used by the refresh controller endpoint)
  verifyRefreshToken(rawToken: string): { sub: string } {
    return this.jwtService.verify<{ sub: string }>(rawToken, {
      secret: this.configService.get<string>('auth.jwt.refreshSecret'),
    });
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  // Generate access and refresh tokens, and manage refresh token storage with rotation
  private async generateTokenPair(
    user: UserDocument,
    ip: string,
    deviceName: string,
    oldTokenHash?: string,
  ) {
    const payload: JwtPayload = {
      sub: String(user._id),
      email: user.email,
      role: user.role,
      permissions: user.permissions as any,
      lgaId: user.lgaId as any,
    };

    // Generate access token and refresh token in parallel
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('auth.jwt.accessSecret'),
        expiresIn: this.configService.get<any>('auth.jwt.accessExpiry'),
      }),
      this.jwtService.signAsync(
        { sub: payload.sub },
        {
          secret: this.configService.get<string>('auth.jwt.refreshSecret'),
          expiresIn: this.configService.get<any>('auth.jwt.refreshExpiry'),
        },
      ),
    ]);

    // Hash the refresh token before storing in DB for security
    const newTokenHash: string = this.hashToken(refreshToken);

    // Create new device session object
    const newDevice: DeviceRefreshToken = {
      tokenHash: newTokenHash,
      deviceName,
      deviceIp: ip,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7d
      lastUsedAt: new Date(),
    };

    // Store new refresh token in DB with rotation: if oldTokenHash is provided, replace that token, otherwise add new device session
    if (oldTokenHash) {
      // Rotate — replace old token with new one
      await this.userModel.updateOne(
        { _id: user._id, 'deviceRefreshTokens.tokenHash': oldTokenHash },
        { $set: { 'deviceRefreshTokens.$': newDevice } },
      );
    } else {
      // New login — add device, cap at 5 active devices
      await this.userModel.updateOne(
        { _id: user._id },
        {
          $push: {
            deviceRefreshTokens: {
              $each: [newDevice],
              $slice: -5, // Keep only last 5 devices
            },
          },
        },
      );
    }

    // Return tokens and user info (excluding sensitive data)
    return {
      accessToken,
      refreshToken,
      user: {
        id: String(user._id),
        email: user.email,
        role: user.role,
        permissions: user.permissions,
      },
    };
  }

  // Generate a temporary token for 2FA pending state, valid for 5 minutes
  private generateTempToken(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, type: '2fa_pending' },
      {
        secret: this.configService.get<string>('auth.jwt.twoFactorSecret'),
        expiresIn: '5m',
      },
    );
  }

  // Hash tokens using SHA-256 before storing in DB for security
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // Calculate remaining TTL in seconds from a JWT token's exp claim
  private getRemainingTtl(token: string): number {
    try {
      const decoded = this.jwtService.decode(token) as { exp?: number };
      if (!decoded?.exp) return 15 * 60; // fallback to 15m if no exp claim
      const remaining = decoded.exp - Math.floor(Date.now() / 1000);
      return remaining > 0 ? remaining : 0;
    } catch {
      return 15 * 60; // fallback on error
    }
  }
}
