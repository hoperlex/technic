import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../src/lib/error-handler';
import type { AppConfig } from '../src/config';
import maintenanceGate, {
  isGatedPath,
  maintenanceMessage,
  MAINTENANCE_MODE_CODE,
  MAINTENANCE_RETRY_AFTER_FALLBACK_SECONDS,
  retryAfterSeconds,
  type MaintenanceDetails,
  type MaintenanceState,
} from '../src/lib/maintenance';

/**
 * Режим технических работ: переменные окружения (Э1) и серверный гейт (Э2) — план
 * `docs/maintenance-mode-plan.md`.
 *
 * Проверяется здесь то, чего не видно на глаз в окне выката, а видно только когда уже поздно:
 *
 * - **каждая освобождённая ручка отвечает не 503**, и главная из них — `/auth/refresh`. Отбей её
 *   режим, и окно выбросило бы всех на форму входа: `apps/web/src/shared/api/session.ts` читает
 *   всякий неуспех обновления как «сессия кончилась» и объявляет её законченной необратимо. Это
 *   ровно то, чего избегает обнуление токенов эпохой (Р3, Р4), и потерять освобождение — значит
 *   отменить половину выпуска, ничего при этом не сломав на вид;
 * - **`Retry-After` — целое число секунд**, а не ISO-строка. ISO не разбирает ни один клиент, и
 *   ошибка эта немая: заголовок есть, выглядит осмысленно, а вкладка его игнорирует;
 * - **`CR`/`LF` в причине**. Значение едет в `prod.env`: перевод строки разорвал бы файл окружения
 *   и уронил бы конфигурацию всего сервиса — не объявление, а сервис;
 * - **эпоха из будущего валит старт**. Молча пропущенная, она мертвит все токены до самого этого
 *   времени, и причину искали бы в авторизации.
 */

/*
 * Окружение выставляется ДО импортов: `src/config` читает `process.env` в момент загрузки модуля,
 * и присваивание в `beforeAll` опоздало бы на весь граф импортов. Переменные режима здесь
 * намеренно НЕ задаются — приложение собирается с умолчанием, то есть с открытым порталом.
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

/** Доменные пути под гейтом: вход и «кто я» здесь наравне со списком заявок — сквозь режим не проходит никто (Р2). */
const GATED_ROUTES: [method: 'GET' | 'POST', url: string][] = [
  ['GET', '/api/v1/service-requests'],
  ['POST', '/api/v1/auth/login'],
  ['GET', '/api/v1/auth/me'],
];

/**
 * Освобождённые пути — по одному на каждую строку §4.3 плана. Перечень проверяется целиком: у
 * каждой строки своя причина, и пропажа любой из них ломает своё.
 */
const EXEMPT_ROUTES: [method: 'GET' | 'POST', url: string][] = [
  ['POST', '/api/v1/auth/refresh'],
  ['POST', '/api/v1/auth/logout'],
  ['GET', '/health/live'],
  ['GET', '/health/ready'],
  ['GET', '/metrics'],
  ['GET', '/internal/mail/schedules/due'],
  ['GET', '/internal/service-requests/auto-close'],
];

const WINDOW_REASON = 'Миграция схемы 0244 и перенос актов';
/** Срок далеко впереди: остаток до него — предмет проверки `Retry-After`. */
const WINDOW_UNTIL = '2099-09-04T03:00:00.000Z';

/**
 * Приложение с состоянием окна, заданным явно. Состояние берётся аргументом, а не из окружения:
 * оба состояния нужны в одном прогоне, а перезапускать процесс ради переменной окружения нечем.
 */
async function appWithMaintenance(state: MaintenanceState): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  // Плагин регистрируется ДО маршрутов: хук `onRequest` накрывает то, что заведено после него.
  await app.register(maintenanceGate, { maintenance: state });
  for (const [method, url] of [...GATED_ROUTES, ...EXEMPT_ROUTES]) {
    app.route({ method, url, handler: async () => ({ ok: true }) });
  }
  await app.ready();
  return app;
}

let closed: FastifyInstance;
let open: FastifyInstance;

beforeAll(async () => {
  closed = await appWithMaintenance({ enabled: true, reason: WINDOW_REASON, until: WINDOW_UNTIL });
  open = await appWithMaintenance({ enabled: false, reason: '', until: '' });
});

afterAll(async () => {
  await closed?.close();
  await open?.close();
});

describe('область гейта', () => {
  it('браузерное API режиму подлежит, включая вход и «кто я»', () => {
    expect(isGatedPath('/api/v1/service-requests')).toBe(true);
    expect(isGatedPath('/api/v1/service-requests?page=1&kind=repair')).toBe(true);
    expect(isGatedPath('/api/v1/auth/login')).toBe(true);
    expect(isGatedPath('/api/v1/auth/me')).toBe(true);
    expect(isGatedPath('/api/v1/driver/report')).toBe(true);
  });

  it('обновление сессии и выход выведены из-под режима насовсем', () => {
    // Хвостовой слэш и строка запроса не должны открывать обход в другую сторону: путь
    // нормализуется, и `/auth/refresh/` — тот же освобождённый путь.
    expect(isGatedPath('/api/v1/auth/refresh')).toBe(false);
    expect(isGatedPath('/api/v1/auth/refresh/')).toBe(false);
    expect(isGatedPath('/api/v1/auth/logout')).toBe(false);
  });

  it('здоровье, метрики и внутренний контур режиму не подлежат вовсе', () => {
    // `/health/*` и `/metrics` дёргает healthcheck контейнера: прочитав 503, docker принялся бы
    // перезапускать здоровый контейнер посреди окна. `/internal/*` — worker, он гасится своим
    // порядком (Р7).
    expect(isGatedPath('/health/live')).toBe(false);
    expect(isGatedPath('/health/ready')).toBe(false);
    expect(isGatedPath('/metrics')).toBe(false);
    expect(isGatedPath('/internal/mail/schedules/due')).toBe(false);
    expect(isGatedPath('/internal/service-requests/auto-close')).toBe(false);
  });
});

describe('режим включён: портал закрыт', () => {
  it('доменная ручка отвечает 503 с кодом, текстом и разбором', async () => {
    const res = await closed.inject({ method: 'GET', url: '/api/v1/service-requests' });
    expect(res.statusCode).toBe(503);

    const body = res.json<{ code: string; message: string; details: MaintenanceDetails }>();
    expect(body.code).toBe(MAINTENANCE_MODE_CODE);
    // Текст читает человек в обычном окне ошибки старой сборки: обработчика 503
    // `maintenance_mode` у сборок до этого выпуска нет вовсе.
    expect(body.message).toMatch(/технические работы/iu);
    expect(body.message).toContain(WINDOW_REASON);
    // Разбор машиной — порознь и без склейки в предложение: заглушку рисует по нему новая сборка.
    expect(body.details).toEqual({ reason: WINDOW_REASON, until: WINDOW_UNTIL });
  });

  it.each(GATED_ROUTES)('под гейтом весь /api/v1: %s %s', async (method, url) => {
    const res = await closed.inject({ method, url });
    expect(res.statusCode).toBe(503);
  });

  /**
   * Главный тест файла. Без освобождения `/auth/refresh` окно выбрасывало бы из портала каждую
   * вкладку, попавшую на обновление токена, — и вернуть её было бы нечем: сессия объявлена
   * законченной необратимо.
   */
  it.each(EXEMPT_ROUTES)('освобождённая ручка отвечает не 503: %s %s', async (method, url) => {
    const res = await closed.inject({ method, url });
    expect(res.statusCode).not.toBe(503);
    expect(res.statusCode).toBe(200);
  });

  it('пустая причина и неназванный срок отдаются как `null`, а не пустыми строками', async () => {
    const app = await appWithMaintenance({ enabled: true, reason: '', until: '' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/service-requests' });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ message: string; details: MaintenanceDetails }>();
      expect(body.details).toEqual({ reason: null, until: null });
      // Без причины остаётся постоянный текст — самодостаточный сам по себе.
      expect(body.message).toBe(maintenanceMessage(''));
    } finally {
      await app.close();
    }
  });
});

describe('Retry-After — delta-seconds, а не ISO', () => {
  it('заголовок разбирается в целое число', async () => {
    const res = await closed.inject({ method: 'GET', url: '/api/v1/service-requests' });
    const raw = res.headers['retry-after'];
    expect(typeof raw).toBe('string');

    /*
     * Проверяется именно разбор, а не наличие: ISO-строка в заголовке выглядит осмысленно и
     * присутствует, но `Number('2099-09-04T03:00:00.000Z')` — это `NaN`, и вкладка молча
     * игнорирует заголовок. Немая ошибка, которую поймает только такая проверка.
     */
    const seconds = Number(raw);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
    expect(String(raw)).toMatch(/^\d+$/u);
  });

  it('значение — остаток до срока, округлённый вверх', () => {
    const now = new Date('2026-09-04T02:00:00.000Z');
    expect(retryAfterSeconds('2026-09-04T03:00:00.000Z', now)).toBe(3600);
    // Округление вверх: округлённый вниз остаток звал бы вернуться за долю секунды до срока —
    // то есть в момент, когда режим ещё стоит.
    expect(retryAfterSeconds('2026-09-04T02:00:00.400Z', now)).toBe(1);
  });

  it('без срока и с уже прошедшим сроком — две минуты', () => {
    const now = new Date('2026-09-04T02:00:00.000Z');
    expect(retryAfterSeconds('', now)).toBe(MAINTENANCE_RETRY_AFTER_FALLBACK_SECONDS);
    // Срок прошёл, а режим не снят — работы затянулись. Ноль или отрицательное значение вкладка
    // прочитала бы как «повторяйте прямо сейчас».
    expect(retryAfterSeconds('2026-09-04T01:00:00.000Z', now)).toBe(
      MAINTENANCE_RETRY_AFTER_FALLBACK_SECONDS,
    );
    expect(MAINTENANCE_RETRY_AFTER_FALLBACK_SECONDS).toBe(120);
  });

  it('без срока заголовок стоит тот же', async () => {
    const app = await appWithMaintenance({ enabled: true, reason: '', until: '' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/service-requests' });
      expect(res.headers['retry-after']).toBe(String(MAINTENANCE_RETRY_AFTER_FALLBACK_SECONDS));
    } finally {
      await app.close();
    }
  });
});

describe('режим выключен: гейт не вмешивается', () => {
  it.each([...GATED_ROUTES, ...EXEMPT_ROUTES])('%s %s проходит', async (method, url) => {
    const res = await open.inject({ method, url });
    expect(res.statusCode).toBe(200);
  });

  it('заголовка повтора при открытом портале нет', () => {
    // Иначе `Retry-After` висел бы на успешных ответах и сбивал бы с толку и людей, и прокси.
    return open
      .inject({ method: 'GET', url: '/api/v1/service-requests' })
      .then((res) => expect(res.headers['retry-after']).toBeUndefined());
  });
});

/**
 * Э1 — переменные окружения. Конфигурация проверяется при импорте `src/config.ts`, поэтому
 * сценарий — это своё окружение плюс своя загрузка модуля (приём `captcha-config.test.ts`).
 * Неудачный сценарий тут не «возвращает ошибку», а роняет сам импорт — ровно как уронил бы старт.
 */
const MAINTENANCE_ENV_KEYS = [
  'MAINTENANCE_MODE',
  'MAINTENANCE_REASON',
  'MAINTENANCE_UNTIL',
  'AUTH_EPOCH_SINCE',
] as const;

async function loadConfig(overrides: Record<string, string> = {}): Promise<AppConfig> {
  vi.resetModules();
  for (const key of MAINTENANCE_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  const module = await import('../src/config');
  return module.config;
}

describe('переменные режима в конфигурации', () => {
  afterAll(() => {
    // Окружение общее на весь файл: оставленные значения достались бы сборке приложения ниже.
    for (const key of MAINTENANCE_ENV_KEYS) delete process.env[key];
  });

  it('без переменных портал открыт, а эпохи нет', async () => {
    const config = await loadConfig();
    expect(config.maintenance).toEqual({ enabled: false, reason: '', until: '' });
    // Умолчание `0` — «эпохи нет»: `iat` живого токена всегда больше нуля.
    expect(config.auth.epochSince).toBe(0);
  });

  it('`on` закрывает портал, причина и срок доезжают', async () => {
    const config = await loadConfig({
      MAINTENANCE_MODE: 'on',
      MAINTENANCE_REASON: WINDOW_REASON,
      MAINTENANCE_UNTIL: '2026-09-04T03:00:00Z',
    });
    expect(config.maintenance.enabled).toBe(true);
    expect(config.maintenance.reason).toBe(WINDOW_REASON);
    // Срок приводится к канону: разбирать его будут и `Retry-After`, и вкладка.
    expect(config.maintenance.until).toBe('2026-09-04T03:00:00.000Z');
  });

  /**
   * Причина едет в `prod.env`. Перевод строки в ней разорвал бы файл окружения: хвост прочитался
   * бы как отдельная переменная — упала бы конфигурация всего сервиса, а не одно объявление.
   */
  it('CR и LF в причине вычищаются, а не роняют старт', async () => {
    const config = await loadConfig({
      MAINTENANCE_MODE: 'on',
      MAINTENANCE_REASON: 'Миграция схемы\r\nDATABASE_URL=postgres://зло\tи табуляция',
    });
    expect(config.maintenance.reason).not.toMatch(/[\r\n\t]/u);
    // Заменяются пробелом, а не выбрасываются: склейка «схемыDATABASE_URL» читалась бы хуже.
    expect(config.maintenance.reason).toBe(
      'Миграция схемы DATABASE_URL=postgres://зло и табуляция',
    );
  });

  it('длинная причина обрезается до 200 символов', async () => {
    const config = await loadConfig({
      MAINTENANCE_MODE: 'on',
      MAINTENANCE_REASON: 'а'.repeat(500),
    });
    expect(config.maintenance.reason).toHaveLength(200);
  });

  it('неразбираемый срок валит старт', async () => {
    // Молча пропущенный, он не отличался бы от отсутствия срока: портал звал бы вернуться через
    // две минуты весь длинный вечер миграции.
    await expect(loadConfig({ MAINTENANCE_UNTIL: 'завтра к обеду' })).rejects.toThrow(
      /MAINTENANCE_UNTIL/,
    );
  });

  it('пустой срок читается как отсутствие срока, а не как ошибка', async () => {
    // `MAINTENANCE_UNTIL=` — обычный способ снять переменную в `prod.env`; валить старт на снятии
    // окна незачем.
    const config = await loadConfig({ MAINTENANCE_MODE: 'on', MAINTENANCE_UNTIL: '' });
    expect(config.maintenance.until).toBe('');
  });

  it('эпоха из прошлого принимается как есть', async () => {
    const config = await loadConfig({ AUTH_EPOCH_SINCE: '1757000000' });
    expect(config.auth.epochSince).toBe(1_757_000_000);
  });

  /**
   * Эпоха из будущего мертвит КАЖДЫЙ токен, который портал выдаст до этого времени: вкладка уходит
   * в круг «401 → refresh → 401», и причину искали бы в страже и в ключах, а не в строке
   * `prod.env`. Отказ на старте называет её сам.
   */
  it('эпоха из будущего валит старт с внятной причиной', async () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const error = await loadConfig({ AUTH_EPOCH_SINCE: String(future) }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/AUTH_EPOCH_SINCE/);
    expect(error?.message).toMatch(/будущее/);
    // Самая частая ошибка — миллисекунды вместо секунд; текст обязан её называть.
    expect(error?.message).toMatch(/миллисекунды/);
  });

  it('время в миллисекундах отвергается тем же отказом', async () => {
    await expect(loadConfig({ AUTH_EPOCH_SINCE: String(Date.now()) })).rejects.toThrow(
      /AUTH_EPOCH_SINCE/,
    );
  });
});

describe('гейт стоит в самом приложении', () => {
  /*
   * Проверки выше говорят о плагине; эта — о том, что он подключён, и подключён в нужном месте:
   * до стража авторизации. Приложение собирается своей загрузкой модулей, потому что состояние
   * окна конфигурация читает при импорте.
   */
  let app: FastifyInstance;

  beforeAll(async () => {
    Object.assign(process.env, {
      MAINTENANCE_MODE: 'on',
      MAINTENANCE_REASON: WINDOW_REASON,
      MAINTENANCE_UNTIL: WINDOW_UNTIL,
    });
    vi.resetModules();
    const { buildApp } = await import('../src/app');
    app = await buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const key of MAINTENANCE_ENV_KEYS) delete process.env[key];
  });

  it('доменная ручка закрыта раньше авторизации', async () => {
    // Без режима эта же ручка без токена отвечает 401: 503 означает, что гейт стоит выше стража.
    const res = await app.inject({ method: 'GET', url: '/api/v1/service-requests' });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ code: string; details: MaintenanceDetails }>();
    expect(body.code).toBe(MAINTENANCE_MODE_CODE);
    expect(body.details.until).toBe(WINDOW_UNTIL);
    expect(Number.isInteger(Number(res.headers['retry-after']))).toBe(true);
  });

  it('вход и «кто я» закрыты вместе со всем порталом', async () => {
    // Сквозь режим не проходит никто (Р2): пускать по паролю значило бы отменять это решение.
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login' });
    expect(login.statusCode).toBe(503);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(me.statusCode).toBe(503);
  });

  it('обновление сессии и выход работают в окне', async () => {
    // Своей cookie у запроса нет, поэтому обновление отвечает 401 «отсутствует refresh-токен».
    // Важно ровно одно: это не 503, то есть режим ручку не трогал.
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(refresh.statusCode).not.toBe(503);
    expect(refresh.statusCode).toBe(401);

    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(logout.statusCode).toBe(200);
  });

  it('healthcheck контейнера и метрики отвечают, а не «болен»', async () => {
    // Прочитав здесь 503, docker принялся бы перезапускать здоровый контейнер посреди окна.
    // `/health/ready` в этот перечень не входит: там 503 законен и означает недоступную базу.
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
  });

  it('внутренний контур worker не закрыт', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/mail/schedules/due' });
    expect(res.statusCode).not.toBe(503);
  });
});
