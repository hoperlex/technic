import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config';

/**
 * Предусловие выпуска 2 «Заморозка»: пол версии клиента (план `docs/auto-part-receipts-plan.md`,
 * Р22, Р23).
 *
 * ЧТО ЗДЕСЬ ОХРАНЯЕТСЯ. Порядок «сначала пол 3, потом заморозка» до сих пор держался текстом плана,
 * а текст не исполняется. Цена нарушения — не сбой, который видно: выкаченный раньше времени
 * выпуск 2 отдаёт открытым вкладкам ответ без `parts` и 404 на `/auto-parts`, и человек видит
 * белый экран журнала ТО, не понимая, что у него просто старая статика. Пол превращает это в
 * честный 426 «обновите страницу».
 *
 * Поэтому проверяются три разных утверждения, и каждое ломается отдельно:
 *   1. в production пол ниже трёх ВАЛИТ старт — иначе выкат объявляется состоявшимся по зелёному
 *      health, и предусловие остаётся благим намерением;
 *   2. пол три и выше поднимается — проверка не должна требовать РАВЕНСТВА: пол растёт от выпуска
 *      к выпуску, и следующий подъём не обязан ронять этот же код;
 *   3. вне production не проверяется вовсе — в деве и тестах `MIN_CLIENT_CONTRACT` не задан и
 *      берёт умолчание 1; старых вкладок там нет, а `pnpm dev`, падающий на предусловии выката,
 *      выключил бы разработку всем сразу.
 *
 * Текст отказа проверяется наравне с фактом броска: он и есть весь инструмент — человек, у
 * которого не поднялся API, видит только его, и знать ему надо не «что не так», а «что нажать».
 */

/**
 * Существующий файл под `PGSSLROOTCERT`: в production конфигурация требует его раньше, чем доходит
 * до пола, и без него production-сценарий проверял бы не то сообщение.
 */
const EXISTING_FILE = fileURLToPath(new URL('../package.json', import.meta.url));

/** Пара ключей капчи: она тоже обязательна в production и тоже стоит до проверки пола. */
const CAPTCHA_PAIR_TAIL = 'PZTBoyoWVGA9Kdz2ZLcA';
const CAPTCHA_CLIENT_KEY = `ysc1_${CAPTCHA_PAIR_TAIL}client`;
const CAPTCHA_SERVER_KEY = `ysc2_${CAPTCHA_PAIR_TAIL}server`;

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

/** Всё, что сценарий выставляет сам: между случаями это чистится, чтобы они не наследовались. */
const SCENARIO_KEYS = [
  'MIN_CLIENT_CONTRACT',
  'PGSSLROOTCERT',
  'SMARTCAPTCHA_CLIENT_KEY',
  'SMARTCAPTCHA_SERVER_KEY',
];

/**
 * Конфигурация проверяется при импорте `src/config.ts`, поэтому сценарий — это своё окружение плюс
 * своя загрузка модуля. Неудачный сценарий здесь не «возвращает ошибку», а роняет сам импорт —
 * ровно как уронил бы старт API.
 */
async function loadConfig(overrides: Record<string, string> = {}): Promise<AppConfig> {
  vi.resetModules();
  Object.assign(process.env, BASE_ENV);
  for (const key of SCENARIO_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  const module = await import('../src/config');
  return module.config;
}

/** Окружение общее на весь процесс прогона: оставленный `NODE_ENV=production` сломал бы соседей. */
afterAll(() => {
  process.env.NODE_ENV = 'test';
  for (const key of SCENARIO_KEYS) delete process.env[key];
});

/** Production без пола вообще: остальные обязательные в проде значения заданы, спор только о поле. */
const PROD_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  PGSSLROOTCERT: EXISTING_FILE,
  SMARTCAPTCHA_CLIENT_KEY: CAPTCHA_CLIENT_KEY,
  SMARTCAPTCHA_SERVER_KEY: CAPTCHA_SERVER_KEY,
};

describe('предусловие «Заморозки»: пол версии клиента', () => {
  it('в production пол 2 валит старт и называет команду, а не условие', async () => {
    const error = await loadConfig({ ...PROD_ENV, MIN_CLIENT_CONTRACT: '2' }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    // Команда целиком, вместе с числом: «поднимите пол» без неё отправляет человека читать план.
    expect(error?.message).toMatch(/deploy-auto --client-floor=3/);
    expect(error?.message).toMatch(/MIN_CLIENT_CONTRACT >= 3/);
  });

  /**
   * Умолчание — самый вероятный способ выкатить заморозку раньше времени: пол не трогали вовсе,
   * `prod.env` про него не знает, и фаза A выглядит как «всё в порядке».
   */
  it('в production пол по умолчанию (1) валит старт', async () => {
    await expect(loadConfig(PROD_ENV)).rejects.toThrow(/deploy-auto --client-floor=3/);
  });

  it('в production пол 3 поднимается', async () => {
    const config = await loadConfig({ ...PROD_ENV, MIN_CLIENT_CONTRACT: '3' });

    expect(config.clientGate.minContract).toBe(3);
  });

  /**
   * Пол растёт от выпуска к выпуску, и следующий подъём не обязан ронять этот код: требование —
   * «не ниже трёх», а не «ровно три».
   */
  it('в production пол выше требуемого поднимается', async () => {
    const config = await loadConfig({ ...PROD_ENV, MIN_CLIENT_CONTRACT: '5' });

    expect(config.clientGate.minContract).toBe(5);
  });

  it('вне production пол не задан и старт не трогается', async () => {
    const config = await loadConfig();

    expect(config.isProd).toBe(false);
    expect(config.clientGate.minContract).toBe(1);
  });

  /** Дев с явно низким полом — тоже не повод падать: предусловие про выкат, а не про запуск. */
  it('вне production низкий пол не мешает', async () => {
    const config = await loadConfig({ MIN_CLIENT_CONTRACT: '1' });

    expect(config.clientGate.minContract).toBe(1);
  });
});
