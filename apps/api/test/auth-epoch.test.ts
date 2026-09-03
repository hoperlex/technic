import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { importPKCS8, SignJWT } from 'jose';
import type { Principal } from '../src/auth/principal';

/**
 * Эпоха токенов: обнуление доступа по `iat` (план `docs/maintenance-mode-plan.md`, Р3 и §4.2).
 *
 * Заводилась она ради окна технических работ — в окне меняются данные, а бывает, что и права, и
 * всё это время (до 15 минут, `ACCESS_TOKEN_TTL_SECONDS`) старая вкладка ходит с прежним
 * access-токеном. Но действует она **всегда**, а не только в окне, и проверяется здесь так же.
 *
 * Главный тест файла — **`iat === AUTH_EPOCH_SINCE` отбивается**. Наивное `iat < epoch` выглядит
 * правильным и работает почти во всех случаях: расходятся они ровно в ту секунду, в которую
 * оператор закрывает портал, — то есть в единственную секунду, ради которой обнуление и делается.
 * Найдена граница ревью плана, и без теста она вернулась бы первой же правкой «упростить условие».
 */

/*
 * Ключи настоящие, а токены подписываются здесь же: предмет проверки — граница по `iat`, и
 * задавать `iat` произвольным `signAccessToken` не умеет (он ставит время выдачи сам). Окружение
 * готовится ДО первой загрузки `src/config` — она читает `process.env` при импорте, поэтому все
 * модули портала в этом файле грузятся динамически.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));

Object.assign(process.env, {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://portal.test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
  JWT_PRIVATE_KEY_PEM: PRIVATE_KEY_PEM,
  JWT_PUBLIC_KEY_PEM: String(publicKey.export({ type: 'spki', format: 'pem' })),
  COOKIE_SECRET: 'test-cookie-secret-value',
  CSRF_SECRET: 'test-csrf-secret-value',
  S3_ENDPOINT: 'https://s3.test.local',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  LOG_LEVEL: 'fatal',
});

const USER_ID = 'user-1';
const AUTH_VERSION = 7;

/** Учётка живая и права ни при чём: проверяется только возраст токена. */
vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async (id: string) =>
    ({ id, authVersion: AUTH_VERSION, isActive: true, role: 'admin' }) as unknown as Principal,
}));

/** База в этом файле не нужна: страж отвечает раньше любого обработчика. */
vi.mock('../src/db/client', () => {
  const fail = () => Promise.reject(new Error('Страж пропустил запрос до базы'));
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) =>
              reject(new Error('Страж пропустил запрос до базы'))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: fail, pool: { end: async () => {} } };
});

interface Harness {
  app: FastifyInstance;
  /** Токен с заданным временем выдачи; `null` — токен вовсе без `iat`. */
  token: (iat: number | null) => Promise<string>;
  /** Роундтрип боевой пары «подпись — проверка»: им проверяется, что `iat` доезжает наружу. */
  issue: () => Promise<{ token: string; verified: { iat?: number; av: number } }>;
}

/**
 * Приложение со стражем и заданной эпохой. Эпоха читается конфигурацией при импорте, поэтому
 * каждый сценарий — своя загрузка модулей: два значения нужны в одном прогоне, а перезапускать
 * процесс ради переменной окружения нечем.
 */
async function harness(epochSince: number): Promise<Harness> {
  process.env.AUTH_EPOCH_SINCE = String(epochSince);
  vi.resetModules();
  const { config } = await import('../src/config');
  const { errorHandler } = await import('../src/lib/error-handler');
  const { signAccessToken, verifyAccessToken } = await import('../src/auth/tokens');
  const authPlugin = (await import('../src/auth/plugin')).default;

  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(authPlugin);
  app.get('/api/v1/probe', { preHandler: app.authenticate }, async (req) => ({
    id: req.principal?.id,
  }));
  await app.ready();

  const key = await importPKCS8(PRIVATE_KEY_PEM, 'EdDSA');
  const token = async (iat: number | null): Promise<string> => {
    const jwt = new SignJWT({ role: 'admin', av: AUTH_VERSION })
      .setProtectedHeader({ alg: 'EdDSA', kid: config.auth.kid })
      .setSubject(USER_ID)
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setExpirationTime('15m');
    // `null` — не «ноль», а отсутствие утверждения: именно такой токен и проверяется отдельно.
    if (iat !== null) jwt.setIssuedAt(iat);
    return jwt.sign(key);
  };

  return {
    app,
    token,
    issue: async () => {
      const signed = await signAccessToken({ sub: USER_ID, role: 'admin', av: AUTH_VERSION });
      return { token: signed, verified: await verifyAccessToken(signed) };
    },
  };
}

let current: Harness | undefined;

async function withEpoch(epochSince: number): Promise<Harness> {
  current = await harness(epochSince);
  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = undefined;
  delete process.env.AUTH_EPOCH_SINCE;
});

const probe = (app: FastifyInstance, token: string) =>
  app.inject({
    method: 'GET',
    url: '/api/v1/probe',
    headers: { authorization: `Bearer ${token}` },
  });

describe('verifyAccessToken отдаёт время выдачи', () => {
  it('`iat` доезжает наружу и совпадает с временем подписи', async () => {
    // До этого выпуска проверка `iat` выбрасывала, и сверять эпоху было не с чем.
    const { issue } = await withEpoch(0);
    const before = Math.floor(Date.now() / 1000);
    const { verified } = await issue();
    const after = Math.floor(Date.now() / 1000);

    expect(typeof verified.iat).toBe('number');
    expect(verified.iat).toBeGreaterThanOrEqual(before);
    expect(verified.iat).toBeLessThanOrEqual(after);
    // Остальная нагрузка не потерялась по дороге.
    expect(verified.av).toBe(AUTH_VERSION);
  });
});

describe('граница эпохи', () => {
  const EPOCH = 1_757_000_000;

  it('токен старее эпохи отбит 401', async () => {
    const { app, token } = await withEpoch(EPOCH);
    const res = await probe(app, await token(EPOCH - 1));
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('unauthorized');
  });

  /**
   * Та самая граница. `iat` измеряется целыми секундами: при строгом `<` токен, выданный в ту же
   * секунду, в которую поднята эпоха, остался бы живым — а это ровно секунда, в которую оператор
   * закрывает портал.
   */
  it('токен, выданный В секунду эпохи, отбит тоже', async () => {
    const { app, token } = await withEpoch(EPOCH);
    const res = await probe(app, await token(EPOCH));
    expect(res.statusCode).toBe(401);
  });

  it('токен моложе эпохи проходит', async () => {
    const { app, token } = await withEpoch(EPOCH);
    const res = await probe(app, await token(EPOCH + 1));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe(USER_ID);
  });

  /**
   * Токен, который нельзя датировать, отбивается вместе со старыми: пропустить его значило бы
   * оставить в живых ровно те токены, ради которых эпоху и поднимали.
   */
  it('токен без `iat` отбит при поднятой эпохе', async () => {
    const { app, token } = await withEpoch(EPOCH);
    const res = await probe(app, await token(null));
    expect(res.statusCode).toBe(401);
  });

  it('нечисловой `iat` неотличим от его отсутствия', async () => {
    const { app } = await withEpoch(EPOCH);
    const key = await importPKCS8(PRIVATE_KEY_PEM, 'EdDSA');
    const { config } = await import('../src/config');
    // `iat` строкой jose при проверке не отвергает — отвергнуть обязан страж.
    const token = await new SignJWT({ role: 'admin', av: AUTH_VERSION, iat: 'позавчера' })
      .setProtectedHeader({ alg: 'EdDSA', kid: config.auth.kid })
      .setSubject(USER_ID)
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setExpirationTime('15m')
      .sign(key);

    const res = await probe(app, token);
    expect(res.statusCode).toBe(401);
  });

  it('свежий боевой токен проходит при эпохе, поднятой минуту назад', async () => {
    // Сценарий снятия окна: эпоха уже стоит, а токен выдан после неё.
    const { app, issue } = await withEpoch(Math.floor(Date.now() / 1000) - 60);
    const { token } = await issue();
    const res = await probe(app, token);
    expect(res.statusCode).toBe(200);
  });
});

describe('умолчание: эпохи нет — страж прежний', () => {
  it('боевой токен проходит', async () => {
    const { app, issue } = await withEpoch(0);
    const { token } = await issue();
    expect((await probe(app, token)).statusCode).toBe(200);
  });

  it('токен с `iat = 0` проходит: `0` — это «эпохи нет», а не «эпоха в нуле»', async () => {
    // Сравнение `iat <= 0`, выполненное при умолчании, отбивало бы такой токен — и умолчание
    // перестало бы быть безобидным. Поэтому сверка спрашивается только при поднятой эпохе.
    const { app, token } = await withEpoch(0);
    expect((await probe(app, await token(0))).statusCode).toBe(200);
  });

  it('токен без `iat` при умолчании проходит', async () => {
    /*
     * Сверка целиком спрашивается только при поднятой эпохе: пока обнуления никто не объявлял,
     * сравнивать не с чем, и заводить новый повод для 401 нельзя — умолчание обязано оставить
     * стража прежним до последней ветки. Проверяется это отдельно ещё и потому, что на такой
     * токен опираются двойники соседних тестов: подменённый `verifyAccessToken` отдаёт нагрузку
     * без `iat`, и безусловный отказ обрушил бы их все, ничего не сказав про эпоху.
     */
    const { app, token } = await withEpoch(0);
    expect((await probe(app, await token(null))).statusCode).toBe(200);
  });
});
