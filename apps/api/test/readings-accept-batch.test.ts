import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  REPORT_ACCEPT_BATCH_LIMIT,
  REPORT_ACCEPT_BLOCKED_CODE,
  type DriverReportDto,
  type ReportAcceptBatchDto,
  type Role,
} from '@technic/contracts';
// Только тип модуля: сам он подменяется ниже, а `import()` в аннотации проект запрещает — тем же
// приёмом берут типы сервисов соседние тесты ручек показаний.
import type * as ReadingsNs from '../src/services/readings';

/**
 * Пакетный приём отчётов дня `POST /vehicle-readings/reports/accept-batch` (план «Показания
 * техники», Р8, Р9).
 *
 * Проверяется здесь ручка, а не приём: `acceptReport` подменён, БД подменена заглушкой, падающей
 * на любом запросе. Сам приём — четыре условия под блокировками — живёт в модуле показаний и
 * проверяется на живой схеме (`readings-accept-batch.db.test.ts`); дублировать его подменами
 * значило бы согласовать ручку с выдумкой о сервисе, а не с сервисом.
 *
 * Утверждения ручки ровно три: она зовёт приём по каждой строке в порядке запроса, отказ одного
 * отчёта не мешает соседям, а причина отказа доезжает до ответа целиком и с разбором по коду.
 */

/** Идентификаторы говорящие: по ним видно, какой исход подмена даёт на каждый отчёт. */
const OK_1 = '11111111-1111-4111-8111-111111111111';
const OK_2 = '22222222-2222-4222-8222-222222222222';
const OK_3 = '33333333-3333-4333-8333-333333333333';
const STALE = '44444444-4444-4444-8444-444444444444';
const ALREADY = '55555555-5555-4555-8555-555555555555';
const DISCREPANCY = '66666666-6666-4666-8666-666666666666';
const MISSING = '77777777-7777-4777-8777-777777777777';
const BOOM = '88888888-8888-4888-8888-888888888888';
/** Отказ по условиям, сформулированный иначе, — им проверяется, что разбор идёт не по тексту. */
const BLOCKED_OTHER = '99999999-9999-4999-8999-999999999999';
/** Расхождение версий, притворившееся блокером текстом, — обратная половина той же проверки. */
const STALE_LOOKALIKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'user-1';

/** Тексты — те самые, которыми отвечает `acceptReport` (`services/readings.ts`). */
const VERSION_TEXT = 'Отчёт изменился, обновите страницу и повторите';
const ALREADY_TEXT = 'Отчёт принять нельзя: отчёт уже принят';
const DISCREPANCY_TEXT = 'Отчёт принять нельзя: не разобрано расхождений: 1';
const MISSING_TEXT = 'Отчёт дня не найден';
/** Невыполненное условие приёма приходит своим кодом 409 — по нему ручка и различает два отказа. */
const BLOCKED = { code: REPORT_ACCEPT_BLOCKED_CODE };
/** Блокер без привычной приставки: так выглядела бы правка формулировки отказа. */
const OTHER_BLOCKED_TEXT = 'День закрыт для приёма: не разобрано расхождений: 2';
/** И наоборот — расхождение версий, чей текст начинается ровно приставкой блокеров. */
const LOOKALIKE_TEXT = 'Отчёт принять нельзя — он изменился, обновите страницу и повторите';

const state = vi.hoisted(() => ({
  role: 'admin' as Role | null,
  /** Журнал обращений к приёму: им проверяются и порядок, и то, что до приёма вообще дошли. */
  calls: [] as { id: string; version: number; actorUserId: string }[],
}));

/** Ответ приёма: ручка его не читает вовсе, но подмена обязана отвечать формой сервиса. */
function acceptedDto(id: string, version: number): DriverReportDto {
  return {
    id,
    personId: 'person-1',
    personName: 'Водителев Водитель Водителевич',
    reportDate: '2026-08-14',
    state: 'accepted',
    contentVersion: 1,
    version: version + 1,
    acceptedContentVersion: 1,
    acceptedAt: '2026-08-14T10:00:00.000Z',
    acceptedByName: 'Пользователь Тестовый',
    items: [],
    discrepancies: [],
    canAccept: false,
    blockers: ['отчёт уже принят'],
  };
}

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
              reject(new Error('вызов БД в тесте пакетного приёма'))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: async () => {}, pool: { end: async () => {} } };
});

// Вход подменён: проверяется право на маршруте, а не механика токенов.
vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: USER_ID, role: state.role, av: 1 }),
  signAccessToken: async () => 'test-token',
}));

vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async () => ({
    id: USER_ID,
    email: 'user@test.local',
    lastName: 'Пользователь',
    firstName: 'Тестовый',
    middleName: '',
    fullName: 'Пользователь Тестовый',
    phone: '',
    role: state.role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyId: null,
    counterpartyType: null,
    personId: 'person-1',
    addons: [],
    authVersion: 1,
  }),
}));

/**
 * Подменяется одна функция, остальной модуль остаётся настоящим: показания ведут несколько ручек
 * сразу (кабинет водителя, приёмка, перенос строк), и factory-подмена «только то, что нужно мне»
 * ломала бы соседей молча — недостающий экспорт виден не при сборке приложения, а при вызове
 * чужого обработчика.
 *
 * Ошибки подмена бросает те же, теми же текстами и с тем же кодом, какими отвечает настоящий
 * приём: ручка различает исходы кодом 409, и выдуманный отказ проверял бы разбор по выдумке.
 */
vi.mock('../src/services/readings', async (importOriginal) => {
  const { err } = await import('../src/lib/errors');
  return {
    ...(await importOriginal<typeof ReadingsNs>()),
    acceptReport: async (
      id: string,
      version: number,
      actorUserId: string,
    ): Promise<DriverReportDto> => {
      state.calls.push({ id, version, actorUserId });
      if (id === STALE) throw err.conflict(VERSION_TEXT);
      if (id === ALREADY) throw err.conflict(ALREADY_TEXT, BLOCKED);
      if (id === DISCREPANCY) throw err.conflict(DISCREPANCY_TEXT, BLOCKED);
      if (id === MISSING) throw err.notFound(MISSING_TEXT);
      if (id === BLOCKED_OTHER) throw err.conflict(OTHER_BLOCKED_TEXT, BLOCKED);
      if (id === STALE_LOOKALIKE) throw err.conflict(LOOKALIKE_TEXT);
      // Не `AppError`: так выглядит потерянное соединение или ошибка драйвера — то, о чём
      // пользователю сказать нечего, а в логе сервера должно остаться всё.
      if (id === BOOM) throw new Error('соединение с базой потеряно');
      return acceptedDto(id, version);
    },
  };
});

let app: FastifyInstance;

/** Каждый запрос — со своего адреса: защита от подбора считает по IP, а тест проверяет не её. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.1.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function post(reports: { id: string; version: number }[], role: Role | null = 'admin') {
  state.role = role;
  return app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-readings/reports/accept-batch',
    remoteAddress: nextAddress(),
    headers: { authorization: 'Bearer test-token' },
    payload: { reports },
  });
}

/** Пара «отчёт + версия»: версии разные, чтобы было видно, что до приёма доезжает своя у каждого. */
function at(id: string, version: number): { id: string; version: number } {
  return { id, version };
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
   * Свой таймаут хука: приложение поднимается целиком, а подмена сервиса тянет через
   * `importOriginal` настоящий модуль показаний со всей его роднёй. Трансформация этого дерева
   * занимает секунды и вместе со сборкой упирается в умолчание vitest (10 с) — тест начинал бы
   * мигать красным на загруженной машине, ничего не проверив (см. `vehicle-maintenance.test.ts`).
   */
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('пакетный приём отчётов дня', () => {
  it('принимает список целиком и зовёт приём в порядке запроса', async () => {
    state.calls.length = 0;
    const res = await post([at(OK_1, 3), at(OK_2, 0), at(OK_3, 12)]);

    expect(res.statusCode).toBe(200);
    const body = res.json<ReportAcceptBatchDto>();
    expect(body).toEqual({ accepted: [OK_1, OK_2, OK_3], failed: [] });

    // Порядок обработки — порядок запроса (Р9): ответ читают рядом с реестром, и переставленные
    // строки пришлось бы сопоставлять глазами. Версия у каждого отчёта своя и доезжает как есть.
    expect(state.calls).toEqual([
      { id: OK_1, version: 3, actorUserId: USER_ID },
      { id: OK_2, version: 0, actorUserId: USER_ID },
      { id: OK_3, version: 12, actorUserId: USER_ID },
    ]);
  });

  it('отказ одного отчёта не мешает соседям: остальные приняты', async () => {
    state.calls.length = 0;
    const res = await post([at(OK_1, 1), at(STALE, 4), at(OK_2, 1), at(ALREADY, 7), at(OK_3, 1)]);

    expect(res.statusCode).toBe(200);
    const body = res.json<ReportAcceptBatchDto>();
    // Приём девяти не должен падать целиком из-за одного, который успели поправить в соседней
    // вкладке (Р9): у каждого отчёта своя транзакция, и отказ попадает в свою строку ответа.
    expect(body.accepted).toEqual([OK_1, OK_2, OK_3]);
    expect(body.failed.map((row) => row.id)).toEqual([STALE, ALREADY]);
    // До приёма дошли все пятеро: строка после отказавшей не пропускается.
    expect(state.calls.map((call) => call.id)).toEqual([OK_1, STALE, OK_2, ALREADY, OK_3]);
  });

  it('причины различимы и приходят текстом приёма, а не пересказом', async () => {
    const res = await post([at(STALE, 1), at(ALREADY, 1), at(DISCREPANCY, 1), at(MISSING, 1)]);

    expect(res.statusCode).toBe(200);
    const body = res.json<ReportAcceptBatchDto>();
    expect(body.accepted).toEqual([]);
    // Разошедшаяся версия, уже принятый отчёт, появившееся расхождение и исчезнувший отчёт — четыре
    // разных исхода. Код различает «перечитать реестр» и «идти разбирать день», текст называет, что
    // именно случилось: пересказ своими словами был бы вторым набором правил приёма.
    expect(body.failed).toEqual([
      { id: STALE, code: 'version', reason: VERSION_TEXT },
      { id: ALREADY, code: 'blocked', reason: ALREADY_TEXT },
      { id: DISCREPANCY, code: 'blocked', reason: DISCREPANCY_TEXT },
      { id: MISSING, code: 'gone', reason: MISSING_TEXT },
    ]);
  });

  /**
   * Разбор идёт по коду 409, а не по началу сообщения (Р9). Раньше «принять нельзя» отличалось от
   * «версия уехала» приставкой фразы — связь, которую рвала любая правка формулировки: блокер,
   * названный другими словами, молча приезжал бы порталу как расхождение версий и лечился бы
   * перечитыванием реестра вместо разбора дня.
   */
  it('исход берётся из кода отказа, а не из текста причины', async () => {
    const res = await post([at(BLOCKED_OTHER, 1), at(STALE_LOOKALIKE, 1)]);

    expect(res.statusCode).toBe(200);
    expect(res.json<ReportAcceptBatchDto>().failed).toEqual([
      // Приставки блокеров в тексте нет — код всё равно `blocked`.
      { id: BLOCKED_OTHER, code: 'blocked', reason: OTHER_BLOCKED_TEXT },
      // И наоборот: текст начинается ею, но кода блокера у отказа нет — это версия.
      { id: STALE_LOOKALIKE, code: 'version', reason: LOOKALIKE_TEXT },
    ]);
  });

  it('непредвиденный сбой — своя строка ответа, а не 500 на весь пакет', async () => {
    const res = await post([at(OK_1, 1), at(BOOM, 1), at(OK_2, 1)]);

    expect(res.statusCode).toBe(200);
    const body = res.json<ReportAcceptBatchDto>();
    // Иначе принятые до сбоя отчёты остались бы принятыми (транзакции у них свои), а ответом на всё
    // был бы 500, из которого не видно ни одного исхода.
    expect(body.accepted).toEqual([OK_1, OK_2]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.id).toBe(BOOM);
    expect(body.failed[0]!.code).toBe('error');
    // Наружу — что приём не состоялся; подробности сбоя уходят в лог сервера, а не пользователю.
    expect(body.failed[0]!.reason).not.toContain('соединение с базой');
  });

  it('пустой список — законный ответ, и приём при нём не зовут вовсе', async () => {
    state.calls.length = 0;
    const res = await post([]);

    expect(res.statusCode).toBe(200);
    expect(res.json<ReportAcceptBatchDto>()).toEqual({ accepted: [], failed: [] });
    expect(state.calls, 'пустой пакет не должен трогать приём').toEqual([]);
  });

  it('один и тот же отчёт дважды — 400 до приёма', async () => {
    state.calls.length = 0;
    const res = await post([at(OK_1, 1), at(OK_2, 1), at(OK_1, 2)]);

    // Ответ, где один отчёт стоит разом в принятых и в непринятых («уже принят»), читался бы как
    // противоречие, поэтому повтор — ошибка запроса, а не отказ строки.
    expect(res.statusCode).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it('список длиннее потолка — 400 до приёма', async () => {
    state.calls.length = 0;
    const reports = Array.from({ length: REPORT_ACCEPT_BATCH_LIMIT + 1 }, (_value, index) =>
      at(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 1),
    );
    const res = await post(reports);

    // Потолок обязан быть: пакет — это N последовательных транзакций, и десять тысяч строк заняли
    // бы соединение с базой на минуты.
    expect(res.statusCode).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it('ровно потолок принимается: граница — не запрет на самый людный день', async () => {
    state.calls.length = 0;
    const reports = Array.from({ length: REPORT_ACCEPT_BATCH_LIMIT }, (_value, index) =>
      at(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 1),
    );
    const res = await post(reports);

    expect(res.statusCode).toBe(200);
    expect(res.json<ReportAcceptBatchDto>().accepted).toHaveLength(REPORT_ACCEPT_BATCH_LIMIT);
    expect(state.calls).toHaveLength(REPORT_ACCEPT_BATCH_LIMIT);
  });

  it('без права vehicleReadings.write — 403 и без обращения к приёму', async () => {
    state.calls.length = 0;
    const res = await post([at(OK_1, 1)], 'observer');

    expect(res.statusCode).toBe(403);
    expect(state.calls, 'отказ по праву обязан случиться до приёма').toEqual([]);
  });
});
