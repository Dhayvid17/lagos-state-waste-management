import { Processor, Process, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Job } from 'bull';
import sharp from 'sharp';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';

import { MinioService } from '../minio/minio.service';
import {
  MEDIA_QUEUE,
  MediaJobs,
  CompressImageJobData,
  CompressVideoJobData,
  DeleteFileJobData,
} from './media.queue.js';

@Processor(MEDIA_QUEUE)
export class MediaProcessor {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly minioService: MinioService,
    @Inject('NATS_SERVICE') private readonly natsClient: ClientProxy,
  ) {}

  // ============================================================
  // COMPRESS IMAGE
  // ============================================================
  @Process(MediaJobs.COMPRESS_IMAGE)
  async compressImage(job: Job<CompressImageJobData>) {
    const { key, thumbnailKey } = job.data;
    this.logger.log(`Compressing image: ${key}`);

    try {
      // 1. Download from MinIO
      const originalBuffer = await this.minioService.getFileBuffer(key);

      // 2. Compress with Sharp → WebP format
      const compressed = await sharp(originalBuffer)
        .resize(1920, 1080, {
          fit: 'inside',          // Maintain aspect ratio
          withoutEnlargement: true, // Never upscale
        })
        .webp({ quality: 80 })
        .toBuffer();

      // 3. Generate thumbnail from the COMPRESSED buffer (race condition fix)
      //    We do this BEFORE deleting the original — using in-memory buffer, no extra download needed
      const thumbnail = await sharp(compressed)
        .resize(400, 400, {
          fit: 'cover',
          position: 'centre',
          withoutEnlargement: true,
        })
        .webp({ quality: 70 })
        .toBuffer();

      await this.minioService.uploadFile(thumbnailKey, thumbnail, 'image/webp', {
        'x-thumbnail': 'true',
        'x-source-key': key,
      });

      // 4. Upload compressed image to MinIO
      const compressedKey = key.replace(/\.[^.]+$/, '.webp');
      await this.minioService.uploadFile(compressedKey, compressed, 'image/webp', {
        'x-compressed': 'true',
        'x-original-key': key,
      });

      // 5. Delete original AFTER both compressed file and thumbnail are safely uploaded
      if (compressedKey !== key) {
        await this.minioService.deleteFile(key);
      }

      const savedPercent = Math.round((1 - compressed.length / originalBuffer.length) * 100);

      this.logger.log(
        `Image compressed: ${key} → ${compressedKey} (${savedPercent}% smaller) | Thumbnail: ${thumbnailKey}`,
      );

      // ── Emit NATS event so Report Service can update the original key to the compressed key
      this.natsClient.emit('media.processed', {
        originalKey: key,
        compressedKey: compressedKey,
        thumbnailKey: thumbnailKey,
        uploadedById: job.data.uploadedById,
        mediaType: 'image',
      });

      return { compressedKey, thumbnailKey, savedPercent };
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
    const { key, originalSizeMb, thumbnailKey } = job.data;
    this.logger.log(`Compressing video: ${key} (${originalSizeMb}MB)`);

    // ── Use temp directory for FFmpeg processing
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `input-${Date.now()}.mp4`);
    const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);
    const thumbPath = path.join(tempDir, `thumb-${Date.now()}.jpg`);

    try {
      // 1. Stream from MinIO directly to temp file (NO RAM BUFFERING)
      await this.minioService.streamToFile(key, inputPath);

      // 2. Compress with FFmpeg
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-crf 28',          // Quality level (18=best, 51=worst)
            '-preset fast',     // Encoding speed
            '-maxrate 2M',      // Max bitrate
            '-bufsize 4M',      // Buffer size
            '-movflags +faststart', // Web-optimized (metadata first)
            '-vf scale=1280:-2', // Max 720p width, maintain aspect ratio
          ])
          .output(outputPath)
          .on('progress', (progress) => {
            job.progress(Math.round(progress.percent ?? 0));
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      // 3. Generate thumbnail from the compressed OUTPUT file on disk (race condition fix)
      //    BEFORE deleting anything — the outputPath is still available here
      await new Promise<void>((resolve, reject) => {
        ffmpeg(outputPath)
          .screenshots({
            timestamps: ['00:00:01'],
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
        'x-source-key': key,
      });

      // 4. Upload compressed video to MinIO using read stream (NO RAM BUFFERING)
      const compressedKey = key.replace(/\.[^.]+$/, '-compressed.mp4');

      await this.minioService.uploadFromFile(compressedKey, outputPath, 'video/mp4', {
        'x-compressed': 'true',
        'x-original-key': key,
        'x-original-size': String(originalSizeMb),
      });

      // 5. Delete original AFTER both compressed file and thumbnail are safely uploaded
      await this.minioService.deleteFile(key);

      const stat = fs.statSync(outputPath);
      const compressedSizeMb = Math.round(stat.size / (1024 * 1024));
      const savedPercent = Math.round((1 - compressedSizeMb / originalSizeMb) * 100);

      this.logger.log(
        `Video compressed: ${key} → ${compressedKey} ` +
          `(${originalSizeMb}MB → ${compressedSizeMb}MB, ${savedPercent}% smaller) | Thumbnail: ${thumbnailKey}`,
      );

      // ── Emit NATS event so Report Service can update the original key to the compressed key
      this.natsClient.emit('media.processed', {
        originalKey: key,
        compressedKey: compressedKey,
        thumbnailKey: thumbnailKey,
        uploadedById: job.data.uploadedById,
        mediaType: 'video',
      });

      return { compressedKey, thumbnailKey, compressedSizeMb, savedPercent };
    } catch (error) {
      this.logger.error(`Video compression failed for ${key}:`, (error as Error).message);
      throw error;
    } finally {
      // ── Always clean up ALL temp files, even on error
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }
  }


  // ============================================================
  // DELETE FILE
  // ============================================================
  @Process(MediaJobs.DELETE_FILE)
  async deleteFile(job: Job<DeleteFileJobData>) {
    const { key, deletedById } = job.data;
    this.logger.log(`Deleting file: ${key} (requested by ${deletedById})`);

    try {
      // 1. Check if main file exists
      const exists = await this.minioService.fileExists(key);
      if (exists) {
        // 2. Delete main file
        await this.minioService.deleteFile(key);
      } else {
        this.logger.warn(`File not found for deletion: ${key}`);
      }

      // 3. Derive and delete thumbnail (if it exists)
      // Use provided thumbnailKey OR fallback to derivation logic
      const finalThumbnailKey = job.data.thumbnailKey || 
        key.replace(/-compressed\.[^.]+$/, '-thumb.webp').replace(/\.[^.]+$/, '-thumb.webp');
      
      const thumbExists = await this.minioService.fileExists(finalThumbnailKey);
      
      if (thumbExists) {
        await this.minioService.deleteFile(finalThumbnailKey);
        this.logger.log(`Deleted associated thumbnail: ${finalThumbnailKey}`);
      }

      this.logger.log(`File deletion completed for: ${key}`);
      return { success: true, key };
    } catch (error) {
      this.logger.error(`File deletion failed for ${key}:`, (error as Error).message);
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
