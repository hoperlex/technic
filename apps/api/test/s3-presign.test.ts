import { describe, expect, it } from 'vitest';
import { createS3Client, presignGetUrl, presignPutUrl } from '../src/lib/s3-client';

// Проверяем presigned PUT без загрузки полного конфига приложения: createS3Client и
// presignPutUrl config-free. Секрет заведомо «утечка-детектор».
const SECRET_ACCESS_KEY = 'unit-test-secret-must-not-leak-into-url';

// forcePathStyle=true — как в проде: cloud.ru отдаёт 403 AccessDenied на virtual-hosted-style
// (`<bucket>.s3.cloud.ru`), включая анонимный CORS-preflight. См. docs/setup-infra.md §3.
const client = createS3Client({
  region: 'ru-central-1',
  endpoint: 'https://s3.cloud.ru',
  forcePathStyle: true,
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

    // path-style: bucket в пути, host — чистый endpoint (bucket НЕ в host)
    expect(u.host).toBe('s3.cloud.ru');
    expect(u.pathname).toBe('/technic-portal-files/waste-requests/2026/07/example.pdf');

    // presigned URL с временем жизни
    expect(query).toContain('x-amz-expires');

    // НЕТ автоматического checksum пустого payload
    expect(query).not.toContain('x-amz-checksum-crc32');
    expect(query).not.toContain('x-amz-sdk-checksum-algorithm');

    // content-type подписан → простой preflight (content-type)
    const signedHeaders = (u.searchParams.get('X-Amz-SignedHeaders') ?? '')
      .toLowerCase()
      .split(';');
    expect(signedHeaders).toContain('content-type');

    // секретный ключ не попадает в URL
    expect(url).not.toContain(SECRET_ACCESS_KEY);
  });
});

describe('presignGetUrl', () => {
  it('по умолчанию отдаёт файл вложением с исходным именем', async () => {
    const url = await presignGetUrl(client, {
      bucket: 'technic-portal-files',
      key: 'waste-requests/2026/07/example.pdf',
      filename: 'Талон №1.pdf',
      expiresIn: 600,
    });
    const disposition = new URL(url).searchParams.get('response-content-disposition') ?? '';
    expect(disposition).toContain('attachment;');
    // Кириллица в имени уходит в RFC 5987 — иначе подпись не сойдётся с заголовком.
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('Талон №1.pdf')}`);
    expect(url).not.toContain(SECRET_ACCESS_KEY);
  });

  it('inline открывает файл во вкладке, имя при сохранении сохраняется', async () => {
    const url = await presignGetUrl(client, {
      bucket: 'technic-portal-files',
      key: 'waste-requests/2026/07/ticket.jpg',
      filename: 'ticket.jpg',
      disposition: 'inline',
      expiresIn: 600,
    });
    const disposition = new URL(url).searchParams.get('response-content-disposition') ?? '';
    expect(disposition).toContain('inline;');
    expect(disposition).toContain("filename*=UTF-8''ticket.jpg");
  });
});
