import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://portal.test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
  JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
  COOKIE_SECRET: 'test-cookie-secret-value',
  CSRF_SECRET: 'test-csrf-secret-value',
  S3_ENDPOINT: 'https://s3.test.local',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  LOG_LEVEL: 'fatal',
  MAIL_ENABLED: 'false',
  MAIL_FROM: 'Portal <portal@example.invalid>',
  MAIL_REPLY_TO: 'portal-replies@example.invalid',
  MAIL_ACCOUNT_REPAIR_HOST: 'm.example.invalid',
  MAIL_ACCOUNT_REPAIR_FROM: 'Ремонт <repair@example.invalid>',
};

async function loadConfig(recipients?: string, from = BASE_ENV.MAIL_ACCOUNT_REPAIR_FROM) {
  vi.resetModules();
  for (const [name, value] of Object.entries(BASE_ENV)) vi.stubEnv(name, value);
  vi.stubEnv('SMARTCAPTCHA_CLIENT_KEY', undefined);
  vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', undefined);
  vi.stubEnv('SERVICE_MAIL_EXTRA_RECIPIENTS', recipients);
  vi.stubEnv('MAIL_ACCOUNT_REPAIR_FROM', from);
  return (await import('../src/config')).config;
}

afterEach(() => vi.unstubAllEnvs());

describe('extra service mailboxes', () => {
  it.each([undefined, '', '  ', ' , , '])('defaults to no extra delivery for %j', async (raw) => {
    const config = await loadConfig(raw);
    expect(config.serviceRequests.mailExtraRecipients).toEqual([]);
  });

  it('normalizes and deduplicates destinations without changing sender or Reply-To', async () => {
    const config = await loadConfig(' Repair@SU-10.RU,other@example.invalid,repair@su-10.ru ');
    expect(config.serviceRequests.mailExtraRecipients).toEqual([
      'repair@su-10.ru',
      'other@example.invalid',
    ]);
    expect(config.mail.accounts.repair.from).toBe(BASE_ENV.MAIL_ACCOUNT_REPAIR_FROM);
    expect(config.mail.from).toBe(BASE_ENV.MAIL_FROM);
    expect(config.mail.replyTo).toBe(BASE_ENV.MAIL_REPLY_TO);
  });

  it.each([
    'not-an-address',
    'valid@example.invalid,broken@',
    'Service <repair@example.invalid>',
    'one@example.invalid;two@example.invalid',
  ])('refuses invalid trusted destinations before any letter can be queued: %s', async (raw) => {
    await expect(loadConfig(raw)).rejects.toThrow('SERVICE_MAIL_EXTRA_RECIPIENTS');
  });

  it('supports the temporary new SMTP identity with the legacy mailbox as an extra recipient', async () => {
    const from = 'Ремонт <repair@su-10.ru>';
    const config = await loadConfig('repair@mstroy.pro', from);
    expect(config.mail.accounts.repair.from).toBe(from);
    expect(config.serviceRequests.mailExtraRecipients).toEqual(['repair@mstroy.pro']);
  });
});
