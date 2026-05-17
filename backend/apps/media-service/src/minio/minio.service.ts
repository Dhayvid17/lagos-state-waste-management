import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private client: Minio.Client;
  private bucket: string;
  private quarantineBucket: string;
  private presignExpiry: number;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('media.minio.bucket')!;
    this.quarantineBucket = this.configService.get<string>('media.minio.quarantineBucket') ?? `${this.bucket}-quarantine`;
    this.presignExpiry = this.configService.get<number>('media.minio.presignExpiry')!;

    this.client = new Minio.Client({
      endPoint: this.configService.get<string>('media.minio.endPoint')!,
      port: this.configService.get<number>('media.minio.port')!,
      accessKey: this.configService.get<string>('media.minio.accessKey')!,
      secretKey: this.configService.get<string>('media.minio.secretKey')!,
      useSSL: this.configService.get<boolean>('media.minio.useSSL')!,
    });
  }

  async onModuleInit() {
    await this.ensureBucketExists();
  }

  // ============================================================
  // BUCKET SETUP
  // ============================================================
  private async ensureBucketExists() {
    try {
      // Ensure Main Bucket
      let exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket, 'us-east-1');
        this.logger.log(`✅ MinIO bucket created: ${this.bucket}`);
        await this.applyPrivatePolicy(this.bucket);
      } else {
        this.logger.log(`✅ MinIO bucket exists: ${this.bucket}`);
      }

      // Ensure Quarantine Bucket
      exists = await this.client.bucketExists(this.quarantineBucket);
      if (!exists) {
        await this.client.makeBucket(this.quarantineBucket, 'us-east-1');
        this.logger.log(`✅ MinIO quarantine bucket created: ${this.quarantineBucket}`);
        await this.applyPrivatePolicy(this.quarantineBucket);
      } else {
        this.logger.log(`✅ MinIO quarantine bucket exists: ${this.quarantineBucket}`);
      }
    } catch (error) {
      this.logger.error('Failed to initialize MinIO buckets:', (error as Error).message);
      throw new InternalServerErrorException('Storage initialization failed');
    }
  }

  private async applyPrivatePolicy(bucketName: string) {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
          Condition: {
            StringNotEquals: {
              's3:signatureversion': 'AWS4-HMAC-SHA256',
            },
          },
        },
      ],
    };
    await this.client.setBucketPolicy(bucketName, JSON.stringify(policy));
    this.logger.log(`🔒 Bucket policy set — private access only for ${bucketName}`);
  }

  // ============================================================
  // QUARANTINE LOGIC
  // ============================================================
  async uploadToQuarantine(
    key: string,
    buffer: Buffer,
    mimeType: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    try {
      await this.client.putObject(this.quarantineBucket, key, buffer, buffer.length, {
        'Content-Type': mimeType,
        ...metadata,
      });
      this.logger.log(`Uploaded to quarantine: ${key} (${buffer.length} bytes)`);
      return key;
    } catch (error) {
      this.logger.error(`Upload to quarantine failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('Quarantine file upload failed');
    }
  }

  async promoteFromQuarantine(key: string): Promise<void> {
    try {
      // Copy object from quarantine bucket to main bucket
      const conds = new Minio.CopyConditions();
      await this.client.copyObject(this.bucket, key, `/${this.quarantineBucket}/${key}`, conds);
      
      // Delete from quarantine bucket
      await this.client.removeObject(this.quarantineBucket, key);
      this.logger.log(`Promoted file from quarantine to production: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to promote file from quarantine: ${key}`, (error as Error).message);
      throw new InternalServerErrorException('Failed to promote file');
    }
  }

  async rejectFromQuarantine(key: string, reason: string): Promise<void> {
    try {
      // We can add metadata x-rejected-reason and copy it to a rejected/ prefix
      const rejectedKey = `rejected/${key}`;
      const conds = new Minio.CopyConditions();
      
      // Note: MinIO copyObject doesn't directly allow replacing metadata easily in the simple API without replace-metadata flag
      // We will just copy it to rejected prefix and delete original
      await this.client.copyObject(this.quarantineBucket, rejectedKey, `/${this.quarantineBucket}/${key}`, conds);
      await this.client.removeObject(this.quarantineBucket, key);
      
      this.logger.warn(`Rejected file in quarantine moved to ${rejectedKey}. Reason: ${reason}`);
    } catch (error) {
      this.logger.error(`Failed to reject file in quarantine: ${key}`, (error as Error).message);
    }
  }

  async getFileBufferFromQuarantine(key: string): Promise<Buffer> {
    try {
      const stream = await this.client.getObject(this.quarantineBucket, key);
      const chunks: Buffer[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    } catch (error) {
      this.logger.error(`Get buffer from quarantine failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('Failed to retrieve file from quarantine');
    }
  }

  // ============================================================
  // UPLOAD FILE
  // ============================================================
  async uploadFile(
    key: string,
    buffer: Buffer,
    mimeType: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    try {
      await this.client.putObject(this.bucket, key, buffer, buffer.length, {
        'Content-Type': mimeType,
        ...metadata,
      });

      this.logger.log(`Uploaded: ${key} (${buffer.length} bytes)`);
      return key;
    } catch (error) {
      this.logger.error(`Upload failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('File upload failed');
    }
  }

  // ============================================================
  // GENERATE PRESIGNED URL — 15 minute expiry
  // ============================================================
  async getPresignedUrl(key: string, expirySeconds?: number): Promise<string> {
    try {
      return await this.client.presignedGetObject(
        this.bucket,
        key,
        expirySeconds ?? this.presignExpiry,
      );
    } catch (error) {
      this.logger.error(`Presign failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('Failed to generate presigned URL');
    }
  }

  // ============================================================
  // DELETE FILE
  // ============================================================
  async deleteFile(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key);
      this.logger.log(`Deleted: ${key}`);
    } catch (error) {
      this.logger.error(`Delete failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('File deletion failed');
    }
  }

  // ============================================================
  // PING BUCKET — for health checks
  // ============================================================
  async ping(): Promise<boolean> {
    try {
      await this.client.bucketExists(this.bucket);
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // CHECK IF FILE EXISTS
  // ============================================================
  async fileExists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // GET FILE METADATA
  // ============================================================
  async getFileMetadata(key: string): Promise<Record<string, string>> {
    try {
      const stat = await this.client.statObject(this.bucket, key);
      return (stat.metaData as Record<string, string>) ?? {};
    } catch (error) {
      this.logger.error(`Get metadata failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('Failed to retrieve file metadata');
    }
  }

  // ============================================================
  // GET FILE BUFFER — for compression jobs
  // ============================================================
  async getFileBuffer(key: string): Promise<Buffer> {
    try {
      const stream = await this.client.getObject(this.bucket, key);
      const chunks: Buffer[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    } catch (error) {
      this.logger.error(`Get buffer failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('Failed to retrieve file');
    }
  }

  // ============================================================
  // STREAM FILE TO DISK — for large videos to prevent RAM crash
  // ============================================================
  async streamToFile(key: string, destPath: string): Promise<void> {
    try {
      const stream = await this.client.getObject(this.bucket, key);
      const writer = fs.createWriteStream(destPath);
      await pipeline(stream, writer);
      this.logger.log(`Streamed to disk: ${key} -> ${destPath}`);
    } catch (error) {
      this.logger.error(`Stream to file failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('Failed to stream file to disk');
    }
  }

  // ============================================================
  // UPLOAD FILE FROM DISK — for large videos to prevent RAM crash
  // ============================================================
  async uploadFromFile(
    key: string,
    filePath: string,
    mimeType: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    try {
      const stat = fs.statSync(filePath);
      const readStream = fs.createReadStream(filePath);

      await this.client.putObject(this.bucket, key, readStream, stat.size, {
        'Content-Type': mimeType,
        ...metadata,
      });

      this.logger.log(`Uploaded from disk: ${key} (${stat.size} bytes)`);
      return key;
    } catch (error) {
      this.logger.error(`Upload from file failed for key ${key}:`, (error as Error).message);
      throw new InternalServerErrorException('File upload from disk failed');
    }
  }
}
