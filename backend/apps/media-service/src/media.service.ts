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
import { fileTypeFromBuffer } from 'file-type';
import type { JwtPayload } from '@app/shared';
import { UserRole } from '@app/shared';

import { MinioService } from './minio/minio.service';
import { MEDIA_QUEUE, MediaJobs } from './queue/media.queue';

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
    // ── 1. Validate file (now checks magic bytes)
    const mediaType = await this.validateFile(file);

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
      // Queue image compression — thumbnail is generated INSIDE this job (no separate thumbnail job)
      await this.mediaQueue.add(
        MediaJobs.COMPRESS_IMAGE,
        { key, uploadedById: user.sub, mimeType: file.mimetype, thumbnailKey },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } else {
      // Queue video compression — thumbnail is generated INSIDE this job (no separate thumbnail job)
      await this.mediaQueue.add(
        MediaJobs.COMPRESS_VIDEO,
        { key, uploadedById: user.sub, mimeType: file.mimetype, originalSizeMb: sizeMb, thumbnailKey },
        {
          attempts: 2,
          backoff: { type: 'fixed', delay: 30000 },
          priority: 10,
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
    // ── Check file exists FIRST to avoid 500 error on metadata fetch
    const exists = await this.minioService.fileExists(key);
    if (!exists) throw new NotFoundException('Media file not found');

    // ── Validate key belongs to this user OR user is admin
    await this.validateKeyOwnership(user, key);

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
  ): Promise<Array<{ key: string; presignedUrl: string | null; error?: string }>> {
    if (keys.length > 20) {
      throw new BadRequestException('Maximum 20 keys per batch request');
    }

    const results = await Promise.all(
      keys.map(async (key) => {
        try {
          await this.validateKeyOwnership(user, key);
          const presignedUrl = await this.minioService.getPresignedUrl(key);
          return { key, presignedUrl };
        } catch (error) {
          // Return the error instead of silently swallowing it
          return { key, presignedUrl: null, error: (error as Error).message };
        }
      }),
    );

    // Return all results, including failed ones, so the client knows what failed and why
    return results;
  }

  // ============================================================
  // DELETE FILE
  // ============================================================
  async deleteFile(
    user: JwtPayload,
    key: string,
    thumbnailKey?: string,
  ): Promise<{ message: string }> {
    // ── Ownership check now includes existence check
    await this.validateKeyOwnership(user, key);

    // ── Queue background deletion
    await this.mediaQueue.add(
      MediaJobs.DELETE_FILE,
      { key, deletedById: user.sub, thumbnailKey },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`Delete job queued for: ${key} by ${user.sub}`);
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

  private async validateFile(file: UploadedFile): Promise<MediaType> {
    // ── 1. Magic byte validation (prevent MIME spoofing)
    const detected = await fileTypeFromBuffer(file.buffer.slice(0, 4100));

    if (!detected) {
      throw new BadRequestException('Could not determine file type from contents. File may be corrupted or unsupported.');
    }

    const isDetectedImage = this.allowedImageTypes.includes(detected.mime);
    const isDetectedVideo = this.allowedVideoTypes.includes(detected.mime);

    if (!isDetectedImage && !isDetectedVideo) {
      throw new BadRequestException(
        `File content type '${detected.mime}' is not allowed. ` +
          `Allowed types: ${[...this.allowedImageTypes, ...this.allowedVideoTypes].join(', ')}`,
      );
    }

    // ── 2. Browser MIME type validation (secondary check)
    const isClaimedImage = this.allowedImageTypes.includes(file.mimetype);
    const isClaimedVideo = this.allowedVideoTypes.includes(file.mimetype);

    if (!isClaimedImage && !isClaimedVideo) {
      throw new BadRequestException(
        `Claimed file type '${file.mimetype}' from browser is not allowed.`,
      );
    }

    // ── 3. Size validation based on detected type
    if (isDetectedImage && file.size > this.maxImageSizeBytes) {
      throw new BadRequestException(
        `Image size exceeds maximum allowed size of ` +
          `${this.configService.get('media.upload.maxImageSizeMb')}MB`,
      );
    }

    if (isDetectedVideo && file.size > this.maxVideoSizeBytes) {
      throw new BadRequestException(
        `Video size exceeds maximum allowed size of ` +
          `${this.configService.get('media.upload.maxVideoSizeMb')}MB`,
      );
    }

    return isDetectedImage ? 'image' : 'video';
  }

  private async validateKeyOwnership(user: JwtPayload, key: string): Promise<void> {
    // ── SYS_ADMIN can access any file
    if (user.role === UserRole.SYS_ADMIN) return;

    // ── 1. FAST PRE-CHECK: String parsing
    // Key format: context/authId/date/filename
    const segments = key.split('/');
    if (segments.length < 2) {
      throw new BadRequestException('Invalid media key format');
    }

    const keyOwnerId = segments[1];
    if (keyOwnerId !== user.sub) {
      throw new ForbiddenException('You do not have permission to access this file');
    }

    // ── 2. EXISTENCE CHECK (Prevent 500 in metadata fetch)
    const exists = await this.minioService.fileExists(key);
    if (!exists) {
      throw new NotFoundException('Media file not found');
    }

    // ── 3. METADATA CHECK (Source of Truth)
    const metadata = await this.minioService.getFileMetadata(key);

    // Note: MinIO standardizes metadata keys to lowercase
    if (metadata['x-uploaded-by'] !== user.sub) {
      throw new ForbiddenException('You do not have permission to access this file');
    }
  }
}
