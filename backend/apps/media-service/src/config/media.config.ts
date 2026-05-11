import { registerAs } from '@nestjs/config';

export default registerAs('media', () => ({
  minio: {
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: parseInt(process.env.MINIO_PORT ?? '9000', 10),
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucket: process.env.MINIO_BUCKET ?? 'lagos-waste-media',
    useSSL: process.env.NODE_ENV === 'prod',
    presignExpiry: 15 * 60, // 15 minutes in seconds
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  upload: {
    maxImageSizeMb: 10, // 10MB max per image
    maxVideoSizeMb: 100, // 100MB max per video
    maxFilesPerUpload: 5, // Max 5 files at once
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
    allowedVideoTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'],
  },
  compression: {
    image: {
      quality: 80, // WebP quality (0-100)
      maxWidthPx: 1920, // Max width — preserves aspect ratio
      maxHeightPx: 1080,
    },
    video: {
      crf: 28, // FFmpeg CRF (lower = better quality, larger file)
      preset: 'fast', // FFmpeg preset (fast = good balance)
      maxBitrate: '2M', // Max 2Mbps output
    },
    thumbnail: {
      widthPx: 400,
      heightPx: 400,
      quality: 70,
    },
  },
}));
