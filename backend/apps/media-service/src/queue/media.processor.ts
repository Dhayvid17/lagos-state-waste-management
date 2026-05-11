import { Processor, Process, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import sharp from 'sharp';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';

import { MinioService } from '../minio/minio.service.js';
import {
  MEDIA_QUEUE,
  MediaJobs,
  CompressImageJobData,
  CompressVideoJobData,
  GenerateThumbnailJobData,
} from './media.queue.js';

@Processor(MEDIA_QUEUE)
export class MediaProcessor {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(private readonly minioService: MinioService) {}

  // ============================================================
  // COMPRESS IMAGE
  // ============================================================
  @Process(MediaJobs.COMPRESS_IMAGE)
  async compressImage(job: Job<CompressImageJobData>) {
    const { key, mimeType } = job.data;
    this.logger.log(`Compressing image: ${key}`);

    try {
      // 1. Download from MinIO
      const originalBuffer = await this.minioService.getFileBuffer(key);

      // 2. Compress with Sharp → WebP format
      const compressed = await sharp(originalBuffer)
        .resize(1920, 1080, {
          fit: 'inside', // Maintain aspect ratio
          withoutEnlargement: true, // Never upscale
        })
        .webp({ quality: 80 })
        .toBuffer();

      // 3. Replace original in MinIO with compressed version
      const compressedKey = key.replace(/\.[^.]+$/, '.webp');

      await this.minioService.uploadFile(compressedKey, compressed, 'image/webp', {
        'x-compressed': 'true',
        'x-original-key': key,
      });

      // 4. Delete original if key changed
      if (compressedKey !== key) {
        await this.minioService.deleteFile(key);
      }

      const savedPercent = Math.round((1 - compressed.length / originalBuffer.length) * 100);

      this.logger.log(`Image compressed: ${key} → ${compressedKey} (${savedPercent}% smaller)`);

      return { compressedKey, savedPercent };
    } catch (error) {
      this.logger.error(`Image compression failed for ${key}:`, (error as Error).message);
      throw error; // BullMQ will retry
    }
  }

  // ============================================================
  // COMPRESS VIDEO — FFmpeg background job
  // ============================================================
  @Process(MediaJobs.COMPRESS_VIDEO)
  async compressVideo(job: Job<CompressVideoJobData>) {
    const { key, originalSizeMb } = job.data;
    this.logger.log(`Compressing video: ${key} (${originalSizeMb}MB)`);

    // ── Use temp directory for FFmpeg processing
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `input-${Date.now()}.mp4`);
    const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);

    try {
      // 1. Download from MinIO to temp file
      const videoBuffer = await this.minioService.getFileBuffer(key);
      fs.writeFileSync(inputPath, videoBuffer);

      // 2. Compress with FFmpeg
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-crf 28', // Quality level (18=best, 51=worst)
            '-preset fast', // Encoding speed
            '-maxrate 2M', // Max bitrate
            '-bufsize 4M', // Buffer size
            '-movflags +faststart', // Web-optimized (metadata first)
            '-vf scale=1280:-2', // Max 720p width, maintain aspect ratio
          ])
          .output(outputPath)
          .on('progress', (progress) => {
            // Update job progress for monitoring
            job.progress(Math.round(progress.percent ?? 0));
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      // 3. Upload compressed video to MinIO
      const compressedBuffer = fs.readFileSync(outputPath);
      const compressedKey = key.replace(/\.[^.]+$/, '-compressed.mp4');

      await this.minioService.uploadFile(compressedKey, compressedBuffer, 'video/mp4', {
        'x-compressed': 'true',
        'x-original-key': key,
        'x-original-size': String(originalSizeMb),
      });

      // 4. Delete original
      await this.minioService.deleteFile(key);

      const compressedSizeMb = Math.round(compressedBuffer.length / (1024 * 1024));
      const savedPercent = Math.round((1 - compressedSizeMb / originalSizeMb) * 100);

      this.logger.log(
        `Video compressed: ${key} → ${compressedKey} ` +
          `(${originalSizeMb}MB → ${compressedSizeMb}MB, ${savedPercent}% smaller)`,
      );

      return { compressedKey, compressedSizeMb, savedPercent };
    } catch (error) {
      this.logger.error(`Video compression failed for ${key}:`, (error as Error).message);
      throw error;
    } finally {
      // ── Always clean up temp files
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  }

  // ============================================================
  // GENERATE THUMBNAIL
  // ============================================================
  @Process(MediaJobs.GENERATE_THUMBNAIL)
  async generateThumbnail(job: Job<GenerateThumbnailJobData>) {
    const { sourceKey, thumbnailKey, mediaType } = job.data;
    this.logger.log(`Generating thumbnail: ${sourceKey}`);

    try {
      if (mediaType === 'image') {
        // ── Image thumbnail via Sharp
        const originalBuffer = await this.minioService.getFileBuffer(sourceKey);

        const thumbnail = await sharp(originalBuffer)
          .resize(400, 400, {
            fit: 'cover',
            position: 'centre',
            withoutEnlargement: true,
          })
          .webp({ quality: 70 })
          .toBuffer();

        await this.minioService.uploadFile(thumbnailKey, thumbnail, 'image/webp', {
          'x-thumbnail': 'true',
          'x-source-key': sourceKey,
        });
      } else {
        // ── Video thumbnail — extract first frame via FFmpeg
        const tempDir = os.tmpdir();
        const inputPath = path.join(tempDir, `video-${Date.now()}.mp4`);
        const thumbPath = path.join(tempDir, `thumb-${Date.now()}.jpg`);

        const videoBuffer = await this.minioService.getFileBuffer(sourceKey);
        fs.writeFileSync(inputPath, videoBuffer);

        await new Promise<void>((resolve, reject) => {
          ffmpeg(inputPath)
            .screenshots({
              timestamps: ['00:00:01'], // 1 second into video
              filename: path.basename(thumbPath),
              folder: path.dirname(thumbPath),
              size: '400x400',
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
        });

        const thumbBuffer = fs.readFileSync(thumbPath);

        await this.minioService.uploadFile(thumbnailKey, thumbBuffer, 'image/jpeg', {
          'x-thumbnail': 'true',
          'x-source-key': sourceKey,
        });

        // Cleanup
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      }

      this.logger.log(`Thumbnail generated: ${thumbnailKey}`);
      return { thumbnailKey };
    } catch (error) {
      this.logger.error(`Thumbnail generation failed for ${sourceKey}:`, (error as Error).message);
      throw error;
    }
  }

  // ============================================================
  // QUEUE EVENT HOOKS
  // ============================================================
  @OnQueueCompleted()
  onCompleted(job: Job) {
    this.logger.log(`✅ Job completed: ${job.name} [${job.id}]`);
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error) {
    this.logger.error(`❌ Job failed: ${job.name} [${job.id}] — ${error.message}`);
  }
}
