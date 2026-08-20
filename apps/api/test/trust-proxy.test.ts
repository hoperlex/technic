import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Разбор `TRUST_PROXY` (`docs/smart-captcha-plan.md`, §6).
 *
 * Проверяется здесь **только разбор переменной окружения** — во что превращается строка перед тем,
 * как уйти в опцию `trustProxy` Fastify. Защиту от подмены `X-Forwarded-For` этот тест не
 * доказывает и доказать не может: при `trustProxy=1` запрос, поданный напрямую через `app.inject`
 * с подставленным `X-Forwarded-For`, как раз и будет принят за клиентский — прокси перед ним нет,
 * и подставленный адрес станет `req.ip`. Такой тест «прошёл бы» и на заведомо дырявой настройке.
 * Защиту доказывает приёмка через оба nginx (там же, §6): восемь запросов с внешнего хоста, каждый
 * со своим `X-Forwarded-For`, шестой обязан получить 429, а в логе API — реальный адрес.
 *
 * Ради чего тогда этот тест. Ветка числа — единственная, чья поломка молчит: строка `'1'` без неё
 * уходит в `proxy-addr` как адрес, и вместо «доверяем одному хопу» получается «не доверяем
 * никому». Ни лога, ни падения при старте; замечают по тому, что лимиты по адресу считают весь
 * портал одним источником.
 */

// Функция живёт в `src/app.ts`, а он при импорте читает конфиг из окружения — отсюда те же
// подстановки и тот же отложенный импорт, что и в остальных тестах приложения.
import type * as AppModule from '../src/app';

let parseTrustProxy: typeof AppModule.parseTrustProxy;

beforeAll(async () => {
  Object.assign(process.env, {
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
  });
  ({ parseTrustProxy } = await import('../src/app'));
  // Своя граница времени: на холодном кеше vite трансформация приложения занимает больше десяти
  // секунд, и умолчание vitest уронило бы прогон на сборке, а не на проверке.
}, 60_000);

describe('parseTrustProxy', () => {
  it('без переменной и при `true` доверяет заголовку целиком', () => {
    expect(parseTrustProxy(undefined)).toBe(true);
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('при `false` не разбирает заголовок вовсе', () => {
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('целое переводит в число хопов — иначе `1` ушло бы в proxy-addr как адрес', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('ноль сохраняет числом: «ни одного доверенного хопа» — не то же самое, что `false`', () => {
    expect(parseTrustProxy('0')).toBe(0);
  });

  it('список через запятую разбирает в массив, обрезая пробелы', () => {
    expect(parseTrustProxy('10.0.0.1, 172.16.0.0/12,192.168.0.1')).toEqual([
      '10.0.0.1',
      '172.16.0.0/12',
      '192.168.0.1',
    ]);
  });

  it('одиночный адрес и подсеть отдаёт строкой как есть', () => {
    expect(parseTrustProxy('10.0.0.1')).toBe('10.0.0.1');
    expect(parseTrustProxy('172.16.0.0/12')).toBe('172.16.0.0/12');
    // Именованные пресеты proxy-addr (`loopback`, `uniquelocal`) — тоже строки и тоже проходят
    // мимо ветки числа: цифрами они не записываются.
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });

  it('отрицательное числом не считает — числовая ветка только для целых без знака', () => {
    expect(parseTrustProxy('-1')).toBe('-1');
  });
});
