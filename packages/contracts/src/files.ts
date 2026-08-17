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

/**
 * Подшитый файл глазами читающего экрана: имя, тип и размер — ровно то, чем рисуется ссылка.
 *
 * `FileDto` тут не годится: он описывает файл **на пути загрузки** — статус и дату создания, то
 * есть то, что нужно форме, пока файл ничей. Читающему экрану они не нужны, а обещать их пришлось
 * бы каждому модулю, который перечисляет свои вложения.
 *
 * Одних идентификаторов мало, и это главное в типе. Список `string[]` в DTO означает, что портал
 * рисует ссылку с сочинённой подписью («Скан 1»), не зная ни имени, ни размера, ни того, откроется
 * ли за ней что-нибудь. Так жили фотографии показаний и скан акта ТО — и оба экрана показывали
 * подшитое строками без имени.
 *
 * Тип общий намеренно: модулей с вложениями уже шесть, и собственный близнец из четырёх полей в
 * каждом из них — это шесть мест, где однажды разойдётся смысл поля `size`. Модулю, которому мало
 * этих четырёх, никто не мешает описать свой тип поверх — так сделан `ServiceRequestFileDto` с
 * видом документа и датой подшивки.
 */
export interface AttachedFileDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface DownloadUrlDto {
  url: string;
  expiresIn: number;
}

/**
 * Как отдавать файл по ссылке: `attachment` — скачать, `inline` — показать содержимое
 * (портал открывает такую ссылку окном просмотра: картинкой или фреймом).
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
