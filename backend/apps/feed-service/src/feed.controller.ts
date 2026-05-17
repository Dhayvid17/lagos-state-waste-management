import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, LagosLGA, Roles, UserRole } from '@app/shared';

import { FeedService } from './feed.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from '@app/shared';
import { DeletePostDto } from './dto/delete-post.dto';

@ApiTags('Feed')
@Controller('feed')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  // ── GET /api/feed
  @Get()
  @ApiOperation({ summary: 'Get ranked feed — LGA-aware' })
  getFeed(
    @CurrentUser() user: JwtPayload,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('lgaId') lgaId?: LagosLGA,
    @Query('viewAll') viewAll: string = 'false',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.feedService.getFeed(user, safePage, safeLimit, lgaId, viewAll === 'true');
  }

  // ── GET /api/feed/search
  @Get('search')
  @ApiOperation({ summary: 'Search feed posts including archived' })
  searchFeed(
    @Query('q') query: string = '',
    @Query('lgaId') lgaId?: LagosLGA,
    @Query('wasteType') wasteType?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.feedService.searchFeed(query, lgaId, wasteType, safePage, safeLimit);
  }

  // ── GET /api/feed/:id
  @Get(':id')
  @ApiOperation({ summary: 'Get single feed post' })
  getPost(@Param('id') id: string) {
    return this.feedService.getPost(id);
  }

  // ── GET /api/feed/report/:reportId
  @Get('report/:reportId')
  @ApiOperation({ summary: 'Get feed post by report ID' })
  getPostByReportId(@Param('reportId') reportId: string) {
    return this.feedService.getPostByReportId(reportId);
  }

  // ── DELETE /api/feed/:id
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete post — citizen (24h+PENDING) or SYS_ADMIN' })
  deletePost(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: DeletePostDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    const userAgent = req.headers['user-agent'];
    return this.feedService.deletePost(user, id, dto.reason, ip, userAgent);
  }

  // ── PATCH /api/feed/:id/archive
  @Patch(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENCY_ADMIN, UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Archive post — AGENCY_ADMIN only' })
  archivePost(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    const ip = req.ip ?? req.headers['x-forwarded-for']?.toString();
    const userAgent = req.headers['user-agent'];
    return this.feedService.archivePost(user, id, ip, userAgent);
  }
}
