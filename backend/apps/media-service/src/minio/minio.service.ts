import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private client: Minio.Client;
  private bucket: string;
  private presignExpiry: number;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('media.minio.bucket')!;
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
      const exists = await this.client.bucketExists(this.bucket);

      if (!exists) {
        await this.client.makeBucket(this.bucket, 'us-east-1');
        this.logger.log(`✅ MinIO bucket created: ${this.bucket}`);
      } else {
        this.logger.log(`✅ MinIO bucket exists: ${this.bucket}`);
      }

      // ── Enforce private bucket policy — NO public access
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Deny',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${this.bucket}/*`],
            Condition: {
              StringNotEquals: {
                's3:signatureversion': 'AWS4-HMAC-SHA256',
              },
            },
          },
        ],
      };

      await this.client.setBucketPolicy(this.bucket, JSON.stringify(policy));

      this.logger.log('🔒 Bucket policy set — private access only');
    } catch (error) {
      this.logger.error('Failed to initialize MinIO bucket:', (error as Error).message);
      throw new InternalServerErrorException('Storage initialization failed');
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
}
