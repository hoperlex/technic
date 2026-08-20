import { afterAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * Проверки пары ключей SmartCaptcha при старте (план `docs/smart-captcha-plan.md`, §8).
 *
 * Стерегут единственный класс ошибок, у которого нет внешних признаков: **неверная пара ключей
 * выглядит как работающая капча**. Виджет показывается, токен выдаётся, сервис на проверку
 * отвечает `failed` — и все три публичные формы портала (регистрация, повторное письмо, сброс
 * пароля) молча закрыты для живых людей. Ни строчки в логе, ни всплеска в метрике: `failed` — это
 * же и есть штатный отказ роботу.
 *
 * Отсюда проверки во всех окружениях, а не только в production: перепутать ключи местами или взять
 * их от разных капч (в консоли Yandex Cloud их две — боевая и стендовая, §8) одинаково легко везде,
 * а на стенде цена ошибки — день поисков «почему форма не отправляется».
 *
 * Проверяется вместе с текстом сообщения, а не только факт броска: сообщение здесь и есть весь
 * инструмент — оно единственное, что увидит человек, у которого не поднялся API.
 */

import type { AppConfig } from '../src/config';

/** Первые 20 символов после префикса — общая часть пары; у ключей разных капч они различаются. */
const PAIR_TAIL = 'PZTBoyoWVGA9Kdz2ZLcA';
const OTHER_TAIL = 'Nw7fRq3XmTb1KsPv6Ydu';
const CLIENT_KEY = `ysc1_${PAIR_TAIL}client`;
const SERVER_KEY = `ysc2_${PAIR_TAIL}server`;

/**
 * Существующий файл под `PGSSLROOTCERT`: в production конфигурация требует его раньше, чем
 * доходит до ключей капчи, и без него production-сценарий проверял бы не то сообщение.
 */
const EXISTING_FILE = fileURLToPath(new URL('../package.json', import.meta.url));

const BASE_ENV: Record<string, string> = {
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
};

/**
 * Конфигурация проверяется при импорте `src/config.ts`, поэтому сценарий — это своё окружение плюс
 * своя загрузка модуля: `vi.resetModules()` и динамический импорт. Неудачный сценарий тут не
 * «возвращает ошибку», а роняет сам импорт — ровно как уронил бы старт API.
 */
async function loadConfig(overrides: Record<string, string> = {}): Promise<AppConfig> {
  vi.resetModules();
  Object.assign(process.env, BASE_ENV);
  delete process.env.SMARTCAPTCHA_CLIENT_KEY;
  delete process.env.SMARTCAPTCHA_SERVER_KEY;
  delete process.env.PGSSLROOTCERT;
  Object.assign(process.env, overrides);
  const module = await import('../src/config');
  return module.config;
}

/**
 * Окружение — общее на весь процесс прогона, а соседний файл может грузить конфигурацию своим
 * импортом: оставленный здесь `NODE_ENV=production` потребовал бы от него боевых секретов.
 */
afterAll(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.SMARTCAPTCHA_CLIENT_KEY;
  delete process.env.SMARTCAPTCHA_SERVER_KEY;
  delete process.env.PGSSLROOTCERT;
});

describe('ключи SmartCaptcha в конфигурации', () => {
  it('без обоих ключей капча честно выключена, а не сломана', async () => {
    const config = await loadConfig();

    expect(config.captcha.enabled).toBe(false);
    // Пустая строка, а не `undefined`: ручка `GET /auth/captcha` делает из неё `clientKey: null` —
    // единственный признак «капча выключена», общий для фронта и сервера (§5).
    expect(config.captcha.clientKey).toBe('');
    expect(config.captcha.serverKey).toBe('');
  });

  it('исправная пара включает капчу', async () => {
    const config = await loadConfig({
      SMARTCAPTCHA_CLIENT_KEY: CLIENT_KEY,
      SMARTCAPTCHA_SERVER_KEY: SERVER_KEY,
    });

    expect(config.captcha.enabled).toBe(true);
    expect(config.captcha.clientKey).toBe(CLIENT_KEY);
    expect(config.captcha.serverKey).toBe(SERVER_KEY);
  });

  /**
   * Один ключ без второго нерабочий в обе стороны: с одним клиентским виджет показывается, но его
   * никто не проверяет; с одним серверным сервер требует токен, которого форме неоткуда взять.
   * Оба исхода хуже честно выключенной капчи, и оба молчат.
   */
  it('только клиентский ключ валит старт', async () => {
    await expect(loadConfig({ SMARTCAPTCHA_CLIENT_KEY: CLIENT_KEY })).rejects.toThrow(
      /SMARTCAPTCHA_CLIENT_KEY и SMARTCAPTCHA_SERVER_KEY задаются вместе или не задаются вовсе/,
    );
  });

  it('только серверный ключ валит старт', async () => {
    await expect(loadConfig({ SMARTCAPTCHA_SERVER_KEY: SERVER_KEY })).rejects.toThrow(
      /SMARTCAPTCHA_CLIENT_KEY и SMARTCAPTCHA_SERVER_KEY задаются вместе или не задаются вовсе/,
    );
  });

  it('ключи, переставленные местами, отвергаются с указанием на префикс', async () => {
    const error = await loadConfig({
      SMARTCAPTCHA_CLIENT_KEY: SERVER_KEY,
      SMARTCAPTCHA_SERVER_KEY: CLIENT_KEY,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    // Самая частая ошибка при переносе в `prod.env`: две строки, отличающиеся одним символом.
    expect(error?.message).toMatch(/SMARTCAPTCHA_CLIENT_KEY/);
    expect(error?.message).toMatch(/ysc1_/);
    expect(error?.message).toMatch(/клиентский/);
  });

  /**
   * Ключи от разных капч — обе с верными префиксами, и до этой проверки они выглядят исправной
   * парой. Виджет выдаёт токен одной капчи, а секрет проверяет его у другой: сплошной `failed`,
   * снаружи неотличимый от работающей защиты. Ловится только общей частью пары.
   */
  it('ключи от разных капч отвергаются, хотя префиксы верные', async () => {
    await expect(
      loadConfig({
        SMARTCAPTCHA_CLIENT_KEY: `ysc1_${PAIR_TAIL}client`,
        SMARTCAPTCHA_SERVER_KEY: `ysc2_${OTHER_TAIL}server`,
      }),
    ).rejects.toThrow(/принадлежат разным капчам/);
  });

  /**
   * В production отсутствие ключей — не деградация, о которой можно узнать из метрики, а открытая
   * форма регистрации, которую портал выдал бы за исправную. Поэтому старт, а не предупреждение.
   */
  it('в production без ключей API не поднимается', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'production', PGSSLROOTCERT: EXISTING_FILE }),
    ).rejects.toThrow(/SMARTCAPTCHA_CLIENT_KEY и SMARTCAPTCHA_SERVER_KEY обязательны в production/);
  });

  /**
   * Обрезанная пара — единственная поломка, которую три прежние проверки пропускали целиком:
   * префиксы на месте, а «общие 20 символов» у обоих пусты, и `slice(5, 25)` честно сходится сам с
   * собой. Портал поднимался с включённой капчей и пятисимвольным секретом, то есть со сплошным
   * `failed` на всех формах — ровно тем исходом, против которого сверка пары и написана. Обрезать
   * ключ проще всего там, где это никто не увидит: перенос строки в `prod.env`, лимит длины
   * значения в CI.
   */
  it('обрезанная пара `ysc1_`/`ysc2_` отвергается по длине', async () => {
    const error = await loadConfig({
      SMARTCAPTCHA_CLIENT_KEY: 'ysc1_',
      SMARTCAPTCHA_SERVER_KEY: 'ysc2_',
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toMatch(/SMARTCAPTCHA_CLIENT_KEY/);
    expect(error?.message).toMatch(/короче 25 символов/);
    expect(error?.message).toMatch(/обрезан при переносе/);
  });
});
