// ── Queue and job names — single source of truth
export const MEDIA_QUEUE = 'media-processing';

export const MediaJobs = {
  COMPRESS_IMAGE: 'compress-image',
  COMPRESS_VIDEO: 'compress-video',
  GENERATE_THUMBNAIL: 'generate-thumbnail',
  DELETE_FILE: 'delete-file',
} as const;

// ── Job payload shapes
export interface CompressImageJobData {
  key: string;          // MinIO object key
  uploadedById: string; // authId of uploader
  mimeType: string;
  thumbnailKey: string; // Where to store the generated thumbnail
}

export interface CompressVideoJobData {
  key: string;
  uploadedById: string;
  mimeType: string;
  originalSizeMb: number;
  thumbnailKey: string; // Where to store the generated thumbnail
}

export interface GenerateThumbnailJobData {
  sourceKey: string; // Original file key
  thumbnailKey: string; // Where to store thumbnail
  mediaType: 'image' | 'video';
}

export interface DeleteFileJobData {
  key: string;
  deletedById: string;
}
