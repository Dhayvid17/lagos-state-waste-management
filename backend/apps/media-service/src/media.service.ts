import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as path from 'path';
import type { JwtPayload } from '@app/shared';
import { UserRole } from '@app/shared';

import { MinioService } from './minio/minio.service.js';
import { MEDIA_QUEUE, MediaJobs } from './queue/media.queue.js';

// ── Supported file categories
export type MediaType = 'image' | 'video';

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface UploadResult {
  key: string;
  presignedUrl: string;
  mediaType: MediaType;
  mimeType: string;
  sizeBytes: number;
  sizeMb: number;
  thumbnailKey?: string;
  processing: boolean; // true if compression job queued
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  private readonly allowedImageTypes: string[];
  private readonly allowedVideoTypes: string[];
  private readonly maxImageSizeBytes: number;
  private readonly maxVideoSizeBytes: number;

  constructor(
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    @InjectQueue(MEDIA_QUEUE)
    private readonly mediaQueue: Queue,
  ) {
    this.allowedImageTypes = this.configService.get<string[]>('media.upload.allowedImageTypes')!;
    this.allowedVideoTypes = this.configService.get<string[]>('media.upload.allowedVideoTypes')!;
    this.maxImageSizeBytes =
      this.configService.get<number>('media.upload.maxImageSizeMb')! * 1024 * 1024;
    this.maxVideoSizeBytes =
      this.configService.get<number>('media.upload.maxVideoSizeMb')! * 1024 * 1024;
  }

  // ============================================================
  // UPLOAD SINGLE FILE
  // ============================================================
  async uploadFile(
    user: JwtPayload,
    file: UploadedFile,
    context: string = 'general', // e.g. 'report', 'profile', 'kyc'
  ): Promise<UploadResult> {
    // ── 1. Validate file
    const mediaType = this.validateFile(file);

    // ── 2. Generate unique key with structured path
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueId = crypto.randomUUID();
    const date = new Date();
    const datePath = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    const key = `${context}/${user.sub}/${datePath}/${uniqueId}${ext}`;
    const thumbnailKey = `${context}/${user.sub}/${datePath}/${uniqueId}-thumb.webp`;

    // ── 3. Upload raw file to MinIO immediately
    await this.minioService.uploadFile(key, file.buffer, file.mimetype, {
      'x-uploaded-by': user.sub,
      'x-original-name': encodeURIComponent(file.originalname),
      'x-context': context,
      'x-media-type': mediaType,
    });

    // ── 4. Generate presigned URL for immediate use
    const presignedUrl = await this.minioService.getPresignedUrl(key);

    const sizeMb = Math.round((file.size / (1024 * 1024)) * 100) / 100;

    // ── 5. Queue background jobs
    if (mediaType === 'image') {
      // Queue image compression
      await this.mediaQueue.add(
        MediaJobs.COMPRESS_IMAGE,
        { key, uploadedById: user.sub, mimeType: file.mimetype },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false, // Keep failed jobs for debugging
        },
      );

      // Queue thumbnail generation
      await this.mediaQueue.add(
        MediaJobs.GENERATE_THUMBNAIL,
        { sourceKey: key, thumbnailKey, mediaType: 'image' },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          delay: 2000, // Wait 2s — after compression starts
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } else {
      // Queue video compression (heavy job — lower priority)
      await this.mediaQueue.add(
        MediaJobs.COMPRESS_VIDEO,
        { key, uploadedById: user.sub, mimeType: file.mimetype, originalSizeMb: sizeMb },
        {
          attempts: 2, // Videos get 2 attempts only
          backoff: { type: 'fixed', delay: 30000 }, // 30s between retries
          priority: 10, // Lower priority than images
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      // Queue video thumbnail
      await this.mediaQueue.add(
        MediaJobs.GENERATE_THUMBNAIL,
        { sourceKey: key, thumbnailKey, mediaType: 'video' },
        {
          attempts: 2,
          backoff: { type: 'fixed', delay: 10000 },
          delay: 5000, // Wait 5s for video to be available
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    this.logger.log(`File uploaded: ${key} (${sizeMb}MB) by ${user.sub} — compression queued`);

    return {
      key,
      presignedUrl,
      mediaType,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      sizeMb,
      thumbnailKey,
      processing: true, // Compression running in background
    };
  }

  // ============================================================
  // UPLOAD MULTIPLE FILES
  // ============================================================
  async uploadMultipleFiles(
    user: JwtPayload,
    files: UploadedFile[],
    context: string = 'general',
  ): Promise<UploadResult[]> {
    const maxFiles = this.configService.get<number>('media.upload.maxFilesPerUpload')!;

    if (files.length > maxFiles) {
      throw new BadRequestException(`Maximum ${maxFiles} files allowed per upload`);
    }

    if (files.length === 0) {
      throw new BadRequestException('No files provided');
    }

    // ── Upload all files concurrently
    const results = await Promise.all(files.map((file) => this.uploadFile(user, file, context)));

    return results;
  }

  // ============================================================
  // GET FRESH PRESIGNED URL
  // Client calls this when their 15min URL expires
  // ============================================================
  async getPresignedUrl(
    user: JwtPayload,
    key: string,
  ): Promise<{ key: string; presignedUrl: string; expiresInSeconds: number }> {
    // ── Validate key belongs to this user OR user is admin
    this.validateKeyOwnership(user, key);

    // ── Check file exists
    const exists = await this.minioService.fileExists(key);
    if (!exists) throw new NotFoundException('Media file not found');

    const presignedUrl = await this.minioService.getPresignedUrl(key);
    const expiresInSeconds = this.configService.get<number>('media.minio.presignExpiry')!;

    return { key, presignedUrl, expiresInSeconds };
  }

  // ============================================================
  // GET MULTIPLE PRESIGNED URLS — batch refresh
  // ============================================================
  async getMultiplePresignedUrls(
    user: JwtPayload,
    keys: string[],
  ): Promise<Array<{ key: string; presignedUrl: string }>> {
    if (keys.length > 20) {
      throw new BadRequestException('Maximum 20 keys per batch request');
    }

    const results = await Promise.all(
      keys.map(async (key) => {
        try {
          this.validateKeyOwnership(user, key);
          const presignedUrl = await this.minioService.getPresignedUrl(key);
          return { key, presignedUrl };
        } catch {
          // Return null for inaccessible keys — don't fail entire batch
          return { key, presignedUrl: '' };
        }
      }),
    );

    // Filter out failed ones
    return results.filter((r) => r.presignedUrl !== '');
  }

  // ============================================================
  // DELETE FILE
  // ============================================================
  async deleteFile(user: JwtPayload, key: string): Promise<{ message: string }> {
    // ── Validate ownership
    this.validateKeyOwnership(user, key);

    // ── Check file exists
    const exists = await this.minioService.fileExists(key);
    if (!exists) throw new NotFoundException('Media file not found');

    // ── Delete main file
    await this.minioService.deleteFile(key);

    // ── Delete thumbnail if exists
    const thumbnailKey = key.replace(/(\.[^.]+)$/, '-thumb.webp');
    const thumbExists = await this.minioService.fileExists(thumbnailKey);
    if (thumbExists) {
      await this.minioService.deleteFile(thumbnailKey);
    }

    this.logger.log(`File deleted: ${key} by ${user.sub}`);
    return { message: 'File deleted successfully' };
  }

  // ============================================================
  // GET QUEUE STATUS — Admin monitoring
  // ============================================================
  async getQueueStatus(user: JwtPayload) {
    if (user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only SYS_ADMIN can view queue status');
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.mediaQueue.getWaitingCount(),
      this.mediaQueue.getActiveCount(),
      this.mediaQueue.getCompletedCount(),
      this.mediaQueue.getFailedCount(),
      this.mediaQueue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    };
  }

  // ============================================================
  // RETRY FAILED JOBS — Admin only
  // ============================================================
  async retryFailedJobs(user: JwtPayload): Promise<{ retried: number }> {
    if (user.role !== UserRole.SYS_ADMIN) {
      throw new ForbiddenException('Only SYS_ADMIN can retry failed jobs');
    }

    const failedJobs = await this.mediaQueue.getFailed();
    await Promise.all(failedJobs.map((job) => job.retry()));

    this.logger.log(`${failedJobs.length} failed jobs retried by ${user.sub}`);

    return { retried: failedJobs.length };
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private validateFile(file: UploadedFile): MediaType {
    const isImage = this.allowedImageTypes.includes(file.mimetype);
    const isVideo = this.allowedVideoTypes.includes(file.mimetype);

    if (!isImage && !isVideo) {
      throw new BadRequestException(
        `File type '${file.mimetype}' is not allowed. ` +
          `Allowed: ${[...this.allowedImageTypes, ...this.allowedVideoTypes].join(', ')}`,
      );
    }

    if (isImage && file.size > this.maxImageSizeBytes) {
      throw new BadRequestException(
        `Image size exceeds maximum allowed size of ` +
          `${this.configService.get('media.upload.maxImageSizeMb')}MB`,
      );
    }

    if (isVideo && file.size > this.maxVideoSizeBytes) {
      throw new BadRequestException(
        `Video size exceeds maximum allowed size of ` +
          `${this.configService.get('media.upload.maxVideoSizeMb')}MB`,
      );
    }

    return isImage ? 'image' : 'video';
  }

  private validateKeyOwnership(user: JwtPayload, key: string): void {
    // ── SYS_ADMIN can access any file
    if (user.role === UserRole.SYS_ADMIN) return;

    // ── Key format: context/authId/date/filename
    // ── Check that authId segment matches current user
    const segments = key.split('/');
    const keyOwnerId = segments[1]; // Index 1 is always authId

    if (keyOwnerId !== user.sub) {
      throw new ForbiddenException('You do not have permission to access this file');
    }
  }
}
