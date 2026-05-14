import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser, Public } from '@app/shared';

import type { JwtPayload } from '@app/shared';

import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginDto, TwoFactorDto } from './dto/login.dto';
import {
  VerifyEmailDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from './dto/verify-email.dto.js';

@ApiTags('Auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── POST auth/register
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, req);
  }

  // ── POST /auth/login
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Call auth service to validate credentials and generate tokens
    const result = await this.authService.login(dto, req);

    // Set refresh token as httpOnly cookie for web clients
    if ('refreshToken' in result) {
      res.cookie('refresh_token', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'prod',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/auth/refresh',
      });
    }

    return result;
  }

  // ── POST /auth/verify-2fa
  @Public()
  @Post('verify-2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify 2FA code to complete login' })
  async verifyTwoFactor(
    @Body() dto: TwoFactorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyTwoFactor(dto, req);

    // Set refresh token as httpOnly cookie for web clients
    if ('refreshToken' in result) {
      res.cookie('refresh_token', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'prod',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/auth/refresh',
      });
    }

    return result;
  }

  // ── POST /auth/refresh
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Extract refresh token from cookie or body
    const rawToken = req.cookies?.refresh_token ?? req.body?.refreshToken;

    if (!rawToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    // ── Cryptographically verify the refresh token before trusting its payload
    // Previously this was an unsafe manual base64 decode — a forged token could spoof any userId
    let decoded: { sub: string };
    try {
      decoded = this.authService.verifyRefreshToken(rawToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Call auth service to validate refresh token, generate new tokens, and rotate refresh token in DB
    const result = await this.authService.refreshTokens(
      decoded.sub,
      rawToken,
      req.ip ?? 'unknown',
      req.headers['user-agent'] ?? 'Unknown device',
    );

    // Rotate cookie
    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'prod',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    });

    return result;
  }

  // ── POST /auth/logout
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout from current device' })
  @ApiBearerAuth()
  async logout(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Extract access token from Authorization header and refresh token from cookie/body for logout
    const accessToken = req.headers.authorization?.split(' ')[1] ?? '';
    const rawToken = req.cookies?.refresh_token ?? req.body?.refreshToken;
    if (!rawToken) throw new UnauthorizedException('No refresh token provided');
    if (!accessToken) throw new UnauthorizedException('No access token provided');

    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    return this.authService.logout(user.sub, rawToken, accessToken);
  }

  // ── POST auth/logout-all
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiBearerAuth()
  async logoutAll(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Extract access token from Authorization header to blacklist it along with all refresh tokens
    const accessToken = req.headers.authorization?.split(' ')[1] ?? '';
    if (!accessToken) throw new UnauthorizedException('No access token provided');

    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    return this.authService.logoutAllDevices(user.sub, accessToken);
  }

  // ── POST auth/verify-email
  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with token' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  // ── POST auth/forgot-password
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  // ── POST /auth/reset-password
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // ── POST /auth/change-password
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password (authenticated)' })
  @ApiBearerAuth()
  changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const accessToken = req.headers.authorization?.split(' ')[1] ?? '';
    return this.authService.changePassword(user.sub, dto, accessToken);
  }

  // ============================================================
  // INTERNAL CROSS-SERVICE COMMUNICATION
  // ============================================================
  @MessagePattern('auth.get_email')
  async handleGetEmail(@Payload() data: { authId: string }) {
    return this.authService.getEmailByAuthId(data.authId);
  }

  // ── GET /auth/me
  @Get('me')
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiBearerAuth()
  getMe(@CurrentUser() user: JwtPayload) {
    return user;
  }
}
