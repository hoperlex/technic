import { createHmac, hkdfSync, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { CAPTCHA_ANSWER_LENGTH } from '@technic/contracts';
import { config } from '../config';
import { err } from '../lib/errors';
import { CAPTCHA_ALPHABET, renderCaptcha } from './captcha-image';

// ── Челлендж капчи ──
// Разгадка на сервере не хранится: она уезжает клиенту внутри подписанного токена в виде HMAC.
// Значит нет ни таблицы, ни Redis, ни уборки — а подделать челлендж без секрета нельзя.
//
// Единственное состояние — идентификаторы уже использованных челленджей: без них решённую один
// раз капчу можно было бы предъявлять повторно, пока не истечёт. Список живёт в памяти процесса,
// и это осознанно: API работает одним экземпляром, а перезапуск теряет записи со сроком жизни в
// три минуты. Появится вторая реплика — список переезжает в таблицу (см. ADR 0034).

const TTL_MS = 180_000;

/**
 * Нижняя граница времени между показом картинки и отправкой формы. Человек не успевает
 * разглядеть пять искажённых цифр и напечатать их быстрее; скрипт отправляет мгновенно.
 * Отдельного поля с временем на форме не нужно — момент выдачи уже подписан в токене.
 */
const MIN_SOLVE_MS = 2_000;

/** Секрет челленджа выводится из COOKIE_SECRET: отдельная метка не даёт пересечься назначениям. */
const SECRET = Buffer.from(
  hkdfSync('sha256', config.auth.cookieSecret, 'technic-captcha', 'captcha-v1', 32),
);

interface ChallengePayload {
  /** Идентификатор челленджа: он же ключ одноразовости и соль ответа. */
  jti: string;
  /** Момент выдачи, мс. */
  iat: number;
  /** Момент истечения, мс. */
  exp: number;
  /** HMAC от ответа — сам ответ на сервер не возвращается и нигде не хранится. */
  answerMac: string;
}

const consumed = new Map<string, number>();

function sweepConsumed(now: number): void {
  for (const [jti, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(jti);
  }
}

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

function macAnswer(jti: string, answer: string): string {
  return sign(`answer:${jti}:${answer}`);
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeToken(payload: ChallengePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function decodeToken(token: string): ChallengePayload {
  const [body, signature] = token.split('.');
  if (!body || !signature || !equals(sign(body), signature)) {
    throw err.badRequest('Проверка не пройдена — обновите картинку', {
      captchaAnswer: 'Обновите картинку и попробуйте снова',
    });
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ChallengePayload;
  } catch {
    throw err.badRequest('Проверка не пройдена — обновите картинку', {
      captchaAnswer: 'Обновите картинку и попробуйте снова',
    });
  }
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CAPTCHA_ANSWER_LENGTH; i += 1) {
    code += CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)];
  }
  return code;
}

export interface IssuedCaptcha {
  token: string;
  /** `data:image/png;base64,…` */
  image: string;
  expiresIn: number;
  /**
   * Загаданный код. Наружу не отдаётся — существует ради тестов, которым иначе пришлось бы
   * распознавать собственную картинку.
   */
  code: string;
}

/**
 * @param issuedAt — момент выдачи; тесты сдвигают его в прошлое, чтобы не ждать `MIN_SOLVE_MS`.
 */
export function issueCaptcha(issuedAt = Date.now()): IssuedCaptcha {
  sweepConsumed(Date.now());
  const code = randomCode();
  const jti = randomUUID();
  const token = encodeToken({
    jti,
    iat: issuedAt,
    exp: issuedAt + TTL_MS,
    answerMac: macAnswer(jti, code),
  });
  return {
    token,
    image: `data:image/png;base64,${renderCaptcha(code).toString('base64')}`,
    expiresIn: Math.floor(TTL_MS / 1000),
    code,
  };
}

/**
 * Проверяет ответ и гасит челлендж. Челлендж расходуется при любом исходе — иначе один токен
 * позволял бы перебирать 32 768 вариантов кода.
 */
export function verifyCaptcha(token: string, answer: string): void {
  const now = Date.now();
  const payload = decodeToken(token);

  const expired = payload.exp <= now;
  const alreadyUsed = consumed.has(payload.jti);
  const tooFast = now - payload.iat < MIN_SOLVE_MS;

  sweepConsumed(now);
  consumed.set(payload.jti, payload.exp);

  if (expired || alreadyUsed) {
    throw err.badRequest('Срок действия картинки истёк — обновите её', {
      captchaAnswer: 'Обновите картинку и попробуйте снова',
    });
  }
  // Заполнить форму быстрее двух секунд человек не может — отвечаем как на неверный код, не
  // подсказывая скрипту, что его выдало именно время.
  if (tooFast || !equals(payload.answerMac, macAnswer(payload.jti, answer))) {
    throw err.badRequest('Неверный код с картинки', { captchaAnswer: 'Неверный код' });
  }
}

/** Только для тестов: изолирует список израсходованных челленджей между сценариями. */
export function resetCaptchaState(): void {
  consumed.clear();
}
