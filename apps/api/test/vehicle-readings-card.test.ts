import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Role, VehicleReadingCardDto } from '@technic/contracts';
// Только тип модуля: сам он подменяется ниже, а `import()` в аннотации проект запрещает — тем же
// приёмом берут типы сервисов db-тесты показаний.
import type * as AggregateNs from '../src/services/readings-aggregate';

/**
 * Ручка карточки машины `GET /vehicle-readings/vehicles/:id/card` (план «Показания техники», §6).
 *
 * Проверяется здесь именно ручка, а не расчёт: период и его потолок, отказ по праву, отсутствие
 * машины и состав ответа. Сам агрегат живёт своей жизнью и проверяется на живой схеме
 * (`readings-aggregate.db.test.ts`) — там, где SQL можно спросить у базы, а не у подмены.
 *
 * Отсюда и устройство: расчёт подменён, БД подменена заглушкой, которая падает на любой запрос.
 * Обработчик до неё не доходит ни в одном сценарии, и падение заглушки означало бы, что маршрут
 * пошёл в базу мимо агрегата.
 */

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
/** Машина, которой нет в справочнике: расчёт отвечает на неё `null`, ручка обязана дать 404. */
const MISSING_ID = '22222222-2222-4222-8222-222222222222';
const PERSON_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Состояние подмен: роль текущего запроса и журнал обращений к расчёту. Журнал нужен обеим
 * отрицательным проверкам — отказ по праву и отказ по периоду обязаны случиться **до** расчёта, а
 * не после него: иначе годовой запрос успевал бы собрать данные за десять лет и только потом
 * получить 400.
 */
const state = vi.hoisted(() => ({
  role: 'admin' as Role | null,
  calls: [] as { vehicleId: string; from: string; to: string }[],
}));

/** Ответ расчёта: числа здесь любые, важна форма — её ручка отдаёт как есть. */
const CARD: VehicleReadingCardDto = {
  vehicleId: VEHICLE_ID,
  vehicleLabel: 'Экскаватор JCB, А123БВ777',
  from: '2026-01-01',
  to: '2026-03-31',
  total: {
    distanceKm: 1200,
    engineHours: 310.5,
    fuelFilledLiters: 4200,
    odometerGaps: 1,
    engineHoursGaps: 0,
    missingReadings: 2,
    shifts: 60,
    unacceptedShifts: 3,
  },
  months: [
    {
      month: '2026-01',
      distanceKm: 1200,
      engineHours: 310.5,
      fuelFilledLiters: 4200,
      odometerGaps: 1,
      engineHoursGaps: 0,
      missingReadings: 2,
      shifts: 60,
      unacceptedShifts: 3,
    },
  ],
  lastOdometer: { km: 128_400, measuredOn: '2026-03-30' },
  lastEngineHours: { value: 9_310.5, measuredOn: '2026-03-30' },
};

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
              reject(new Error('вызов БД в тесте карточки показаний'))
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
 * Подменяется одна функция, остальной модуль остаётся настоящим: агрегат общий на несколько ручек,
 * и factory-подмена «только то, что нужно мне» ломала бы соседей молча — недостающий экспорт виден
 * не при сборке приложения, а при вызове чужого обработчика.
 */
vi.mock('../src/services/readings-aggregate', async (importOriginal) => ({
  ...(await importOriginal<typeof AggregateNs>()),
  loadVehicleCard: async (
    vehicleId: string,
    from: string,
    to: string,
  ): Promise<VehicleReadingCardDto | null> => {
    state.calls.push({ vehicleId, from, to });
    return vehicleId === VEHICLE_ID ? { ...CARD, from, to } : null;
  },
}));

let app: FastifyInstance;

/** Каждый запрос — со своего адреса: защита от подбора считает по IP, а тест проверяет не её. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.0.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
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

const cardUrl = (id: string, from: string, to: string): string =>
  `/api/v1/vehicle-readings/vehicles/${id}/card?from=${from}&to=${to}`;

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
   * `importOriginal` настоящий модуль агрегата со всей его роднёй. Трансформация этого дерева
   * занимает секунды, и вместе со сборкой упирается в умолчание vitest (10 с) — тест начинал
   * мигать красным на загруженной машине, ничего не проверив. Тридцати хватает с запасом; если
   * когда-нибудь перестанет — виновата будет сборка приложения, а не этот тест.
   */
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('карточка машины в статистике показаний', () => {
  it('отдаёт итог периода, месяцы и последние показания', async () => {
    const res = await get(cardUrl(VEHICLE_ID, '2026-01-01', '2026-03-31'));
    expect(res.statusCode).toBe(200);

    const body = res.json<VehicleReadingCardDto>();
    expect(body.vehicleId).toBe(VEHICLE_ID);
    expect(body.from).toBe('2026-01-01');
    expect(body.to).toBe('2026-03-31');
    expect(body.total.distanceKm).toBe(1200);
    expect(body.total.unacceptedShifts).toBe(3);
    expect(body.months.map((m) => m.month)).toEqual(['2026-01']);
    expect(body.lastOdometer).toEqual({ km: 128_400, measuredOn: '2026-03-30' });
    expect(body.lastEngineHours).toEqual({ value: 9_310.5, measuredOn: '2026-03-30' });

    // Период доезжает до расчёта тем же, каким пришёл: карточка марта не должна считать май.
    expect(state.calls.at(-1)).toEqual({
      vehicleId: VEHICLE_ID,
      from: '2026-01-01',
      to: '2026-03-31',
    });
  });

  /**
   * Блока ТО в ответе нет и быть не должно (Р14а): сводка обслуживания приходит своей ручкой под
   * `vehicleMaintenance.read`. Поле, исчезающее по чужому праву, — то же смешение прав, только
   * спрятанное в сериализатор, и проверка состава ключей держит эту границу на месте.
   */
  it('не отдаёт ничего про обслуживание: у ТО своя ручка и своё право', async () => {
    const res = await get(cardUrl(VEHICLE_ID, '2026-01-01', '2026-03-31'));
    expect(Object.keys(res.json()).sort()).toEqual([
      'from',
      'lastEngineHours',
      'lastOdometer',
      'months',
      'to',
      'total',
      'vehicleId',
      'vehicleLabel',
    ]);
  });

  it('период больше года отклоняет до расчёта', async () => {
    const before = state.calls.length;
    const res = await get(cardUrl(VEHICLE_ID, '2026-01-01', '2027-01-05'));

    expect(res.statusCode).toBe(400);
    expect(res.json<{ fields?: Record<string, string> }>().fields?.to).toBeTruthy();
    expect(state.calls.length, 'расчёт не должен звать на отвергнутом периоде').toBe(before);
  });

  it('ровно год принимает: потолок — граница, а не запрет на годовой отчёт', async () => {
    const res = await get(cardUrl(VEHICLE_ID, '2026-01-01', '2026-12-31'));
    expect(res.statusCode).toBe(200);
  });

  it('несуществующая машина — 404, а не пустая карточка', async () => {
    const res = await get(cardUrl(MISSING_ID, '2026-01-01', '2026-03-31'));
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('not_found');
  });

  it('без права vehicleReadings.read — 403 и без обращения к расчёту', async () => {
    const before = state.calls.length;
    const res = await get(cardUrl(VEHICLE_ID, '2026-01-01', '2026-03-31'), 'observer');

    expect(res.statusCode).toBe(403);
    expect(state.calls.length, 'отказ по праву обязан случиться до расчёта').toBe(before);
  });
});
