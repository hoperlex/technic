import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';
import { createS3Client, presignGetUrl, presignPutUrl } from './s3-client';

export const s3 = createS3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
});

/** object key генерируется backend (не конкатенацией пользовательского ввода, §15). */
export function buildObjectKey(filename: string): string {
  const id = randomUUID();
  const ext = extname(filename)
    .toLowerCase()
    .slice(0, 12)
    .replace(/[^.a-z0-9]/g, '');
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `waste-requests/${yyyy}/${mm}/${id}${ext}`;
}

export function presignPut(objectKey: string, contentType: string): Promise<string> {
  return presignPutUrl(s3, {
    bucket: config.s3.bucket,
    key: objectKey,
    contentType,
    expiresIn: config.s3.uploadUrlTtl,
  });
}

export function presignGet(
  objectKey: string,
  filename?: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<string> {
  return presignGetUrl(s3, {
    bucket: config.s3.bucket,
    key: objectKey,
    filename,
    disposition,
    expiresIn: config.s3.downloadUrlTtl,
  });
}

export async function headObject(
  objectKey: string,
): Promise<{ size: number; contentType: string | undefined } | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType };
  } catch {
    return null;
  }
}

/**
 * Запись объекта ИЗ ПРИЛОЖЕНИЯ (план `docs/office-equipment-mail-telemetry-plan.md`, Р25).
 *
 * Весь остальной портал грузит файлы иначе — браузером по подписанной ссылке, — и до сих пор
 * серверной записи здесь не было вовсе. Письмо аппарата так грузить некому: его приносит worker
 * телом внутреннего запроса, а worker в хранилище писать не умеет (у него импортированы только
 * удаление и чтение). Отсюда и эта функция: сырьё кладёт API, в одном месте с подсчётом его хеша.
 *
 * Тело принимается буфером, а не потоком: письмо ограничено потолком в несколько мегабайт, и
 * поток здесь дал бы только возможность записать половину.
 */
export async function putObject(
  objectKey: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Идемпотентно: удаление отсутствующего объекта считается успехом (§15). */
export async function deleteObject(objectKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return;
    throw e;
  }
}
