import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, Roles, UserRole } from '@app/shared';

import { SocialService } from './social.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';
import {
  AddCommentDto,
  DeleteCommentDto,
  RepostDto,
  FlagReportDto,
  ResolveFlagDto,
} from './dto/social.dto';

@ApiTags('Social')
@Controller('social')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SocialController {
  constructor(private readonly socialService: SocialService) {}

  // ── POST /api/social/reports/:reportId/upvote
  @Post('reports/:reportId/upvote')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Upvote a report — civic verification' })
  upvoteReport(@CurrentUser() user: JwtPayload, @Param('reportId') reportId: string) {
    return this.socialService.upvoteReport(user, reportId);
  }

  // ── Delete /api/social/reports/:reportId/upvote
  @Delete('reports/:reportId/upvote')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Remove upvote from a report' })
  removeUpvote(@CurrentUser() user: JwtPayload, @Param('reportId') reportId: string) {
    return this.socialService.removeUpvote(user, reportId);
  }

  // ── GET /api/social/reports/:reportId/comments
  @Get('reports/:reportId/comments')
  @ApiOperation({ summary: 'Get comments on a report' })
  getComments(
    @Param('reportId') reportId: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.socialService.getComments(reportId, safePage, safeLimit);
  }

  // ── POST /api/social/reports/:reportId/comments
  @Post('reports/:reportId/comments')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Add a comment to a report' })
  addComment(
    @CurrentUser() user: JwtPayload,
    @Param('reportId') reportId: string,
    @Body() dto: AddCommentDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    return this.socialService.addComment(user, reportId, dto, ip);
  }

  // ── DELETE /api/social/comments/:commentId
  @Delete('comments/:commentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a comment — author, reporter, or admin' })
  deleteComment(
    @CurrentUser() user: JwtPayload,
    @Param('commentId') commentId: string,
    @Body() dto: DeleteCommentDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    const userAgent = req.headers['user-agent'];
    return this.socialService.deleteComment(user, commentId, dto, ip, userAgent);
  }

  // ── POST /api/social/reports/:reportId/repost
  @Post('reports/:reportId/repost')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Repost a report to increase visibility' })
  repostReport(
    @CurrentUser() user: JwtPayload,
    @Param('reportId') reportId: string,
    @Body() dto: RepostDto,
  ) {
    return this.socialService.repostReport(user, reportId, dto);
  }

  // ── POST /api/social/reports/:reportId/flag
  @Post('reports/:reportId/flag')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CITIZEN)
  @ApiOperation({ summary: 'Flag a report for admin review' })
  flagReport(
    @CurrentUser() user: JwtPayload,
    @Param('reportId') reportId: string,
    @Body() dto: FlagReportDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    return this.socialService.flagReport(user, reportId, dto, ip);
  }

  // ── GET /api/social/reports/:reportId/engagement
  @Get('reports/:reportId/engagement')
  @ApiOperation({ summary: 'Get engagement counts for a report' })
  getEngagement(@Param('reportId') reportId: string) {
    return this.socialService.getEngagement(reportId);
  }

  // ── GET /api/social/flags — Admin moderation queue
  @Get('flags')
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Get flag moderation queue — Admin only' })
  getFlagQueue(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.socialService.getFlagQueue(user, safePage, safeLimit);
  }

  // ── Post /api/social/flags/:flagId/resolve — Admin resolves flag
  @Post('flags/:flagId/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SYS_ADMIN, UserRole.AGENCY_ADMIN)
  @ApiOperation({ summary: 'Resolve a content flag — Admin only' })
  resolveFlag(
    @CurrentUser() user: JwtPayload,
    @Param('flagId') flagId: string,
    @Body() dto: ResolveFlagDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    const userAgent = req.headers['user-agent'];
    return this.socialService.resolveFlag(user, flagId, dto, ip, userAgent);
  }
}
