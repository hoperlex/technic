import { describe, expect, it } from 'vitest';
import { createS3Client, presignPutUrl } from '../src/lib/s3-client';

// Проверяем presigned PUT без загрузки полного конфига приложения: createS3Client и
// presignPutUrl config-free. Секрет заведомо «утечка-детектор».
const SECRET_ACCESS_KEY = 'unit-test-secret-must-not-leak-into-url';

const client = createS3Client({
  region: 'ru-central-1',
  endpoint: 'https://s3.cloud.ru',
  forcePathStyle: false,
  accessKeyId: 'TENANT_ID:KEY_ID',
  secretAccessKey: SECRET_ACCESS_KEY,
});

describe('presignPutUrl', () => {
  it('подписывает PUT с нужным endpoint/bucket и без авто-checksum', async () => {
    const url = await presignPutUrl(client, {
      bucket: 'technic-portal-files',
      key: 'waste-requests/2026/07/example.pdf',
      contentType: 'application/pdf',
      expiresIn: 600,
    });
    const u = new URL(url);
    const query = u.search.toLowerCase();

    // endpoint + bucket (virtual-hosted: bucket в host) + ключ объекта
    expect(u.host).toContain('s3.cloud.ru');
    expect(u.host).toContain('technic-portal-files');
    expect(u.pathname).toContain('waste-requests/2026/07/example.pdf');

    // presigned URL с временем жизни
    expect(query).toContain('x-amz-expires');

    // НЕТ автоматического checksum пустого payload
    expect(query).not.toContain('x-amz-checksum-crc32');
    expect(query).not.toContain('x-amz-sdk-checksum-algorithm');

    // content-type подписан → простой preflight (content-type)
    const signedHeaders = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').toLowerCase().split(';');
    expect(signedHeaders).toContain('content-type');

    // секретный ключ не попадает в URL
    expect(url).not.toContain(SECRET_ACCESS_KEY);
  });
});
