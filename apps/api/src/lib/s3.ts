import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

export const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
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
  const cmd = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: objectKey,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn: config.s3.uploadUrlTtl });
}

export function presignGet(objectKey: string, filename?: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: objectKey,
    ResponseContentDisposition: filename
      ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      : undefined,
  });
  return getSignedUrl(s3, cmd, { expiresIn: config.s3.downloadUrlTtl });
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
