import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ReadingMonthRow, Role, VehicleReadingStatsRow } from '@technic/contracts';
import { readWorkbook } from '../src/lib/xlsx';
// Только типы модулей: сами они подменяются ниже, а `import()` в аннотации проект запрещает.
import type * as AggregateNs from '../src/services/readings-aggregate';
import type * as ExportNs from '../src/services/readings-export';
import type * as MaintenanceNs from '../src/services/vehicle-maintenance';

/**
 * Выгрузки показаний: `GET /vehicle-readings/export?kind=…` (план «Показания техники», Р18, §8).
 *
 * Проверяется состав книг и границы ручки, а не расчёт: пробег и месяцы считает агрегат, и живут
 * они на живой схеме (`readings-aggregate.db.test.ts`). Поэтому расчёт здесь подменён, а строки
 * журнала приходят из подменённой БД — так книга собирается из известных чисел, и утверждать можно
 * про неё саму: какие листы, какие заголовки, где прочерк и чего в ней нет.
 *
 * Книга разбирается тем же `readWorkbook`, которым портал читает чужие книги
 * (`lib/xlsx`, `xlsx.test.ts`): проверять байты zip бессмысленно, а состав листов — ровно то, что
 * увидит человек, открывший файл.
 */

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
/** Машина, которой нет в справочнике: выгрузка её журнала обязана дать 404, а не пустую книгу. */
const MISSING_ID = '33333333-3333-4333-8333-333333333333';
const PERSON_ID = '44444444-4444-4444-8444-444444444444';

/** Строка выборки журнала — той формы, какой её отдаёт драйвер: `numeric` строками, `null` как есть. */
type JournalRow = Record<string, unknown>;

const state = vi.hoisted(() => ({
  role: 'admin' as Role | null,
  /** Ответы подменённого расчёта. */
  stats: [] as unknown[],
  months: new Map<string, unknown[]>(),
  odometers: new Map<string, unknown>(),
  maintenance: new Map<string, unknown>(),
  /** Ответы подменённой БД: строки журнала, их счётчик, последние моточасы и подпись машины. */
  journalRows: [] as Record<string, unknown>[],
  journalTotal: 0,
  engineHours: [] as Record<string, unknown>[],
  vehicleRows: [] as Record<string, unknown>[],
  /** Кого звали: отказ обязан случаться до расчёта, а данные ТО — только под своим правом. */
  calls: [] as string[],
}));

/**
 * БД подменена не заглушкой-падением, как у соседних тестов ручек, а отдающей строки: журнальные
 * варианты выгрузки читают базу сами (постраничный журнал экрана книге не годится), и без строк
 * проверять в их книгах было бы нечего.
 *
 * Ответ выбирается по **составу проекции** запроса, а не по порядку вызовов: порядок зависит от
 * того, что в сборщике идёт через `Promise.all`, и тест на нём разъезжался бы при первой же
 * перестановке строк.
 */
vi.mock('../src/db/client', () => {
  const resultFor = (projection: Record<string, unknown>): unknown[] => {
    const keys = new Set(Object.keys(projection ?? {}));
    if (keys.has('total')) return [{ total: state.journalTotal }];
    if (keys.has('reportDate') && keys.has('shiftOrder')) return state.journalRows;
    if (keys.has('measuredOn')) return state.engineHours;
    if (keys.has('ownership')) return state.vehicleRows;
    throw new Error(`неожиданный запрос в тесте выгрузок: ${[...keys].join(', ')}`);
  };
  const chainOf = (rows: unknown[]): unknown => {
    const chain: unknown = new Proxy(
      {},
      {
        get: (_target, prop): unknown =>
          prop === 'then' ? (resolve: (v: unknown) => void) => resolve(rows) : () => chain,
      },
    );
    return chain;
  };
  /** Всё, кроме двух видов выборки, — ошибка теста: сюда сборщик выгрузок ходить не должен. */
  const rejecting: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) =>
              reject(new Error('неожиданный запрос БД в тесте выгрузок'))
          : () => rejecting,
    },
  );
  const known: Record<string, unknown> = {
    select: (projection: Record<string, unknown>) => chainOf(resultFor(projection)),
    selectDistinctOn: (_columns: unknown, projection: Record<string, unknown>) =>
      chainOf(resultFor(projection)),
  };
  const db = new Proxy(known, {
    get: (target, prop): unknown => target[String(prop)] ?? (() => rejecting),
  });
  return { db, pingDb: async () => {}, pool: { end: async () => {} } };
});

// Вход подменён: проверяется право на маршруте, а не механика токенов.
vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: 'user-1', role: state.role, av: 1 }),
  signAccessToken: async () => 'test-token',
}));

vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async () => ({
    id: 'user-1',
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
    personId: PERSON_ID,
    addons: [],
    authVersion: 1,
  }),
}));

/**
 * Подменяются три функции расчёта, остальной модуль остаётся настоящим: агрегат общий на несколько
 * ручек, и factory-подмена «только то, что нужно мне» ломала бы соседей молча.
 */
vi.mock('../src/services/readings-aggregate', async (importOriginal) => ({
  ...(await importOriginal<typeof AggregateNs>()),
  loadFleetStats: async (from: string, to: string) => {
    state.calls.push(`stats:${from}:${to}`);
    return state.stats as VehicleReadingStatsRow[];
  },
  loadFleetMonths: async (from: string, to: string) => {
    state.calls.push(`months:${from}:${to}`);
    return state.months as Map<string, ReadingMonthRow[]>;
  },
  loadLastOdometers: async () => {
    state.calls.push('odometers');
    return state.odometers as Map<string, { km: number; measuredOn: string }>;
  },
}));

vi.mock('../src/services/vehicle-maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof MaintenanceNs>()),
  loadMaintenanceSnapshot: async () => {
    state.calls.push('maintenance');
    return state.maintenance as Awaited<ReturnType<typeof MaintenanceNs.loadMaintenanceSnapshot>>;
  },
}));

let app: FastifyInstance;
let buildReadingsExport: typeof ExportNs.buildReadingsExport;
let rowLimit: number;

/** Каждый запрос — со своего адреса: защита от подбора считает по IP, а тест проверяет не её. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.1.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function get(url: string, role: Role | null = 'admin') {
  state.role = role;
  return app.inject({
    method: 'GET',
    url,
    remoteAddress: nextAddress(),
    headers: { authorization: 'Bearer test-token' },
  });
}

const exportUrl = (query: string): string => `/api/v1/vehicle-readings/export?${query}`;

/** Книга из ответа — листами и строками, как её увидит открывший файл. */
function bookOf(payload: Buffer) {
  return readWorkbook(new Uint8Array(payload));
}

async function download(query: string, role: Role | null = 'admin') {
  const res = await get(exportUrl(query), role);
  expect(res.statusCode, res.payload.slice(0, 200)).toBe(200);
  return bookOf(res.rawPayload);
}

// ── Данные подмен ──

function statsRow(over: Partial<VehicleReadingStatsRow> = {}): VehicleReadingStatsRow {
  return {
    vehicleId: VEHICLE_ID,
    vehicleLabel: 'А123БВ777',
    distanceKm: 1200,
    engineHours: 310.5,
    fuelFilledLiters: 4200,
    gaps: 2,
    ...over,
  };
}

function monthRow(month: string, over: Partial<ReadingMonthRow> = {}): ReadingMonthRow {
  return {
    month,
    distanceKm: 500,
    engineHours: 120.5,
    fuelFilledLiters: 900,
    odometerGaps: 0,
    engineHoursGaps: 0,
    missingReadings: 0,
    shifts: 20,
    unacceptedShifts: 0,
    ...over,
  };
}

function journalRow(over: JournalRow = {}): JournalRow {
  return {
    ownership: 'own',
    description: '',
    registrationNumber: 'А123БВ777',
    categoryName: null,
    typeName: 'Экскаватор',
    modelName: 'JCB 3CX',
    reportDate: '2026-01-05',
    shiftOrder: 1,
    reportState: 'accepted',
    sourceKind: 'route',
    routeNum: 142,
    waybillNumber: null,
    waybillPrefix: null,
    waybillNumberWidth: null,
    personName: 'Иванов Иван Иванович',
    readingId: 'reading-1',
    kind: 'values',
    odometerKm: 128_400,
    engineHours: '9310.5',
    fuelFilledLiters: '120',
    noDataReason: '',
    comment: '',
    source: 'driver',
    odometerAnomaly: null,
    odometerAnomalyConfirmedAt: null,
    engineHoursAnomaly: null,
    engineHoursAnomalyConfirmedAt: null,
    previousOdometerKm: 128_150,
    previousEngineHours: '9303.0',
    ...over,
  };
}

const VEHICLE_ROW = {
  ownership: 'own',
  description: '',
  registrationNumber: 'А123БВ777',
  categoryName: null,
  typeName: 'Экскаватор',
  modelName: 'JCB 3CX',
};

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

  const exports = await import('../src/services/readings-export');
  buildReadingsExport = exports.buildReadingsExport;
  rowLimit = exports.READING_EXPORT_ROW_LIMIT;
  /*
   * Свой таймаут хука: приложение поднимается целиком, а подмены через `importOriginal` тянут
   * настоящие модули расчёта со всей их роднёй — трансформация этого дерева упирается в умолчание
   * vitest (10 с) на загруженной машине.
   */
}, 30_000);

afterAll(async () => {
  await app?.close();
});

/** Данные подмен — заново перед каждой проверкой: тесты правят их под свой случай. */
beforeEach(() => {
  state.stats = [statsRow(), statsRow({ vehicleId: OTHER_ID, vehicleLabel: 'В777АА99' })];
  state.months = new Map<string, unknown[]>([
    [VEHICLE_ID, [monthRow('2026-01'), monthRow('2026-03', { distanceKm: null })]],
    [OTHER_ID, [monthRow('2026-02', { distanceKm: 40 })]],
  ]);
  state.odometers = new Map<string, unknown>([
    [VEHICLE_ID, { km: 128_400, measuredOn: '2026-03-30' }],
  ]);
  state.engineHours = [{ vehicleId: VEHICLE_ID, value: '9310.5', measuredOn: '2026-03-29' }];
  state.maintenance = new Map<string, unknown>();
  state.journalRows = [journalRow()];
  state.journalTotal = 1;
  state.vehicleRows = [VEHICLE_ROW];
  state.calls = [];
});

describe('выгрузки показаний: один сборщик, вариант параметром', () => {
  it('сводка по парку — тот же лист, что выгружает старая ручка', async () => {
    const book = await download('kind=fleetSummary&from=2026-01-01&to=2026-03-31');

    expect(book).toHaveLength(1);
    // Имя листа Excel режет на 31 знаке, и период в нём не помещается целиком — как и до этой
    // работы: лист рисует тот же `readingStatsSheet`.
    expect(book[0]!.name).toContain('Показания 2026-01-01');
    expect(book[0]!.rows[0]).toEqual([
      'Техника',
      'Пробег, км',
      'Наработка, м/ч',
      'Заправлено топлива, л',
      'Разрывов ряда',
    ]);
    expect(book[0]!.rows[1]).toEqual(['А123БВ777', '1200', '310,5', '4200,0', '2']);
  });

  /**
   * Старая ручка сохранена и переведена на общий сборщик: двух реализаций одной книги быть не
   * должно, а адрес уже стоит в портале и в чужих закладках. Проверяется именно совпадение состава,
   * а не «обе отвечают 200».
   */
  it('старая ручка /stats/export отдаёт ровно ту же книгу', async () => {
    const legacy = await get('/api/v1/vehicle-readings/stats/export?from=2026-01-01&to=2026-03-31');
    expect(legacy.statusCode).toBe(200);

    const fresh = await get(exportUrl('kind=fleetSummary&from=2026-01-01&to=2026-03-31'));
    expect(bookOf(legacy.rawPayload)).toEqual(bookOf(fresh.rawPayload));
    expect(legacy.headers['content-disposition']).toBe(fresh.headers['content-disposition']);
  });

  it('помесячно по парку — лист на счётчик, колонка на месяц периода', async () => {
    const book = await download('kind=fleetMonths&from=2026-01-01&to=2026-03-31');

    // Наработка на листе названа моточасами словом: косой черты Excel в имени листа не принимает.
    expect(book.map((sheet) => sheet.name)).toEqual([
      'Пробег, км',
      'Наработка, моточасы',
      'Заправлено топлива, л',
    ]);
    // Месяцы стоят все, включая тот, в котором машина не работала: пропущенная колонка читалась бы
    // как потерянный месяц.
    expect(book[0]!.rows[0]).toEqual([
      'Техника',
      '01.2026',
      '02.2026',
      '03.2026',
      'Итого за период',
      'Разрывов ряда',
    ]);
    // Прочерк, а не ноль: месяца в ответе расчёта нет вовсе, а март пришёл с неизвестным пробегом.
    expect(book[0]!.rows[1]).toEqual(['А123БВ777', '500', '—', '—', '1200', '2']);
    expect(book[0]!.rows[2]).toEqual(['В777АА99', '—', '40', '—', '1200', '2']);
    // Разрывы объясняют прочерк там, где число — разность снимков; заправленное их не знает.
    expect(book[2]!.rows[0]!.at(-1)).toBe('Итого за период');
  });

  it('журнал машины — построчно, с приростами и прочерками', async () => {
    state.journalRows = [
      journalRow(),
      journalRow({
        reportDate: '2026-01-06',
        shiftOrder: 2,
        readingId: null,
        kind: null,
        source: null,
        odometerKm: null,
        engineHours: null,
        fuelFilledLiters: null,
        previousOdometerKm: null,
        previousEngineHours: null,
        reportState: 'submitted',
      }),
    ];
    state.journalTotal = 2;

    const book = await download(
      `kind=vehicleJournal&from=2026-01-01&to=2026-01-31&vehicleId=${VEHICLE_ID}`,
    );

    expect(book).toHaveLength(1);
    expect(book[0]!.rows[0]).toEqual([
      'День',
      'Смена',
      'Источник',
      'Кто передал',
      'Состояние отчёта',
      'Одометр, км',
      'Прирост, км',
      'Моточасы, м/ч',
      'Прирост, м/ч',
      'Заправлено, л',
      'Аномалии',
      'Показание',
    ]);
    expect(book[0]!.rows[1]).toEqual([
      '05.01.2026',
      '1',
      'Р-142',
      'Иванов Иван Иванович',
      'принят',
      '128400',
      '250',
      '9310,5',
      '7,5',
      '120,0',
      '',
      'передано водителем',
    ]);
    // Смена без показания из журнала не выпадает: «смена была, цифр нет» — то, ради чего его и
    // открывают. Прочерки в её числах не притворяются нулями.
    expect(book[0]!.rows[2]!.slice(5, 10)).toEqual(['—', '—', '—', '—', '—']);
    expect(book[0]!.rows[2]!.at(-1)).toBe('не сдано');
  });

  it('журнал машины по месяцам — месяц отдельным листом, пустой месяц тоже', async () => {
    state.journalRows = [
      journalRow({ reportDate: '2026-01-05' }),
      journalRow({ reportDate: '2026-03-11', shiftOrder: 1 }),
    ];
    state.journalTotal = 2;

    const book = await download(
      `kind=vehicleMonths&from=2026-01-01&to=2026-03-31&vehicleId=${VEHICLE_ID}`,
    );

    expect(book.map((sheet) => sheet.name)).toEqual(['01.2026', '02.2026', '03.2026']);
    expect(book[0]!.rows).toHaveLength(2);
    // Месяц без смен — лист с одной шапкой: он говорит «смен не было», а пропущенный заставлял бы
    // гадать, попал ли месяц в выгрузку.
    expect(book[1]!.rows).toHaveLength(1);
    expect(book[2]!.rows[1]![0]).toBe('11.03.2026');
  });

  it('журнал всего парка — одним листом, машина первой колонкой', async () => {
    state.journalRows = [
      journalRow(),
      journalRow({ registrationNumber: 'В777АА99', reportDate: '2026-01-07' }),
    ];
    state.journalTotal = 2;

    const book = await download('kind=fleetJournal&from=2026-01-01&to=2026-01-31');

    expect(book).toHaveLength(1);
    expect(book[0]!.rows[0]![0]).toBe('Техника');
    expect(book[0]!.rows.slice(1).map((row) => row[0])).toEqual(['А123БВ777', 'В777АА99']);
  });

  it('срез на дату — последние счётчики с датами их снятия', async () => {
    const book = await download('kind=snapshot&from=2026-01-01&to=2026-03-31');

    expect(book).toHaveLength(1);
    expect(book[0]!.name).toBe('Срез на 2026-03-31');
    expect(book[0]!.rows[0]!.slice(0, 5)).toEqual([
      'Техника',
      'Одометр, км',
      'Одометр снят',
      'Моточасы, м/ч',
      'Моточасы сняты',
    ]);
    expect(book[0]!.rows[1]!.slice(0, 5)).toEqual([
      'А123БВ777',
      '128400',
      '30.03.2026',
      '9310,5',
      '29.03.2026',
    ]);
    // Машина без единого снимка счётчика — прочерки, а не нули: «показаний не было» и «на приборе
    // ноль» портал обязан различать.
    expect(book[0]!.rows[2]!.slice(1, 5)).toEqual(['—', '—', '—', '—']);
  });
});

/**
 * Граница прав в срезе (Р14а, Р14б) — та самая, ради которой карточка показаний и сводка ТО
 * разведены по разным ручкам. Колонки обслуживания приходят целиком либо не приходят вовсе: пустая
 * колонка «Дата ТО» соврала бы про парк («обслуживания не было»), а отсутствующая не говорит про
 * ТО ничего.
 */
describe('срез на дату и право на данные ТО', () => {
  it('с правом vehicleMaintenance.read колонки ТО есть и заполнены', async () => {
    state.maintenance = new Map<string, unknown>([
      [
        VEHICLE_ID,
        {
          vehicleId: VEHICLE_ID,
          vehicleLabel: 'А123БВ777',
          maintenanceBasis: 'odometer',
          lastOdometer: { km: 128_400, measuredOn: '2026-03-30' },
          lastMaintenance: { performedOn: '2026-02-10', odometerKm: 120_000 },
          kmSince: 8_400,
          chainBroken: false,
          lowerBound: true,
          state: 'due_soon',
        },
      ],
    ]);

    const book = await download('kind=snapshot&from=2026-01-01&to=2026-03-31');

    expect(book[0]!.rows[0]!.slice(5)).toEqual(['Дата ТО', 'Пробег с ТО, км', 'Состояние ТО']);
    // «не меньше» — не украшение: между последним снимком и днём среза остались несданные смены,
    // и число известно только снизу (Р11в).
    expect(book[0]!.rows[1]!.slice(5)).toEqual(['10.02.2026', 'не меньше 8400', 'скоро ТО']);
    expect(state.calls).toContain('maintenance');
  });

  it('без права колонок ТО в книге нет, и сводка обслуживания не запрашивается вовсе', async () => {
    /*
     * Проверка идёт мимо ручки намеренно: сегодня `vehicleReadings.read` есть ровно у тех ролей, у
     * которых есть и `vehicleMaintenance.read` (менеджер, диспетчер, администратор), и субъекта,
     * который дошёл бы до выгрузки без права на ТО, в матрице просто нет. Граница от этого не
     * перестаёт существовать — она в сборщике, и спрашивать её надо у него: разойдись роли завтра
     * (механику дали журнал, наблюдателю — сводку), книга обязана остаться без колонок ТО.
     */
    state.calls = [];
    const book = readWorkbook(
      (
        await buildReadingsExport({
          kind: 'snapshot',
          from: '2026-01-01',
          to: '2026-03-31',
          withMaintenance: false,
        })
      ).bytes,
    );

    expect(book[0]!.rows[0]).toEqual([
      'Техника',
      'Одометр, км',
      'Одометр снят',
      'Моточасы, м/ч',
      'Моточасы сняты',
    ]);
    expect(book[0]!.rows[1]).toHaveLength(5);
    expect(state.calls).not.toContain('maintenance');
  });
});

describe('границы ручки выгрузок', () => {
  it('неизвестный вариант — 400 и без обращения к расчёту', async () => {
    state.calls = [];
    const res = await get(exportUrl('kind=fleetSummaryEx&from=2026-01-01&to=2026-03-31'));

    expect(res.statusCode).toBe(400);
    expect(state.calls, 'отказ обязан случиться до расчёта').toEqual([]);
  });

  it('период больше года — 400 и без обращения к расчёту', async () => {
    state.calls = [];
    const res = await get(exportUrl('kind=fleetSummary&from=2026-01-01&to=2027-01-05'));

    expect(res.statusCode).toBe(400);
    expect(res.json<{ fields?: Record<string, string> }>().fields?.to).toBeTruthy();
    expect(state.calls).toEqual([]);
  });

  it('журналу машины машина обязательна, парковым вариантам — запрещена', async () => {
    const withoutVehicle = await get(
      exportUrl('kind=vehicleJournal&from=2026-01-01&to=2026-01-31'),
    );
    expect(withoutVehicle.statusCode).toBe(400);
    expect(
      withoutVehicle.json<{ fields?: Record<string, string> }>().fields?.vehicleId,
    ).toBeTruthy();

    const extraVehicle = await get(
      exportUrl(`kind=fleetJournal&from=2026-01-01&to=2026-01-31&vehicleId=${VEHICLE_ID}`),
    );
    expect(extraVehicle.statusCode).toBe(400);
    expect(extraVehicle.json<{ fields?: Record<string, string> }>().fields?.vehicleId).toBeTruthy();
  });

  it('несуществующая машина — 404, а не пустая книга', async () => {
    state.vehicleRows = [];
    const res = await get(
      exportUrl(`kind=vehicleJournal&from=2026-01-01&to=2026-01-31&vehicleId=${MISSING_ID}`),
    );

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('not_found');
  });

  /**
   * Предел построчных выгрузок (Р31): книга собирается в памяти целиком, поэтому строки считаются
   * **до** выборки и отказ говорит, сколько их и что делать. Молчаливое обрезание было бы худшим
   * из решений — подписывают и сверяют выгрузку целиком.
   */
  it('слишком много строк — отказ «сузьте период», а не обрезанная книга', async () => {
    state.journalTotal = rowLimit + 1;
    state.journalRows = [];

    const res = await get(exportUrl('kind=fleetJournal&from=2026-01-01&to=2026-12-31'));
    expect(res.statusCode).toBe(400);

    const body = res.json<{ message: string; fields?: Record<string, string> }>();
    expect(body.message).toContain(String(rowLimit));
    expect(body.message).toMatch(/сузьте период/iu);
    expect(body.fields?.to).toBeTruthy();
  });

  it('ровно предел — книга собирается: потолок это граница, а не запрет', async () => {
    state.journalTotal = rowLimit;
    state.journalRows = [journalRow()];

    const book = await download('kind=fleetJournal&from=2026-01-01&to=2026-12-31');
    expect(book[0]!.rows).toHaveLength(2);
  });

  it('без права vehicleReadings.read — 403 и без обращения к расчёту', async () => {
    state.calls = [];
    const res = await get(exportUrl('kind=fleetSummary&from=2026-01-01&to=2026-03-31'), 'observer');

    expect(res.statusCode).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('книга приходит книгой: тип и имя файла в заголовке', async () => {
    const res = await get(exportUrl('kind=fleetSummary&from=2026-01-01&to=2026-03-31'));

    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain(
      encodeURIComponent('Показания техники 2026-01-01 – 2026-03-31.xlsx'),
    );
  });
});

/**
 * Расхода портал не считает и производных не заводит (Р28, §8): цифра, поделённая на пробег,
 * читается как расход независимо от подписи, а в чужой книге с формулами она заводит его
 * окончательно вне контроля портала. Проверяются заголовки **всех** вариантов сразу — новая
 * колонка приедет в этот тест раньше, чем в чужую сводную таблицу.
 */
describe('ни одной производной колонки ни в одной книге', () => {
  it('заголовки всех вариантов не знают ни «на 100 км», ни расхода', async () => {
    const queries = [
      'kind=fleetSummary&from=2026-01-01&to=2026-03-31',
      'kind=fleetMonths&from=2026-01-01&to=2026-03-31',
      `kind=vehicleJournal&from=2026-01-01&to=2026-01-31&vehicleId=${VEHICLE_ID}`,
      `kind=vehicleMonths&from=2026-01-01&to=2026-03-31&vehicleId=${VEHICLE_ID}`,
      'kind=snapshot&from=2026-01-01&to=2026-03-31',
      'kind=fleetJournal&from=2026-01-01&to=2026-01-31',
    ];
    for (const query of queries) {
      const book = await download(query);
      const headers = book.map((sheet) => (sheet.rows[0] ?? []).join(' ')).join(' | ');
      expect(headers, query).not.toMatch(/100|расход|л\/|на моточас/iu);
    }
  });
});
