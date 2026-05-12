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
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';

import type { JwtPayload } from '@app/shared';
import { CurrentUser, Roles, UserRole } from '@app/shared';

import { MediaService } from './media.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from '@app/shared';

@ApiTags('Media')
@Controller('media')
@UseGuards(JwtAuthGuard, RolesGuard, ThrottlerGuard)
@ApiBearerAuth()
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // ── POST /api/media/upload
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // Limit to 10 uploads per minute per IP
  @ApiOperation({ summary: 'Upload a single file (image or video)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        context: { type: 'string', example: 'report' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // Keep in memory — we upload to MinIO directly
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB hard limit (videos)
      },
    }),
  )
  uploadFile(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Query('context') context: string = 'general',
  ) {
    return this.mediaService.uploadFile(user, file, context);
  }

  // ── POST /api/media/upload/multiple
  @Post('upload/multiple')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // Limit to 5 batch uploads per minute per IP
  @ApiOperation({ summary: 'Upload multiple files (max 5)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
        context: { type: 'string', example: 'report' },
      },
    },
  })
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      storage: memoryStorage(),
      limits: {
        fileSize: 100 * 1024 * 1024,
      },
    }),
  )
  uploadMultipleFiles(
    @CurrentUser() user: JwtPayload,
    @UploadedFiles() files: Express.Multer.File[],
    @Query('context') context: string = 'general',
  ) {
    return this.mediaService.uploadMultipleFiles(user, files, context);
  }

  // ── GET /api/media/presign/:key
  @Get('presign/:key(*)')
  @ApiOperation({ summary: 'Get fresh 15-minute presigned URL for a file' })
  getPresignedUrl(@CurrentUser() user: JwtPayload, @Param('key') key: string) {
    return this.mediaService.getPresignedUrl(user, key);
  }

  // ── POST /api/media/presign/batch
  @Post('presign/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get presigned URLs for multiple keys (max 20)' })
  getMultiplePresignedUrls(@CurrentUser() user: JwtPayload, @Body() body: { keys: string[] }) {
    return this.mediaService.getMultiplePresignedUrls(user, body.keys);
  }

  // ── DELETE /api/media/:key
  @Delete(':key(*)')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a file from storage' })
  deleteFile(@CurrentUser() user: JwtPayload, @Param('key') key: string) {
    return this.mediaService.deleteFile(user, key);
  }

  // ── GET /api/media/queue/status
  @Get('queue/status')
  @Roles(UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Get compression queue status — SYS_ADMIN only' })
  getQueueStatus(@CurrentUser() user: JwtPayload) {
    return this.mediaService.getQueueStatus(user);
  }

  // ── POST /api/media/queue/retry
  @Post('queue/retry')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SYS_ADMIN)
  @ApiOperation({ summary: 'Retry all failed compression jobs — SYS_ADMIN only' })
  retryFailedJobs(@CurrentUser() user: JwtPayload) {
    return this.mediaService.retryFailedJobs(user);
  }
}
