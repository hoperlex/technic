import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DRIVER_CLIENT_OUTDATED_CODE,
  DRIVER_DRAFT_FORMAT,
  DRIVER_DRAFT_FORMAT_HEADER,
  moscowDateKeyOf,
  type DriverAssignmentDto,
  type DriverReportDto,
} from '@technic/contracts';
// Только тип модуля: сам он подменяется ниже, а `import()` в аннотации проект запрещает — тем же
// приёмом берут типы сервисов соседние тесты ручек показаний.
import type * as ReadingsNs from '../src/services/readings';
import type * as AssignmentNs from '../src/services/driver-assignment';

/**
 * Запрет на открытие отчёта дня клиентом, не умеющим нынешний формат локального черновика
 * (ADR 0129, решение 8; план `docs/driver-readings-first-plan.md`, Р13).
 *
 * Проверяется здесь ручка, а не открытие: `openReport` подменён, БД подменена заглушкой, падающей
 * на любом запросе. Само открытие — состав дня под блокировками — живёт в модуле показаний и
 * проверяется на живой схеме (`driver-report-flow.db.test.ts`).
 *
 * Утверждений четыре, и последнее не менее важно первых трёх:
 *
 * 1. без заголовка формата открытие отвечает 409 своим кодом и **до сервиса не доходит** — иначе
 *    строки ожидания успевали бы завестись, а с ними и новые ключи старого черновика;
 * 2. чужое значение формата (`v1` старой сборки) неотличимо от его отсутствия;
 * 3. текст отказа самодостаточен: читать его будет сборка, не знающая кода `client_outdated`, — она
 *    покажет сообщение как обычную ошибку, и по нему человек обязан понять, что делать;
 * 4. остальные ручки кабинета запретом не задеты — старый клиент по-прежнему читает своё задание и
 *    свой отчёт и по-прежнему передаёт показания. Запрет ставится там, где рождаются новые ключи
 *    черновика, и нигде больше.
 */

const USER_ID = 'user-driver-1';
const PERSON_ID = 'person-1';
const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';

/** Текст отказа — тот самый, которым отвечает ручка (`routes/driver.ts`). */
const OUTDATED_TEXT = 'Приложение обновилось: закройте вкладку и откройте кабинет заново';

/** День берётся сегодняшним по МСК: окно записи кабинета — прошедшая неделя плюс сегодня. */
const TODAY = moscowDateKeyOf(new Date());

const state = vi.hoisted(() => ({
  /** Журнал обращений к сервисам: им проверяется, что до открытия дошли (или не дошли). */
  calls: [] as string[],
}));

/**
 * Любое обращение к БД — ошибка теста. Заглушка падает не на вызове, а на `await`: запрос drizzle
 * собирается цепочкой, и синхронный бросок из её середины оставлял бы соседний промис без
 * обработчика (см. `access-matrix.test.ts`).
 */
vi.mock('../src/db/client', () => {
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) =>
              reject(new Error('вызов БД в тесте запрета формата черновика'))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: async () => {}, pool: { end: async () => {} } };
});

// Вход подменён: проверяется заголовок формата, а не механика токенов.
vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: USER_ID, role: 'driver', av: 1 }),
  signAccessToken: async () => 'test-token',
}));

/** Принципал водителя: права кабинета у роли есть по матрице, человек — четвёртая ось области. */
vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async () => ({
    id: USER_ID,
    email: 'driver@test.local',
    lastName: 'Водителев',
    firstName: 'Водитель',
    middleName: 'Водителевич',
    fullName: 'Водителев Водитель Водителевич',
    phone: '',
    role: 'driver',
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyId: null,
    counterpartyType: null,
    personId: PERSON_ID,
    addons: [],
    grantCodes: [],
    grantPermissions: [],
    authVersion: 1,
  }),
}));

/** Отчёт дня в том виде, в каком его отдаёт открытие: содержимое ручка не читает вовсе. */
function draftReport(): DriverReportDto {
  return {
    id: REPORT_ID,
    personId: PERSON_ID,
    personName: 'Водителев Водитель Водителевич',
    reportDate: TODAY,
    state: 'draft',
    contentVersion: 0,
    version: 0,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items: [],
    discrepancies: [],
    canAccept: false,
    blockers: [],
  };
}

/**
 * Подменяются три функции, остальной модуль остаётся настоящим: показания ведут несколько ручек
 * сразу (кабинет, приёмка, перенос строк), и factory-подмена «только то, что нужно мне» ломала бы
 * соседей молча — недостающий экспорт виден не при сборке приложения, а при вызове чужого
 * обработчика.
 */
vi.mock('../src/services/readings', async (importOriginal) => ({
  ...(await importOriginal<typeof ReadingsNs>()),
  openReport: async (): Promise<DriverReportDto> => {
    state.calls.push('open');
    return draftReport();
  },
  loadReport: async (): Promise<DriverReportDto | null> => {
    state.calls.push('load');
    return draftReport();
  },
  submitReport: async (): Promise<DriverReportDto> => {
    state.calls.push('submit');
    return draftReport();
  },
}));

vi.mock('../src/services/driver-assignment', async (importOriginal) => ({
  ...(await importOriginal<typeof AssignmentNs>()),
  buildAssignment: async (): Promise<DriverAssignmentDto> => {
    state.calls.push('assignment');
    return { date: TODAY, canSubmit: true, entries: [] };
  },
}));

let app: FastifyInstance;

/** Каждый запрос — со своего адреса: защита от подбора считает по IP, а тест проверяет не её. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.2.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function headersWith(format?: string, name = DRIVER_DRAFT_FORMAT_HEADER) {
  const auth = { authorization: 'Bearer test-token' };
  return format === undefined ? auth : { ...auth, [name]: format };
}

async function open(format?: string, name?: string) {
  state.calls.length = 0;
  return app.inject({
    method: 'POST',
    url: `/api/v1/driver/reports/${TODAY}/open`,
    remoteAddress: nextAddress(),
    headers: headersWith(format, name),
  });
}

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
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
  /*
   * Свой таймаут хука: приложение поднимается целиком, а подмены тянут через `importOriginal`
   * настоящие модули показаний и задания со всей их роднёй. Трансформация этого дерева занимает
   * секунды и вместе со сборкой упирается в умолчание vitest (10 с) — тест начинал бы мигать
   * красным на загруженной машине, ничего не проверив (см. `readings-accept-batch.test.ts`).
   */
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('открытие отчёта дня требует объявленного формата черновика', () => {
  it('без заголовка отвечает 409 `client_outdated` и до открытия не доходит', async () => {
    const res = await open();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: DRIVER_CLIENT_OUTDATED_CODE,
      message: OUTDATED_TEXT,
    });
    expect(state.calls).toEqual([]);
  });

  it('старый формат `v1` неотличим от отсутствия заголовка', async () => {
    const res = await open('v1');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(DRIVER_CLIENT_OUTDATED_CODE);
    expect(state.calls).toEqual([]);
  });

  it('незнакомое значение тоже не пускает — сравнение точное', async () => {
    for (const value of ['', 'V2', 'v2 ', 'v3', 'v2,v1']) {
      const res = await open(value);
      expect(res.statusCode, `формат «${value}»`).toBe(409);
      expect(res.json().code).toBe(DRIVER_CLIENT_OUTDATED_CODE);
      expect(state.calls).toEqual([]);
    }
  });

  it('текст отказа самодостаточен: старая сборка покажет его как есть', async () => {
    const { message } = (await open()).json() as { message: string };
    // Названо действие целиком — и вкладка, и повторное открытие кабинета.
    expect(message).toContain('вкладку');
    expect(message).toContain('кабинет заново');
    // Ни на какую кнопку текст не ссылается: у старой сборки её нет и появиться неоткуда.
    expect(message).not.toMatch(/кнопк|нажм/i);
    // Код отказа в тексте не пересказывается: его показывать человеку нечем.
    expect(message).not.toContain(DRIVER_CLIENT_OUTDATED_CODE);
  });

  it('с объявленным форматом открытие проходит', async () => {
    const res = await open(DRIVER_DRAFT_FORMAT);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(REPORT_ID);
    expect(state.calls).toEqual(['open']);
  });

  it('регистр имени заголовка значения не имеет', async () => {
    const res = await open(DRIVER_DRAFT_FORMAT, 'X-Driver-Draft-Format');
    expect(res.statusCode).toBe(200);
    expect(state.calls).toEqual(['open']);
  });
});

describe('остальные ручки кабинета запретом не задеты', () => {
  it('задание дня читается без заголовка', async () => {
    state.calls.length = 0;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/driver/assignment?date=${TODAY}`,
      remoteAddress: nextAddress(),
      headers: headersWith(),
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toEqual(['assignment']);
  });

  it('свой отчёт читается без заголовка', async () => {
    state.calls.length = 0;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/driver/reports/${TODAY}`,
      remoteAddress: nextAddress(),
      headers: headersWith(),
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toEqual(['load']);
  });

  /**
   * Отправка без заголовка проходит намеренно: у формы, открытой до выката, строки уже заведены, и
   * запрет на отправку означал бы потерю введённого — ровно то, ради чего затевался Р13.
   */
  it('передача показаний без заголовка проходит', async () => {
    state.calls.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/reports/${TODAY}/submit`,
      remoteAddress: nextAddress(),
      headers: headersWith(),
      payload: {
        version: 0,
        items: [{ itemId: ITEM_ID, reading: { kind: 'values', odometerKm: 128_400 } }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toEqual(['submit']);
  });
});
