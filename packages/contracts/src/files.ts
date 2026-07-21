import { z } from 'zod';
import type { FileStatus } from './enums';

export const createUploadSessionSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(150),
  size: z.number().int().positive(),
});
export type CreateUploadSessionInput = z.infer<typeof createUploadSessionSchema>;

export interface UploadSessionDto {
  fileId: string;
  uploadUrl: string;
  objectKey: string;
  /** секунды до истечения presigned URL */
  expiresIn: number;
}

export interface FileDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  status: FileStatus;
  createdAt: string;
}

export interface DownloadUrlDto {
  url: string;
  expiresIn: number;
}
