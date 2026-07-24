import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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
  const ext = extname(filename).toLowerCase().slice(0, 12).replace(/[^.a-z0-9]/g, '');
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

export function presignGet(objectKey: string, filename?: string): Promise<string> {
  return presignGetUrl(s3, {
    bucket: config.s3.bucket,
    key: objectKey,
    filename,
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
