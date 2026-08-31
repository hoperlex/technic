import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../src/lib/error-handler';
import clientContractGate, {
  ASSUMED_CLIENT_CONTRACT,
  CLIENT_BUILD_HEADER,
  CLIENT_CONTRACT_HEADER,
  CLIENT_UPGRADE_REQUIRED,
  isGatedPath,
  readClientContract,
} from '../src/lib/client-contract';

/**
 * Гейт минимальной версии клиента (ADR 0146, решение 7; план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р8).
 *
 * Проверяется он **в обеих конфигурациях**, а не только в итоговой: фаза A — та, в которой гейт
 * выкатывается, и оставить её непроверенной значило бы выкатывать неизвестное. Фаза B — та, ради
 * которой он заводился.
 *
 * Главный тест здесь отрицательный: **`/auth/refresh` проходит без заголовка при любом поле**.
 * Старый `session.ts` читает всякий неуспешный ответ обновления как «сессия кончилась» и объявляет
 * её законченной — гейт на этой ручке выкидывал бы человека из портала посреди работы, и починить
 * это в уже загруженной вкладке нечем. Освобождение постоянное, поэтому и тест постоянный.
 */

/*
 * Окружение выставляется ДО импортов: `src/config` читает `process.env` в момент загрузки модуля,
 * и присваивание в `beforeAll` опоздало бы на весь граф импортов. `MIN_CLIENT_CONTRACT` здесь
 * намеренно НЕ задаётся — приложение собирается с умолчанием, то есть в фазе A.
 */
vi.hoisted(() => {
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
    INTERNAL_API_TOKEN: 'test-internal-token',
    LOG_LEVEL: 'fatal',
  });
});

/** База в этом файле не нужна вовсе: гейт отвечает раньше любого обработчика. */
vi.mock('../src/db/client', () => {
  const fail = () => Promise.reject(new Error('Гейт пропустил запрос до базы'));
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) =>
              reject(new Error('Гейт пропустил запрос до базы'))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: fail, pool: { end: async () => {} } };
});

/** Пути, по одному на каждый разбираемый случай; тела у них нет — важен только статус. */
const STUB_ROUTES: [method: 'GET' | 'POST', url: string][] = [
  ['GET', '/api/v1/service-requests'],
  ['POST', '/api/v1/auth/login'],
  ['POST', '/api/v1/auth/refresh'],
  ['POST', '/api/v1/auth/logout'],
  ['GET', '/health/live'],
  ['GET', '/internal/mail/schedules/due'],
];

/**
 * Приложение с полом, заданным явно. Пол берётся аргументом, а не из окружения: обе фазы нужны в
 * одном прогоне, а перезапускать процесс ради переменной окружения нечем.
 */
async function appWithFloor(minContract: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  // Плагин регистрируется ДО маршрутов: хук `onRequest` накрывает то, что заведено после него.
  await app.register(clientContractGate, { minContract });
  for (const [method, url] of STUB_ROUTES) {
    app.route({ method, url, handler: async () => ({ ok: true }) });
  }
  await app.ready();
  return app;
}

let phaseA: FastifyInstance;
let phaseB: FastifyInstance;

beforeAll(async () => {
  phaseA = await appWithFloor(1);
  phaseB = await appWithFloor(2);
});

afterAll(async () => {
  await phaseA?.close();
  await phaseB?.close();
});

const contract = (value: string) => ({ [CLIENT_CONTRACT_HEADER]: value });

describe('разбор заголовка контракта', () => {
  it('нет заголовка — читается как контракт 1', () => {
    expect(readClientContract(undefined)).toBe(ASSUMED_CLIENT_CONTRACT);
    expect(ASSUMED_CLIENT_CONTRACT).toBe(1);
  });

  it('пустое и нечитаемое значение — тот же контракт 1, а не третье состояние', () => {
    // Правило постоянное: у гейта не должно появиться состояния «не знаю» — иначе на каждый
    // отказ пришлось бы решать заново, отбивать его или пропускать.
    expect(readClientContract('')).toBe(1);
    expect(readClientContract('   ')).toBe(1);
    expect(readClientContract('next')).toBe(1);
    expect(readClientContract('1.5')).toBe(1);
  });

  it('целое читается целым, включая ноль и повтор заголовка', () => {
    expect(readClientContract('2')).toBe(2);
    expect(readClientContract(' 3 ')).toBe(3);
    expect(readClientContract('0')).toBe(0);
    // Заголовок, присланный дважды, fastify отдаёт массивом: берётся первый, а не «не знаю».
    expect(readClientContract(['2', '9'])).toBe(2);
  });
});

describe('область гейта', () => {
  it('браузерное API гейту подлежит', () => {
    expect(isGatedPath('/api/v1/service-requests')).toBe(true);
    expect(isGatedPath('/api/v1/service-requests?page=1&kind=repair')).toBe(true);
    expect(isGatedPath('/api/v1/auth/login')).toBe(true);
    expect(isGatedPath('/api/v1/auth/me')).toBe(true);
  });

  it('обновление сессии и выход выведены из-под гейта насовсем', () => {
    expect(isGatedPath('/api/v1/auth/refresh')).toBe(false);
    expect(isGatedPath('/api/v1/auth/refresh/')).toBe(false);
    expect(isGatedPath('/api/v1/auth/logout')).toBe(false);
  });

  it('здоровье, метрики и внутренний контур гейту не подлежат вовсе', () => {
    // `/health/*` дёргает healthcheck контейнера обычным `fetch` без заголовков: под гейтом в
    // фазе B исправный `api` числился бы больным. `/internal/*` ходит worker — не браузер.
    expect(isGatedPath('/health/live')).toBe(false);
    expect(isGatedPath('/health/ready')).toBe(false);
    expect(isGatedPath('/metrics')).toBe(false);
    expect(isGatedPath('/internal/mail/schedules/due')).toBe(false);
    expect(isGatedPath('/internal/service-requests/auto-close')).toBe(false);
  });
});

describe('фаза A: пол 1 — не блокируется никто', () => {
  it('запрос без заголовка проходит', async () => {
    const res = await phaseA.inject({ method: 'GET', url: '/api/v1/service-requests' });
    expect(res.statusCode).toBe(200);
  });

  it('контракт 1 проходит', async () => {
    const res = await phaseA.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: contract('1'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('контракт выше пола проходит — сервер старше клиента не отбивает', async () => {
    const res = await phaseA.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: contract('2'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('обновление сессии без заголовка проходит', async () => {
    const res = await phaseA.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(res.statusCode).toBe(200);
  });
});

describe('фаза B: пол 2 — клиент ниже пола отбит', () => {
  it('запрос без заголовка получает 426 с кодом и самодостаточным текстом', async () => {
    const res = await phaseB.inject({ method: 'GET', url: '/api/v1/service-requests' });
    expect(res.statusCode).toBe(426);
    const body = res.json<{ code: string; message: string }>();
    expect(body.code).toBe(CLIENT_UPGRADE_REQUIRED);
    // Текст читает человек в обычном окне ошибки старого клиента: обработчика 426 у сборок до
    // этого выпуска нет вовсе, и «версия ниже минимальной» ему ничего не сказало бы.
    expect(body.message).toMatch(/обновите страницу/iu);
  });

  it('контракт 1 отбит так же, как отсутствие заголовка', async () => {
    const res = await phaseB.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: contract('1'),
    });
    expect(res.statusCode).toBe(426);
  });

  it('контракт 2 проходит', async () => {
    const res = await phaseB.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: contract('2'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('сборка гейтом не толкуется: один X-Client-Build от отказа не спасает', async () => {
    const res = await phaseB.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: { [CLIENT_BUILD_HEADER]: 'a731bc2' },
    });
    expect(res.statusCode).toBe(426);
  });

  it('регистр заголовка значения не имеет — портал шлёт его как «X-Client-Contract»', async () => {
    // Константа в коде сервера строчная (fastify нормализует имена), а портал шлёт привычное
    // написание. Разойтись эти два написания не должны — иначе гейт отбивал бы всех подряд.
    const res = await phaseB.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: { 'X-Client-Contract': '2', 'X-Client-Build': 'a731bc2' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('вход гейту подлежит: отказ там читается ровно как отказ', async () => {
    const res = await phaseB.inject({ method: 'POST', url: '/api/v1/auth/login' });
    expect(res.statusCode).toBe(426);
  });
});

describe('освобождённые ручки: гейт не должен разлогинивать', () => {
  /*
   * Главный тест пака. Без него гейт в фазе B выкидывал бы из портала всех, чья вкладка попала на
   * обновление токена: старый `session.ts` читает неуспешный ответ как конец сессии, а 426 он
   * отличить не умеет.
   */
  it.each([
    ['пол 1 (фаза A)', 1],
    ['пол 2 (фаза B)', 2],
    ['пол много выше любого клиента', 99],
  ])('обновление сессии без заголовка проходит при любом поле: %s', async (_name, floor) => {
    const app = await appWithFloor(floor);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('выход проходит в фазе B: гейт не запирает человека внутри сессии', async () => {
    // Портал чистит сессию вкладки только после успешного ответа `/auth/logout`; отказ оставил бы
    // её считающей себя вошедшей, а серверную сессию — неотозванной.
    const res = await phaseB.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(200);
  });

  it('здоровье и внутренний контур проходят в фазе B', async () => {
    const health = await phaseB.inject({ method: 'GET', url: '/health/live' });
    expect(health.statusCode).toBe(200);
    const internal = await phaseB.inject({ method: 'GET', url: '/internal/mail/schedules/due' });
    expect(internal.statusCode).toBe(200);
  });
});

describe('гейт стоит в самом приложении', () => {
  /*
   * Проверки выше говорят о плагине; эта — о том, что он подключён. Пол здесь боевой (умолчание
   * `1`, фаза A), поэтому «ниже пола» изображает контракт `0`: окружение ради теста не правится —
   * переменная, выставленная одним файлом, досталась бы соседним по прогону.
   */
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import('../src/app');
    app = await buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('доменная ручка отбивает контракт ниже пола — раньше авторизации', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/service-requests',
      headers: contract('0'),
    });
    expect(res.statusCode).toBe(426);
    expect(res.json<{ code: string }>().code).toBe(CLIENT_UPGRADE_REQUIRED);
  });

  it('в фазе A та же ручка без заголовка до гейта не доходит', async () => {
    // 401 — это уже страж авторизации: запрос прошёл гейт и был отбит по правам, а не по версии.
    const res = await app.inject({ method: 'GET', url: '/api/v1/service-requests' });
    expect(res.statusCode).toBe(401);
  });

  it('обновление сессии и выход освобождены и в приложении', async () => {
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: contract('0'),
    });
    // Своей cookie у запроса нет, поэтому ответ — 401 «отсутствует refresh-токен». Важно ровно
    // одно: это не 426, то есть гейт ручку не трогал.
    expect(refresh.statusCode).not.toBe(426);
    expect(refresh.statusCode).toBe(401);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: contract('0'),
    });
    expect(logout.statusCode).toBe(200);
  });

  it('healthcheck контейнера не блокируется', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: contract('0') });
    expect(res.statusCode).toBe(200);
  });

  it('внутренний контур worker не блокируется', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/mail/schedules/due',
      headers: contract('0'),
    });
    expect(res.statusCode).not.toBe(426);
  });
});
