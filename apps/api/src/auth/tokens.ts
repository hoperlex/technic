import { type CryptoKey, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { assertSigningKey, config } from '../config';
import type { Role } from '@technic/contracts';

const ALG = 'EdDSA';

let cachedPrivate: CryptoKey | undefined;
let cachedPublic: CryptoKey | undefined;

async function getPrivateKey(): Promise<CryptoKey> {
  assertSigningKey(config);
  cachedPrivate ??= (await importPKCS8(config.auth.privateKeyPem, ALG)) as CryptoKey;
  return cachedPrivate;
}

export async function getPublicKey(): Promise<CryptoKey> {
  cachedPublic ??= (await importSPKI(config.auth.publicKeyPem, ALG)) as CryptoKey;
  return cachedPublic;
}

export interface AccessTokenPayload {
  sub: string;
  role: Role | null;
  /** auth_version — версия учётных данных для отзыва старых токенов */
  av: number;
  /**
   * Время выдачи, unix-секунды (план `docs/maintenance-mode-plan.md`, §4.2). По нему страж
   * сверяет токен с эпохой `AUTH_EPOCH_SINCE` — обнулением доступа, которое ставит окно
   * технических работ.
   *
   * Необязательно в типе, потому что стороны у него разные: подпись `iat` не принимает — его
   * ставит `setIssuedAt()` временем выдачи, — а проверка заполняет всегда, кроме единственного
   * случая, ради которого поле и объявлено необязательным: токен, в котором `iat` нет или он не
   * число. Этот случай страж отбивает, а не пропускает (`src/auth/plugin.ts`).
   */
  iat?: number;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ role: payload.role, av: payload.av })
    .setProtectedHeader({ alg: ALG, kid: config.auth.kid })
    .setSubject(payload.sub)
    .setIssuer(config.auth.issuer)
    .setAudience(config.auth.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.auth.accessTtl}s`)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    algorithms: [ALG],
  });
  return {
    sub: payload.sub as string,
    role: (payload.role as Role | null) ?? null,
    av: (payload.av as number) ?? 0,
    // Умолчания у `iat` нет и быть не может: и `0`, и «сейчас» — это готовый ответ на вопрос, на
    // который токен не ответил. Решает страж, а здесь отсутствие остаётся отсутствием.
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
  };
}
