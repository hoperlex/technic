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

/**
 * Как отдавать файл по ссылке: `attachment` — скачать, `inline` — открыть во вкладке.
 * Просмотр нужен талонам и фото объекта: скан удобнее посмотреть, чем сохранять на диск.
 */
export const FILE_DISPOSITIONS = ['attachment', 'inline'] as const;
export const fileDispositionSchema = z.enum(FILE_DISPOSITIONS);
export type FileDisposition = (typeof FILE_DISPOSITIONS)[number];

export const fileDownloadQuerySchema = z.object({
  disposition: fileDispositionSchema.optional().default('attachment'),
});

/**
 * Типы, которые браузер показывает сам и которые безопасно отдавать инлайном. Всё остальное
 * (в том числе html и svg — они исполняют скрипты) уходит вложением: presigned-ссылка живёт
 * на домене хранилища, и открывать там чужую разметку незачем.
 */
const INLINE_CONTENT_TYPES = new Set(['application/pdf', 'text/plain']);

export function isInlineViewable(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml') return false;
  return type.startsWith('image/') || INLINE_CONTENT_TYPES.has(type);
}
