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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser, Public } from '@app/shared';

import type { JwtPayload } from '@app/shared';

import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
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

  // ── POST /auth/refresh
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Extract refresh token from cookie or body
    const rawToken = req.cookies?.refresh_token ?? req.body?.refreshToken;

    if (!rawToken) {
      throw new Error('No refresh token provided');
    }

    // Decode without verifying to get userId — strategy will verify
    const decoded = JSON.parse(Buffer.from(rawToken.split('.')[1], 'base64').toString());

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
    if (!rawToken) throw new Error('No refresh token provided');
    if (!accessToken) throw new Error('No access token provided');

    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    return this.authService.logout(user.sub, rawToken, accessToken);
  }

  // ── POST auth/logout-all
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiBearerAuth()
  async logoutAll(@CurrentUser() user: JwtPayload, @Res({ passthrough: true }) res: Response) {
    // Extract access token from Authorization header to blacklist it along with all refresh tokens
    const accessToken = res.req?.headers.authorization?.split(' ')[1] ?? '';
    if (!accessToken) throw new Error('No access token provided');

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
  changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.sub, dto);
  }

  // ── GET /auth/me
  @Get('me')
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiBearerAuth()
  getMe(@CurrentUser() user: JwtPayload) {
    return user;
  }
}
