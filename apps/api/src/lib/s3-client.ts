import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Config-free фабрика и presign-хелперы S3 (без зависимости от ../config),
// чтобы их можно было юнит-тестировать без полного окружения приложения.

export interface S3ClientOptions {
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3Client с ОТКЛЮЧЁННЫМ автоматическим checksum.
 *
 * AWS SDK v3 (>=3.729) по умолчанию добавляет CRC32-checksum к PutObject. При создании
 * presigned URL тела файла нет, поэтому в подпись попадает checksum пустого payload
 * (`x-amz-checksum-crc32=AAAAAA==`) плюс `x-amz-sdk-checksum-algorithm=CRC32`. Браузер
 * при прямом PUT вынужден слать эти `x-amz-*` заголовки, они не проходят CORS-preflight
 * бакета (AllowedHeaders их не содержит) → загрузка падает. `WHEN_REQUIRED` убирает
 * авто-checksum там, где он не обязателен (PutObject).
 */
export function createS3Client(opts: S3ClientOptions): S3Client {
  return new S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
    forcePathStyle: opts.forcePathStyle,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Presigned PUT. Подписываем только `content-type` (браузер его гарантированно
 * передаёт при PUT), чтобы preflight оставался простым. Content-Length НЕ подписываем.
 */
export function presignPutUrl(
  client: S3Client,
  params: { bucket: string; key: string; contentType: string; expiresIn: number },
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ContentType: params.contentType,
  });
  return getSignedUrl(client, cmd, {
    expiresIn: params.expiresIn,
    signableHeaders: new Set(['content-type']),
  });
}

/** Presigned GET (скачивание с Content-Disposition attachment). */
export function presignGetUrl(
  client: S3Client,
  params: { bucket: string; key: string; filename?: string; expiresIn: number },
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ResponseContentDisposition: params.filename
      ? `attachment; filename*=UTF-8''${encodeURIComponent(params.filename)}`
      : undefined,
  });
  return getSignedUrl(client, cmd, { expiresIn: params.expiresIn });
}
