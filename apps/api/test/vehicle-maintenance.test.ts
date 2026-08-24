import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  moscowDateKeyOf,
  type Role,
  type VehicleMaintenanceDto,
  type VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
// Только тип модуля: сам он подменяется ниже, а `import()` в аннотации проект запрещает — тем же
// приёмом берёт тип сервиса тест карточки показаний.
import type * as MaintenanceNs from '../src/services/vehicle-maintenance';

/**
 * Ручки техобслуживания `/api/v1/vehicle-maintenance` (план «Показания техники», §6).
 *
 * Проверяется здесь ручка, а не расчёт: право на входе, день среза, состав ответа, отсутствие
 * машины, конфликт версий и отказ на кривом вводе. Сам расчёт живёт своей жизнью и проверяется на
 * живой схеме — там, где SQL можно спросить у базы, а не у подмены.
 *
 * Отсюда устройство: сервис подменён, БД подменена заглушкой, падающей на любом запросе. Ни один
 * сценарий до базы не доходит, и падение заглушки означало бы, что маршрут пошёл в неё мимо
 * сервиса.
 */

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
/** Машина, которой нет в справочнике: сводка отвечает на неё `null`, ручка обязана дать 404. */
const MISSING_VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
const MAINTENANCE_ID = '44444444-4444-4444-8444-444444444444';
const PERSON_ID = '55555555-5555-4555-8555-555555555555';
const FILE_ID = '66666666-6666-4666-8666-666666666666';

/** Версия, на которой подменённый сервис отвечает конфликтом, — как живой на разошедшейся (Р30). */
const STALE_VERSION = 1;
const CURRENT_VERSION = 4;

interface ServiceCall {
  fn: string;
  args: unknown[];
}

/**
 * Состояние подмен: роль текущего запроса и журнал обращений к сервису. Журнал нужен отрицательным
 * проверкам — отказ по праву и отказ по схеме обязаны случиться **до** сервиса, а не после него:
 * иначе запрос без права успевал бы прочитать данные и только потом получить 403.
 */
const state = vi.hoisted(() => ({
  role: 'admin' as Role | null,
  calls: [] as { fn: string; args: unknown[] }[],
}));

const RECORD: VehicleMaintenanceDto = {
  id: MAINTENANCE_ID,
  vehicleId: VEHICLE_ID,
  performedOn: '2026-08-10',
  odometerKm: 128_400,
  documentNumber: 'АКТ-17',
  note: 'Замена масла',
  // Скан акта приходит с именем, типом и размером: форма рисует по нему ссылку, а не подпись
  // «Скан 1».
  files: [{ id: FILE_ID, filename: 'акт-17.pdf', contentType: 'application/pdf', size: 128_400 }],
  version: CURRENT_VERSION,
  createdAt: '2026-08-10T07:00:00.000Z',
  createdByName: 'Механиков М. М.',
  updatedAt: '2026-08-10T07:00:00.000Z',
  updatedByName: '',
  // Акт действующий: три поля аннулирования — одно состояние, и пустые они ровно вместе (Р6).
  voidedAt: null,
  voidedByName: '',
  voidReason: '',
  // Строки расхода и признак движений — полный DTO акта (Р23): его отдают история, форма и
  // карточка, тогда как сводка получает краткий, без строк.
  parts: [],
  hasPartMovements: false,
};

const { parts: _parts, hasPartMovements: _moved, ...recordWithoutParts } = RECORD;

const summaryOf = (vehicleId: string): VehicleMaintenanceSummaryDto => ({
  vehicleId,
  vehicleLabel: 'Экскаватор JCB, А123БВ777',
  maintenanceBasis: 'odometer',
  lastOdometer: { km: 136_740, measuredOn: '2026-08-12' },
  // Краткий акт (Р23): строк и признака движений в сводке нет — она приходит пакетом на страницу.
  lastMaintenance: { ...recordWithoutParts, vehicleId },
  kmSince: 8_340,
  chainBroken: false,
  lowerBound: false,
  state: 'due_soon',
});

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
              reject(new Error('вызов БД в тесте ручек ТО'))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
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
 * Подменяются шесть функций, остальной модуль остаётся настоящим: сервис ТО зовут и колонка
 * гаража, и портал, и factory-подмена «только то, что нужно мне» ломала бы соседей молча —
 * недостающий экспорт виден не при сборке приложения, а при вызове чужого обработчика.
 *
 * Конфликт версий подменённый сервис бросает тем же `err.conflict`, каким его бросает живой:
 * ответом 409 занимается общий обработчик ошибок, и проверять его на самодельном исключении
 * значило бы проверять подмену.
 */
vi.mock('../src/services/vehicle-maintenance', async (importOriginal) => {
  const { err } = await import('../src/lib/errors');
  const note = (fn: string, ...args: unknown[]): void => {
    state.calls.push({ fn, args });
  };
  return {
    ...(await importOriginal<typeof MaintenanceNs>()),
    loadMaintenanceSummary: async (
      vehicleId: string,
      onDate: string,
    ): Promise<VehicleMaintenanceSummaryDto | null> => {
      note('loadMaintenanceSummary', vehicleId, onDate);
      return vehicleId === MISSING_VEHICLE_ID ? null : summaryOf(vehicleId);
    },
    loadMaintenanceSnapshot: async (
      vehicleIds: string[],
      onDate: string,
    ): Promise<Map<string, VehicleMaintenanceSummaryDto>> => {
      note('loadMaintenanceSnapshot', vehicleIds, onDate);
      // Ответ намеренно в обратном порядке и без одной машины: строки ставятся против страницы
      // гаража, и порядок ответа задаёт запрос, а не расчёт.
      return new Map(
        [...vehicleIds]
          .reverse()
          .filter((id) => id !== MISSING_VEHICLE_ID)
          .map((id) => [id, summaryOf(id)]),
      );
    },
    loadMaintenanceHistory: async (vehicleId: string): Promise<VehicleMaintenanceDto[]> => {
      note('loadMaintenanceHistory', vehicleId);
      return vehicleId === MISSING_VEHICLE_ID ? [] : [{ ...RECORD, vehicleId }];
    },
    createMaintenance: async (
      vehicleId: string,
      input: unknown,
      actor: { id: string },
    ): Promise<VehicleMaintenanceDto> => {
      note('createMaintenance', vehicleId, input, actor.id);
      return { ...RECORD, vehicleId, version: 0 };
    },
    updateMaintenance: async (
      id: string,
      input: unknown,
      version: number,
      actor: { id: string },
    ): Promise<VehicleMaintenanceDto> => {
      note('updateMaintenance', id, input, version, actor.id);
      if (version !== CURRENT_VERSION) throw err.conflict();
      return { ...RECORD, id, version: version + 1, updatedByName: 'Механиков М. М.' };
    },
    voidMaintenance: async (
      id: string,
      input: { version: number; reason: string },
      actor: { id: string },
    ): Promise<VehicleMaintenanceDto> => {
      note('voidMaintenance', id, input, actor.id);
      if (input.version !== CURRENT_VERSION) throw err.conflict();
      return {
        ...RECORD,
        id,
        version: input.version + 1,
        voidedAt: '2026-08-12T09:00:00.000Z',
        voidedByName: 'Механиков М. М.',
        voidReason: input.reason,
        parts: [],
      };
    },
    deleteMaintenance: async (
      id: string,
      version: number,
      actor: { id: string },
    ): Promise<void> => {
      note('deleteMaintenance', id, version, actor.id);
      if (version !== CURRENT_VERSION) throw err.conflict();
    },
  };
});

let app: FastifyInstance;

/** Каждый запрос — со своего адреса: защита от подбора считает по IP, а тест проверяет не её. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.0.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { role?: Role | null; payload?: unknown } = {},
) {
  state.role = options.role === undefined ? 'admin' : options.role;
  return app.inject({
    method,
    url: `/api/v1/vehicle-maintenance${url}`,
    payload: options.payload as never,
    remoteAddress: nextAddress(),
    headers: { authorization: 'Bearer test-token' },
  });
}

const lastCall = (): ServiceCall | undefined => state.calls.at(-1);

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
   * Свой таймаут хука — по той же причине, что и у теста карточки показаний: поднимается всё
   * приложение, а подмена сервиса тянет через `importOriginal` настоящий модуль со всей роднёй.
   * Трансформация этого дерева вместе со сборкой упирается в умолчание vitest (10 с), и тест
   * начинал падать, не проверив ни одного утверждения.
   */
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('сводка ТО по машине', () => {
  it('отдаёт основание, последний одометр, последнее ТО, пробег и состояние', async () => {
    const res = await call('GET', `/vehicles/${VEHICLE_ID}/summary?on=2026-08-12`);
    expect(res.statusCode).toBe(200);

    const body = res.json<VehicleMaintenanceSummaryDto>();
    expect(body.vehicleId).toBe(VEHICLE_ID);
    expect(body.maintenanceBasis).toBe('odometer');
    expect(body.lastOdometer).toEqual({ km: 136_740, measuredOn: '2026-08-12' });
    expect(body.lastMaintenance?.id).toBe(MAINTENANCE_ID);
    expect(body.kmSince).toBe(8_340);
    expect(body.state).toBe('due_soon');
  });

  /**
   * Граница прав (Р14а, Р14б): последний одометр в сводке есть — без него «8 340 км с ТО» нечем
   * проверить, — а всего остального про показания нет и быть не должно. Проверка идёт по составу
   * ключей, потому что нарушение здесь выглядит не отказом, а лишним полем: журнал, приросты,
   * аномалии и фотографии под правом ТО закрыты.
   */
  it('не отдаёт ничего из модуля показаний, кроме последнего одометра', async () => {
    const res = await call('GET', `/vehicles/${VEHICLE_ID}/summary?on=2026-08-12`);
    expect(Object.keys(res.json()).sort()).toEqual([
      'chainBroken',
      'kmSince',
      'lastMaintenance',
      'lastOdometer',
      'lowerBound',
      'maintenanceBasis',
      'state',
      'vehicleId',
      'vehicleLabel',
    ]);
  });

  /** День среза (Р16) доезжает до расчёта тем же, каким пришёл: срез марта не считает майское ТО. */
  it('передаёт день среза в расчёт', async () => {
    await call('GET', `/vehicles/${VEHICLE_ID}/summary?on=2026-03-10`);
    expect(lastCall()).toEqual({
      fn: 'loadMaintenanceSummary',
      args: [VEHICLE_ID, '2026-03-10'],
    });
  });

  /**
   * Умолчание считает сервер (Р16): часы браузера бывают сбиты, а восточнее Москвы сутки
   * начинаются раньше — «сегодня» клиента показало бы ТО, проведённое завтра.
   */
  it('без параметра берёт сегодняшний московский день', async () => {
    await call('GET', `/vehicles/${VEHICLE_ID}/summary`);
    expect(lastCall()?.args).toEqual([VEHICLE_ID, moscowDateKeyOf(new Date())]);
  });

  it('несуществующая машина — 404, а не пустая сводка', async () => {
    const res = await call('GET', `/vehicles/${MISSING_VEHICLE_ID}/summary`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('not_found');
  });

  it('кривой день среза — 400 до расчёта', async () => {
    const before = state.calls.length;
    const res = await call('GET', `/vehicles/${VEHICLE_ID}/summary?on=2026-02-31`);

    expect(res.statusCode).toBe(400);
    expect(state.calls.length, 'отказ по схеме обязан случиться до расчёта').toBe(before);
  });

  it('без права vehicleMaintenance.read — 403 и без обращения к расчёту', async () => {
    const before = state.calls.length;
    const res = await call('GET', `/vehicles/${VEHICLE_ID}/summary`, { role: 'observer' });

    expect(res.statusCode).toBe(403);
    expect(state.calls.length, 'отказ по праву обязан случиться до расчёта').toBe(before);
  });
});

describe('состояние пакетом для колонки гаража', () => {
  it('отдаёт строки в порядке запроса и называет день среза', async () => {
    const res = await call(
      'GET',
      `/snapshot?on=2026-08-12&ids=${VEHICLE_ID},${MISSING_VEHICLE_ID},${SECOND_VEHICLE_ID}`,
    );
    expect(res.statusCode).toBe(200);

    const body = res.json<{ on: string; items: VehicleMaintenanceSummaryDto[] }>();
    expect(body.on).toBe('2026-08-12');
    // Расчёт вернул строки в обратном порядке и без ненайденной машины: порядок ответа задаёт
    // запрос — колонка ставится против строк страницы, — а машина без сводки просто выпадает.
    expect(body.items.map((i) => i.vehicleId)).toEqual([VEHICLE_ID, SECOND_VEHICLE_ID]);
    expect(lastCall()).toEqual({
      fn: 'loadMaintenanceSnapshot',
      args: [[VEHICLE_ID, MISSING_VEHICLE_ID, SECOND_VEHICLE_ID], '2026-08-12'],
    });
  });

  it('пустой список машин — пустой ответ и ни одного запроса к расчёту', async () => {
    const before = state.calls.length;
    const res = await call('GET', '/snapshot?on=2026-08-12&ids=');

    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
    expect(state.calls.length, 'пустая страница базу не спрашивает').toBe(before);
  });

  it('не-uuid в списке машин — 400', async () => {
    const res = await call('GET', '/snapshot?ids=не-машина');
    expect(res.statusCode).toBe(400);
  });

  it('без права vehicleMaintenance.read — 403', async () => {
    const res = await call('GET', `/snapshot?ids=${VEHICLE_ID}`, { role: 'observer' });
    expect(res.statusCode).toBe(403);
  });
});

describe('история записей ТО', () => {
  it('отдаёт записи машины', async () => {
    const res = await call('GET', `/vehicles/${VEHICLE_ID}/history`);
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: VehicleMaintenanceDto[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(MAINTENANCE_ID);
    // Скан акта — с именем и размером: по списку одних идентификаторов форма подписывала вложения
    // «Скан 1» и открыть их не могла.
    expect(body.items[0]?.files).toEqual([
      { id: FILE_ID, filename: 'акт-17.pdf', contentType: 'application/pdf', size: 128_400 },
    ]);
    expect(body.items[0]?.version).toBe(CURRENT_VERSION);
  });

  it('без права vehicleMaintenance.read — 403', async () => {
    const res = await call('GET', `/vehicles/${VEHICLE_ID}/history`, { role: 'observer' });
    expect(res.statusCode).toBe(403);
  });
});

describe('ведение записи ТО', () => {
  it('заводит запись и отвечает 201', async () => {
    const res = await call('POST', `/vehicles/${VEHICLE_ID}`, {
      payload: {
        performedOn: '2026-08-10',
        odometerKm: 128_400,
        documentNumber: 'АКТ-17',
        note: 'Замена масла',
        fileIds: [FILE_ID],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<VehicleMaintenanceDto>().vehicleId).toBe(VEHICLE_ID);
    // Машина берётся из адреса, а не из тела; автор — из принципала, а не из запроса.
    expect(lastCall()).toEqual({
      fn: 'createMaintenance',
      args: [
        VEHICLE_ID,
        {
          performedOn: '2026-08-10',
          odometerKm: 128_400,
          documentNumber: 'АКТ-17',
          note: 'Замена масла',
          fileIds: [FILE_ID],
          // Умолчание схемы ЗАВЕДЕНИЯ: строк у нового акта ещё нет (Р18).
          parts: [],
        },
        'user-1',
      ],
    });
  });

  /** Акт без пробега и без реквизитов — законная запись (Р11а): умолчания расставляет схема. */
  it('принимает акт без одометра, номера и скана', async () => {
    const res = await call('POST', `/vehicles/${VEHICLE_ID}`, {
      payload: { performedOn: '2026-08-10' },
    });

    expect(res.statusCode).toBe(201);
    expect(lastCall()?.args[1]).toEqual({
      performedOn: '2026-08-10',
      odometerKm: null,
      documentNumber: '',
      note: '',
      fileIds: [],
      parts: [],
    });
  });

  it('дата обязательна — без неё 400 и ни одного обращения к сервису', async () => {
    const before = state.calls.length;
    const res = await call('POST', `/vehicles/${VEHICLE_ID}`, {
      payload: { odometerKm: 128_400 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ fields?: Record<string, string> }>().fields?.performedOn).toBeTruthy();
    expect(state.calls.length).toBe(before);
  });

  it('отрицательный одометр — 400', async () => {
    const res = await call('POST', `/vehicles/${VEHICLE_ID}`, {
      payload: { performedOn: '2026-08-10', odometerKm: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('машина в теле — 400: её задаёт адрес, и второго места у неё нет', async () => {
    const res = await call('POST', `/vehicles/${VEHICLE_ID}`, {
      payload: { performedOn: '2026-08-10', vehicleId: SECOND_VEHICLE_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('правка идёт с версией и возвращает новую', async () => {
    const res = await call('PATCH', `/${MAINTENANCE_ID}`, {
      payload: {
        performedOn: '2026-08-11',
        odometerKm: 128_500,
        documentNumber: 'АКТ-17',
        version: CURRENT_VERSION,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<VehicleMaintenanceDto>().version).toBe(CURRENT_VERSION + 1);
    // Версия уходит отдельным параметром, а в реквизитах записи её нет: она не поле акта.
    const { fn, args } = lastCall()!;
    expect(fn).toBe('updateMaintenance');
    expect(args[0]).toBe(MAINTENANCE_ID);
    // `parts` в теле не было — и в сервис оно не подставляется: отсутствие поля у ПРАВКИ означает
    // «строки не менять» (Р18), а пустой массив означал бы «снять все».
    expect(args[1]).toEqual({
      performedOn: '2026-08-11',
      odometerKm: 128_500,
      documentNumber: 'АКТ-17',
      note: '',
      fileIds: [],
    });
    expect(args[2]).toBe(CURRENT_VERSION);
    expect(args[3]).toBe('user-1');
  });

  it('правка без версии — 400', async () => {
    const before = state.calls.length;
    const res = await call('PATCH', `/${MAINTENANCE_ID}`, {
      payload: { performedOn: '2026-08-11' },
    });

    expect(res.statusCode).toBe(400);
    expect(state.calls.length).toBe(before);
  });

  /** Разошедшаяся версия — 409 с внятным текстом: правили не то, что видят сейчас (Р30). */
  it('устаревшая версия правки — 409', async () => {
    const res = await call('PATCH', `/${MAINTENANCE_ID}`, {
      payload: { performedOn: '2026-08-11', version: STALE_VERSION },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string; message: string }>();
    expect(body.code).toBe('version_conflict');
    expect(body.message).toMatch(/обновите данные/i);
  });

  /**
   * Аннулирование (план автозапчастей, Р6). Ручка заведена ради РАСЧЁТА: акт с движением склада
   * удалить нельзя, а оставленный пустым он остался бы последним обслуживанием машины — «пробег с
   * ТО» считался бы от ложного якоря. Здесь проверяется ручка: причина обязательна, версия уходит
   * в сервис, а состояние приходит в ответе.
   */
  it('аннулирование идёт с версией и причиной', async () => {
    const res = await call('POST', `/${MAINTENANCE_ID}/void`, {
      payload: { version: CURRENT_VERSION, reason: 'Ошибочно заведён на другую машину' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<VehicleMaintenanceDto>();
    expect(body.voidedAt).not.toBeNull();
    expect(body.voidReason).toBe('Ошибочно заведён на другую машину');
    expect(lastCall()).toEqual({
      fn: 'voidMaintenance',
      args: [
        MAINTENANCE_ID,
        { version: CURRENT_VERSION, reason: 'Ошибочно заведён на другую машину' },
        'user-1',
      ],
    });
  });

  /** Причина обязательна: «аннулировали и не сказали зачем» — документ, который нечем прочитать. */
  it('аннулирование без причины — 400 и ни одного обращения к сервису', async () => {
    const before = state.calls.length;
    const res = await call('POST', `/${MAINTENANCE_ID}/void`, {
      payload: { version: CURRENT_VERSION },
    });

    expect(res.statusCode).toBe(400);
    expect(state.calls.length).toBe(before);
  });

  it('аннулирование с устаревшей версией — 409', async () => {
    const res = await call('POST', `/${MAINTENANCE_ID}/void`, {
      payload: { version: STALE_VERSION, reason: 'Ошибка ввода' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('аннулирование без права vehicleMaintenance.write — 403', async () => {
    const before = state.calls.length;
    const res = await call('POST', `/${MAINTENANCE_ID}/void`, {
      role: 'observer',
      payload: { version: CURRENT_VERSION, reason: 'Ошибка ввода' },
    });

    expect(res.statusCode).toBe(403);
    expect(state.calls.length).toBe(before);
  });

  it('удаление идёт с версией из адреса', async () => {
    const res = await call('DELETE', `/${MAINTENANCE_ID}?version=${CURRENT_VERSION}`);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(lastCall()).toEqual({
      fn: 'deleteMaintenance',
      args: [MAINTENANCE_ID, CURRENT_VERSION, 'user-1'],
    });
  });

  it('удаление без версии — 400 и ни одного обращения к сервису', async () => {
    const before = state.calls.length;
    const res = await call('DELETE', `/${MAINTENANCE_ID}`);

    expect(res.statusCode).toBe(400);
    expect(state.calls.length).toBe(before);
  });

  it('устаревшая версия удаления — 409', async () => {
    const res = await call('DELETE', `/${MAINTENANCE_ID}?version=${STALE_VERSION}`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('version_conflict');
  });

  /**
   * Роли, которой журнал ТО показывают только читать, в замысле нет: чтение и ведение идут парой у
   * всех четырёх ролей, которым право положено (`VEHICLE_MAINTENANCE_PERMISSIONS`), и держит это
   * `permissions.test.ts`. Поэтому «только чтение против записи» здесь проверяется тем, что есть, —
   * ролью без права ТО вовсе: она не проходит ни на одну из трёх пишущих ручек.
   */
  it('без права vehicleMaintenance.write — 403 на всех трёх ручках', async () => {
    const before = state.calls.length;
    const responses = await Promise.all([
      call('POST', `/vehicles/${VEHICLE_ID}`, {
        role: 'observer',
        payload: { performedOn: '2026-08-10' },
      }),
      call('PATCH', `/${MAINTENANCE_ID}`, {
        role: 'observer',
        payload: { performedOn: '2026-08-10', version: CURRENT_VERSION },
      }),
      call('DELETE', `/${MAINTENANCE_ID}?version=${CURRENT_VERSION}`, { role: 'observer' }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    expect(state.calls.length, 'отказ по праву обязан случиться до сервиса').toBe(before);
  });
});
