// ── Queue and job names — single source of truth
export const MEDIA_QUEUE = 'media-processing';

export const MediaJobs = {
  COMPRESS_IMAGE: 'compress-image',
  COMPRESS_VIDEO: 'compress-video',
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


export interface DeleteFileJobData {
  key: string;
  deletedById: string;
  thumbnailKey?: string; // Optional — if provided, processor skips "guessing" logic
}
