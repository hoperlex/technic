import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Капча (ADR 0034). Проверяется не «похожа ли картинка на цифры» — это дело глаз, — а
 * свойства челленджа: он подписан, одноразов, протухает и не даёт ответить мгновенно.
 * Каждое из них по отдельности молча превращает капчу в декорацию.
 */

// Модули импортируются внутри beforeAll: конфиг читает окружение при импорте, и переменные
// нужно выставить раньше. Отсюда же типы — через `await import` в типовой позиции нельзя.
import type * as CaptchaModule from '../src/auth/captcha';
import type * as CaptchaImageModule from '../src/auth/captcha-image';

let issueCaptcha: typeof CaptchaModule.issueCaptcha;
let verifyCaptcha: typeof CaptchaModule.verifyCaptcha;
let resetCaptchaState: typeof CaptchaModule.resetCaptchaState;
let renderCaptcha: typeof CaptchaImageModule.renderCaptcha;

/** Ответ, выданный достаточно давно, чтобы пройти проверку «не быстрее человека». */
const solvedByHuman = () => Date.now() - 10_000;

beforeAll(async () => {
  // Конфиг читается из окружения при импорте модуля: секрет капчи выводится из COOKIE_SECRET.
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
  });
  ({ issueCaptcha, verifyCaptcha, resetCaptchaState } = await import('../src/auth/captcha'));
  ({ renderCaptcha } = await import('../src/auth/captcha-image'));
});

beforeEach(() => resetCaptchaState());

describe('челлендж', () => {
  it('верный ответ принимается', () => {
    const captcha = issueCaptcha(solvedByHuman());
    expect(() => verifyCaptcha(captcha.token, captcha.code)).not.toThrow();
  });

  it('неверный ответ отклоняется', () => {
    const captcha = issueCaptcha(solvedByHuman());
    expect(() => verifyCaptcha(captcha.token, '00000')).toThrow();
  });

  it('код состоит из пяти цифр без нуля и единицы — их путают с «O» и «7»', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(issueCaptcha().code).toMatch(/^[2-9]{5}$/);
    }
  });

  it('разгадки в токене нет: подобрать её без секрета нельзя', () => {
    const captcha = issueCaptcha(solvedByHuman());
    const payload = Buffer.from(captcha.token.split('.')[0]!, 'base64url').toString('utf8');
    expect(payload).not.toContain(captcha.code);
  });
});

describe('одноразовость и срок', () => {
  it('решённый челлендж повторно не принимается', () => {
    const captcha = issueCaptcha(solvedByHuman());
    verifyCaptcha(captcha.token, captcha.code);
    expect(() => verifyCaptcha(captcha.token, captcha.code)).toThrow();
  });

  it('неверная попытка тоже расходует челлендж — иначе по одной картинке шёл бы перебор', () => {
    const captcha = issueCaptcha(solvedByHuman());
    expect(() => verifyCaptcha(captcha.token, '22222')).toThrow();
    expect(() => verifyCaptcha(captcha.token, captcha.code)).toThrow();
  });

  it('просроченный челлендж не принимается', () => {
    const captcha = issueCaptcha(Date.now() - 10 * 60 * 1000);
    expect(() => verifyCaptcha(captcha.token, captcha.code)).toThrow();
  });

  it('мгновенный ответ отклоняется: человек не успевает прочесть картинку', () => {
    const captcha = issueCaptcha();
    expect(() => verifyCaptcha(captcha.token, captcha.code)).toThrow();
  });
});

describe('подпись', () => {
  it('подменённый токен отвергается', () => {
    const captcha = issueCaptcha(solvedByHuman());
    const [body, signature] = captcha.token.split('.');
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as {
      exp: number;
    };
    tampered.exp += 3_600_000;
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;
    expect(() => verifyCaptcha(forged, captcha.code)).toThrow();
  });

  it('мусор вместо токена не роняет сервер', () => {
    expect(() => verifyCaptcha('не-токен', '22222')).toThrow();
    expect(() => verifyCaptcha('', '22222')).toThrow();
  });
});

describe('картинка', () => {
  it('это PNG, и он приходит data-URL’ом', () => {
    const png = renderCaptcha('47293');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(200);
    expect(issueCaptcha().image.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('одинаковый код рисуется по-разному: картинку нельзя сопоставить с ответом по хэшу', () => {
    expect(renderCaptcha('47293').equals(renderCaptcha('47293'))).toBe(false);
  });
});
