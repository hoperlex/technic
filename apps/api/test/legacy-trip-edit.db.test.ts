import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, updateRequestTripSchema } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Правка заявки, доехавшей бэкфилом (план `docs/route-trips-plan.md`, Р2а; §5.7, §12).
 *
 * Соседний `legacy-compat.db.test.ts` отвечает на вопрос «переживёт ли накопленное миграцию» и
 * заканчивается там, где ездка легла в новую таблицу **как есть**: адрес без метаданных, контакт
 * пустой строкой (на тестовой базе таких 4 строки деталей из 489). Здесь начинается второй, и он
 * дороже: **правится ли такая заявка дальше**. Прожить миграцию и перестать сохраняться — это то же
 * самое, что её не пережить, только заметно не в день выката, а через неделю, когда кто-то откроет
 * прошлогодний заказ уточнить телефон.
 *
 * Почему это вообще вопрос. Сегодня старую заявку правят приёмом «нетронутое поле не отправляется»:
 * адрес и контакты объявлены `.optional()`. Ездки правятся **полным списком** (§7), и у списка
 * такого приёма нет — строка приезжает целиком, со всеми своими значениями. Потребуй жёсткая модель
 * верификацию за сам факт отправки списка — и заявка не сохранилась бы, пока кто-нибудь не выберет
 * ей адрес из справочника и не впишет ответственного, то есть не выдумает данные за прошлое.
 *
 * Отсюда Р2а: **жёсткая модель спрашивается за новое значение, а не за перезапись прежнего**, и
 * договор разделён надвое. Схема (`updateRequestTripSchema`) отпускает строку с `id` немедленно —
 * сравнивать ей не с чем — и целиком применяет модель к строке без `id`. Всё остальное на сервере,
 * у которого под блокировкой лежит сохранённая ездка. Значит и проверять надо обе половины: схема,
 * прошедшая в одиночку, не доказывает ничего, кроме того, что она ничего не проверяет.
 *
 * Что проверяется здесь и чего нет в соседях:
 *
 * - поле за полем, а не строка целиком: нетронутый конец ездки принимается вместе с правленым;
 * - `id`, которого у заявки нет (чужая заявка, мягко удалённая ездка), — отказ, а **не** тихое
 *   заведение новой: под тем же номером в выданном листе едет другой груз (Р13а);
 * - отказ ничего не пишет: версия заявки и значения ездки после 422 те же, что были.
 *
 * Границы формы (длины, точность количества, рабочее окно) и сама форма послаблений живут в
 * `vehicle-requests-contracts.test.ts` — повторять их значило бы получить два ответа на один
 * вопрос. Здесь схема спрашивается ровно об одном: где проходит граница её ответственности.
 *
 * Почему через `app.inject`, а не сервисом. Предмет проверки — сравнение присланного с сохранённым,
 * и «сохранённое» тут не выдумка теста, а строка в живой таблице с её `NOT NULL DEFAULT ''` и
 * `jsonb`. Плюс адресация отказа: путь поля (`trips.0.fromAddress`) — часть договора с формой, в
 * которой ездок бывает шесть, и проверить его можно только на ответе ручки.
 *
 * Заявка старой формы заводится ручкой, а потом приводится к состоянию бэкфила прямым `UPDATE`.
 * Иначе никак: сегодняшний сервер такого уже не принимает — в том и вопрос, — а колонок, из которых
 * это переносила миграция `0136`, после неё не существует вовсе.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_gate2 \
 *     pnpm --filter @technic/api test legacy-trip-edit --no-file-parallelism
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-legacy-trip@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';

/** Адрес из подсказки DaData — единственное, что жёсткая модель принимает на запись (ADR 0006). */
const VERIFIED = { source: 'resolved', fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5' } as const;
const VERIFIED_2 = { source: 'resolved', fiasId: '8dea00e3-9aab-4d8e-887c-ef2aaa546456' } as const;

/** Адреса заявки старше ADR 0006: строки, набранные руками, метаданных нет вовсе. */
const LEGACY_FROM = 'ул. Полевая, 3';
const LEGACY_TO = 'ул. Заводская, 12';

/**
 * Телефон, не сводимый к десяти цифрам: миграция `0095` такие не трогала (ADR 0066 п. 7). Лежит в
 * базе как есть и обязан переживать перезапись — иначе заявку нельзя сохранить из-за номера,
 * который в ней никто не менял.
 */
const LEGACY_PHONE = '8 (495) 123-45-67 доб. 12';

/** Уникальный хвост прогона: код площадки уникален, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Своя площадка для адреса из справочника (ADR 0069). Код с «яя» — не шутка, а требование
 * соседства: половина db-тестов берёт объект выражением `ORDER BY code LIMIT 1`, и запись, ставшая
 * первой, молча увела бы их заявки сюда.
 */
const DIRECTORY_CODE = `яя-legacy-trip-${RUN}`;
const DIRECTORY_ADDRESS = 'г Москва, ул Справочная, д 5';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  /** Площадка, чей адрес правится по ходу: ею проверяется устаревший выбор из справочника. */
  directoryObjectId: string;
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  /** Подача заявок сцены: сегодня в рабочем окне — задним числом сервер их не примет. */
  scheduledAt: string;
  /** Своё время ездки: тот же день заявки (Р18), иначе отказ придёт не оттуда, откуда ждут. */
  tripScheduledAt: string;
}

let ctx: Ctx;

/** Что завёл этот файл: по этому списку он за собой и убирает. */
const createdRequests: string[] = [];

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Учётка администратора: справочники (объекты, типы ТС) приходят миграциями наполнения. */
async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (user) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

// ── Тело запроса: ездка так, как её присылает форма ───────────────────────────────────────────

/** Ездка в теле: только те поля, которые схема принимает (`num` и раскладку назначает сервер). */
type TripPayload = Record<string, unknown>;

/** Ездка нынешней формы: верифицированные адреса, груз и контакты на обоих концах. */
function goodTrip(over: TripPayload = {}): TripPayload {
  return {
    fromLocation: 'г Москва, ул Погрузочная, д 1',
    toLocation: 'г Москва, ул Разгрузочная, д 2',
    fromAddress: VERIFIED,
    toAddress: VERIFIED_2,
    volumeM3: 10,
    fromResponsibleName: 'Иванов Иван',
    fromResponsiblePhone: '9990000001',
    toResponsibleName: 'Петров Пётр',
    toResponsiblePhone: '9990000002',
    ...over,
  };
}

/**
 * Сохранённая ездка обратно в тело — ровно так, как её вернёт форма, ничего не тронув.
 *
 * Служебные поля DTO (`num`, `displayNumber`, `placement`) отбрасываются не для красоты: схема
 * ездки `.strict()`, и номер она не принимает намеренно — его назначает сервер и не переиспользует
 * (Р13а). Отправить их обратно значило бы получить 400 вместо проверяемого случая.
 */
function echoTrip(trip: Record<string, unknown>, over: TripPayload = {}): TripPayload {
  return {
    id: trip.id,
    fromLocation: trip.fromLocation,
    toLocation: trip.toLocation,
    fromAddress: trip.fromAddress,
    toAddress: trip.toAddress,
    volumeM3: trip.volumeM3,
    weightTons: trip.weightTons,
    fromResponsibleName: trip.fromResponsibleName,
    fromResponsiblePhone: trip.fromResponsiblePhone,
    toResponsibleName: trip.toResponsibleName,
    toResponsiblePhone: trip.toResponsiblePhone,
    scheduledAt: trip.scheduledAt,
    comment: trip.comment,
    ...over,
  };
}

// ── Сцена: заявка в состоянии бэкфила ─────────────────────────────────────────────────────────

interface RequestState {
  id: string;
  num: number;
  version: number;
  trips: Record<string, unknown>[];
}

async function createRequest(trips: TripPayload[]): Promise<RequestState> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      vehicleCategoryId: ctx.vehicleCategoryId,
      scheduledAt: ctx.scheduledAt,
      trips,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const dto = res.json() as RequestState;
  createdRequests.push(dto.id);
  return dto;
}

async function readRequest(id: string): Promise<RequestState> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestState;
}

function patchTrips(request: RequestState, trips: TripPayload[], over: TripPayload = {}) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}`,
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      version: request.version,
      trips,
      ...over,
    },
  });
}

/**
 * Заявка в том состоянии, в каком её оставил бэкфил `0136`.
 *
 * Заводится ручкой (иначе не собрать заявку со всеми её связями), а потом единственная ездка
 * приводится прямым `UPDATE` к тому, что миграция принесла как есть: адреса строками без
 * метаданных, контакты пустыми строками. Ручкой этого не сделать — жёсткая модель такого не примет,
 * — а колонок, из которых это переносилось, после `0136` не существует.
 */
async function legacyRequest(over: { phone?: string } = {}): Promise<RequestState> {
  const created = await createRequest([goodTrip()]);
  await ctx.db.execute(sql`
    UPDATE vehicle_request_trips
       SET from_location = ${LEGACY_FROM},
           to_location = ${LEGACY_TO},
           from_address = NULL,
           to_address = NULL,
           from_responsible_name = '',
           from_responsible_phone = ${over.phone ?? ''},
           to_responsible_name = '',
           to_responsible_phone = ''
     WHERE request_id = ${created.id}`);
  return readRequest(created.id);
}

beforeAll(async () => {
  if (!DB_URL) return;
  prepareEnv(DB_URL);
  await migrate(DB_URL);
  await seedAdmin();

  const { buildApp } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  const app = await buildApp();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const auth = { authorization: `Bearer ${login.json().accessToken}` };

  // Грузоперевозку выполняет только грузовой вид ТС; категория берётся, если у типа она есть, —
  // тип с категориями сервер без неё не примет (ADR 0028).
  const types = await db.execute<{ type_id: string; category_id: string | null }>(sql`
    SELECT vt.id AS type_id,
           (SELECT vc.id FROM vehicle_categories vc
             WHERE vc.vehicle_type_id = vt.id AND vc.is_active LIMIT 1) AS category_id
    FROM vehicle_types vt
    JOIN vehicle_kinds vk ON vk.id = vt.kind_id
    WHERE vk.code = 'freight_transport'
    ORDER BY vt.name
    LIMIT 1`);
  const type = types.rows[0];
  if (!type) throw new Error('В базе нет типа ТС грузового вида: миграции наполнения не применены');

  const objects = await db.execute<{ id: string }>(sql`
    SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`);
  const object = objects.rows[0];
  if (!object) throw new Error('В справочнике нет действующей площадки: сцену не собрать');

  // Своя площадка, а не чужая запись наполнения: её адрес тест правит по ходу, и трогать
  // справочник, на который опираются соседние файлы, он не должен.
  const directory = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${DIRECTORY_CODE}, ${`Площадка правки старой заявки ${RUN}`}, ${DIRECTORY_ADDRESS})
    RETURNING id`);

  const today = moscowDateKeyOf(new Date());
  ctx = {
    app,
    db,
    closeDb,
    auth,
    objectId: object.id,
    directoryObjectId: directory.rows[0]!.id,
    vehicleTypeId: type.type_id,
    vehicleCategoryId: type.category_id,
    scheduledAt: `${today}T10:00:00+03:00`,
    tripScheduledAt: `${today}T14:00:00+03:00`,
  };
}, 180_000);

afterAll(async () => {
  // За собой убираем: база у db-тестов общая, и заведённые здесь заявки иначе попадаются на глаза
  // соседним файлам, половина которых берёт «первую попавшуюся» запись. Ездки и детали уходят
  // каскадом, рейсов и листов сцена не заводит вовсе. Учётка остаётся намеренно — на неё ссылается
  // журнал аудита, и следующий прогон переиспользует её.
  if (ctx?.db) {
    if (createdRequests.length > 0) {
      await ctx.db.execute(
        sql`DELETE FROM vehicle_requests WHERE id = ANY(${sql.param(createdRequests)}::uuid[])`,
      );
    }
    // Площадка — после заявок: ссылку на заказчика справочник держит `restrict`.
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${DIRECTORY_CODE}`);
  }
  await ctx?.app.close();
  await ctx?.closeDb();
});

describe.skipIf(!DB_URL)('старая ездка правится, пока её поля не трогают', () => {
  /**
   * ГЛАВНОЕ ЗДЕСЬ. Заявка, у которой адреса без метаданных, а контактов нет вовсе, сохраняется —
   * при том, что ездка приезжает целиком, со всеми этими значениями.
   *
   * Правится то, ради чего такую заявку и открывают: примечание и время подачи ездки. Значения,
   * которых жёсткая модель не пропустила бы, обязаны остаться в базе **нетронутыми** — не
   * подставленным `manual` и не выдуманным ответственным: подстановка сделала бы старую заявку
   * неотличимой от заведённой сегодня, и восстановить, что было, стало бы нечем.
   */
  it('комментарий и время ездки сохраняются, а пустые адрес и контакт остаются пустыми', async () => {
    const request = await legacyRequest();
    const trip = request.trips[0]!;
    expect([trip.fromAddress, trip.toAddress, trip.fromResponsibleName]).toEqual([null, null, '']);

    const res = await patchTrips(request, [
      echoTrip(trip, { comment: 'Звонить с ворот', scheduledAt: ctx.tripScheduledAt }),
    ]);

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips).toHaveLength(1);
    expect({
      comment: after.trips[0]!.comment,
      fromLocation: after.trips[0]!.fromLocation,
      fromAddress: after.trips[0]!.fromAddress,
      toAddress: after.trips[0]!.toAddress,
      fromResponsibleName: after.trips[0]!.fromResponsibleName,
      toResponsiblePhone: after.trips[0]!.toResponsiblePhone,
      // Номер ездки перезапись не двигает: им заявка названа в выданном листе.
      num: after.trips[0]!.num,
    }).toEqual({
      comment: 'Звонить с ворот',
      fromLocation: LEGACY_FROM,
      fromAddress: null,
      toAddress: null,
      fromResponsibleName: '',
      toResponsiblePhone: '',
      num: 1,
    });
  });

  /**
   * Список ездок необязателен, и это не противоречит «полному списку» (§7): приём «нетронутое не
   * отправляется» исчезает **внутри** строки, а само поле остаётся полем. Не будь так, уточнение
   * комментария заявки тащило бы за собой все её ездки — то есть выполняло бы Р2а на каждой правке.
   */
  it('комментарий заявки правится вовсе без списка ездок', async () => {
    const request = await legacyRequest();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}`,
      headers: ctx.auth,
      payload: { requestType: 'freight_transport', version: request.version, comment: 'Уточнено' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips[0]!.fromAddress).toBeNull();
    expect(after.trips[0]!.fromResponsiblePhone).toBe('');
  });

  /**
   * Телефон, не сводимый к десяти цифрам (ADR 0066 п. 7): такие остались от записей старше
   * нормализации, и миграция `0095` их не трогала. Отклони его перезапись — и заявку нельзя было бы
   * сохранить из-за номера, которого в ней никто не менял; а «починить» его молча значило бы
   * потерять единственный способ дозвониться (добавочный).
   */
  it('легаси-телефон переживает перезапись как есть', async () => {
    const request = await legacyRequest({ phone: LEGACY_PHONE });
    expect(request.trips[0]!.fromResponsiblePhone).toBe(LEGACY_PHONE);

    const res = await patchTrips(request, [echoTrip(request.trips[0]!, { comment: 'Уточнено' })]);

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips[0]!.fromResponsiblePhone).toBe(LEGACY_PHONE);
  });
});

describe.skipIf(!DB_URL)('жёсткая модель встаёт на новое значение адреса', () => {
  /**
   * Смена **самой** строки адреса — это новое значение, и оно проходит модель целиком: у нового
   * адреса выбор из подсказок состоялся бы прямо сейчас, откладывать его не на что.
   *
   * Проверяется и то, что отказ ничего не записал. Правка идёт одной транзакцией, в которой версия
   * заявки поднимается **раньше** разбора ездок, — сохранись она при отклонённой ездке, форма
   * получила бы 409 на следующей попытке и человек чинил бы не адрес, а «кто-то изменил заявку».
   */
  it('новая строка адреса без метаданных отклоняется, и ничего не пишется', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, { fromLocation: 'ул. Новая, 7' }),
    ]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.0.fromAddress']).toBeTruthy();
    const after = await readRequest(request.id);
    expect(after.version).toBe(request.version);
    expect(after.trips[0]!.fromLocation).toBe(LEGACY_FROM);
  });

  /**
   * Строка та же, метаданные новые — тоже новое значение: пара сравнивается целиком. Иначе `manual`
   * возвращался бы в базу под видом «адрес не менялся», причём именно тем источником, ради запрета
   * которого ADR 0006 и писался.
   */
  it('пометка адреса ручным вводом отклоняется, хотя строка прежняя', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, { fromAddress: { source: 'manual' } }),
    ]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.0.fromAddress']).toBeTruthy();
  });

  /** Обратная сторона: выбранный из подсказок адрес принимается и ложится в базу с метаданными. */
  it('адрес из подсказок DaData принимается и записывается вместе с метаданными', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, {
        fromLocation: 'г Москва, ул Полевая, д 3',
        fromAddress: VERIFIED,
      }),
    ]);

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips[0]!.fromLocation).toBe('г Москва, ул Полевая, д 3');
    expect(after.trips[0]!.fromAddress).toEqual(VERIFIED);
  });

  /**
   * Правило спрашивается **за поле**, а не за строку: правленый конец ездки проходит модель, а
   * нетронутый едет как был. Это и есть цена вопроса — иначе, чтобы выбрать из справочника адрес
   * разгрузки, пришлось бы выдумать ещё и адрес погрузки за прошлое.
   */
  it('правка одного конца не требует верификации другого', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, {
        toLocation: 'г Москва, ул Заводская, д 12',
        toAddress: VERIFIED_2,
      }),
    ]);

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips[0]!.toAddress).toEqual(VERIFIED_2);
    // Погрузка осталась ровно тем, чем её принёс бэкфил.
    expect(after.trips[0]!.fromLocation).toBe(LEGACY_FROM);
    expect(after.trips[0]!.fromAddress).toBeNull();
  });

  /**
   * То же правило на второй разновидности «непроходимого» адреса — устаревшем выборе из справочника
   * (ADR 0069). Адрес объекта в справочнике правят своей жизнью: переименовали площадку — и выбор,
   * состоявшийся при заведении заявки, перестал сходиться со строкой. Сверять его заново у
   * **нетронутого** адреса значило бы запереть правку телефона за правкой справочника, а чинить
   * пришлось бы данные, к телефону отношения не имеющие.
   *
   * Обе половины сразу: нетронутый устаревший адрес сохраняется, а вот перенабранная строка с той
   * же ссылкой отклоняется — иначе первая половина проходила бы просто оттого, что сверка мертва.
   */
  it('устаревший адрес из справочника не пересверяется, пока его не трогают', async () => {
    const request = await createRequest([
      goodTrip({
        fromLocation: DIRECTORY_ADDRESS,
        fromAddress: { source: 'object', refId: ctx.directoryObjectId },
      }),
    ]);
    // Площадку переименовали, пока заявка лежала: выбор в ней устарел, но сделан был честно.
    await ctx.db.execute(sql`
      UPDATE construction_objects SET address = 'г Москва, ул Переименованная, д 9'
       WHERE id = ${ctx.directoryObjectId}`);

    const untouched = await patchTrips(request, [
      echoTrip(request.trips[0]!, { comment: 'Уточнён проезд' }),
    ]);
    expect(untouched.statusCode, untouched.body).toBe(200);

    const retyped = await patchTrips(await readRequest(request.id), [
      echoTrip(request.trips[0]!, { fromLocation: 'г Москва, ул Переписанная, д 1' }),
    ]);
    expect(retyped.statusCode, retyped.body).toBe(422);
    expect(retyped.json().fields?.['trips.0.fromLocation']).toBeTruthy();
  });
});

describe.skipIf(!DB_URL)('контакт спрашивается за новое значение', () => {
  /**
   * Вписанное в пустое поле значение — новое, и проверяется той же схемой, что при заведении: «123»
   * телефоном не станет оттого, что до него в поле было пусто. Отказ садится на **телефон**, а не
   * на строку целиком: имя рядом осталось пустым и претензий к нему нет — оно не менялось.
   */
  it('телефон, вписанный в пустое поле, обязан быть телефоном', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, { fromResponsiblePhone: '123' }),
    ]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.0.fromResponsiblePhone']).toBeTruthy();
    expect(res.json().fields?.['trips.0.fromResponsibleName']).toBeUndefined();
  });

  /**
   * И наоборот: годное значение в пустом поле принимается. Ездка при этом сохраняется с именем и
   * без телефона — состояние, которого заведение не допускает, — и это прямое следствие Р2а: пустой
   * телефон рядом никто не трогал, а требовать его заодно значило бы вернуться к «модель за факт
   * отправки списка». Дозаполняется такая заявка по частям, по мере того как данные находятся.
   */
  it('имя, вписанное в пустое поле, принимается, а пустой телефон рядом остаётся пустым', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, { fromResponsibleName: 'Сидоров Семён' }),
    ]);

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips[0]!.fromResponsibleName).toBe('Сидоров Семён');
    expect(after.trips[0]!.fromResponsiblePhone).toBe('');
  });

  /**
   * Послабление относится к прошлому, а не к полю: заполненный контакт стереть нельзя. Пустая
   * строка законна как **состояние бэкфила**, а не как то, что принимается на запись, — рейс без
   * контакта на разгрузке заканчивается простоем у закрытых ворот.
   */
  it('заполненный контакт нельзя стереть', async () => {
    const request = await createRequest([goodTrip()]);

    const res = await patchTrips(request, [echoTrip(request.trips[0]!, { toResponsibleName: '' })]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.0.toResponsibleName']).toBeTruthy();
  });
});

describe.skipIf(!DB_URL)('новая ездка старой заявки проходит модель целиком', () => {
  /**
   * Строка **без** `id` — заведение, и послаблений у него нет. Иначе «добавили ездку в старую
   * заявку» стало бы дырой, через которую непроверенный адрес и пустой контакт возвращаются в базу
   * спустя релиз после того, как их оттуда убрали.
   *
   * Отказ приходит от **схемы** (400), а не от сервера: у новой строки сравнивать не с чем, и
   * откладывать проверку не на что. Соседняя строка с `id` при этом в списке есть и проходит как
   * есть — то есть строгость новой не перекидывается на старую, а мягкость старой не спасает новую.
   */
  it('новая ездка без метаданных адреса и с пустым контактом не проходит схему', async () => {
    const request = await legacyRequest();
    const legacy = echoTrip(request.trips[0]!);

    const noAddress = await patchTrips(request, [
      legacy,
      goodTrip({ fromAddress: null, toAddress: null }),
    ]);
    const noContact = await patchTrips(request, [
      legacy,
      goodTrip({ fromResponsibleName: '', fromResponsiblePhone: '' }),
    ]);

    expect(noAddress.statusCode, noAddress.body).toBe(400);
    expect(noContact.statusCode, noContact.body).toBe(400);
    // Путь ошибки называет строку списка: в форме с шестью ездками без номера строки человек ищет
    // её сам, а подсветить её порталу нечем.
    expect(Object.keys(noAddress.json().fields ?? {}).join(' ')).toContain('trips.1');
    expect(Object.keys(noContact.json().fields ?? {}).join(' ')).toContain('trips.1');
    const after = await readRequest(request.id);
    expect(after.trips).toHaveLength(1);
    expect(after.version).toBe(request.version);
  });

  /** Годная новая ездка заводится рядом со старой и получает следующий свободный номер (Р13а). */
  it('новая ездка с верифицированным адресом и контактами заводится рядом со старой', async () => {
    const request = await legacyRequest();

    const res = await patchTrips(request, [echoTrip(request.trips[0]!), goodTrip()]);

    expect(res.statusCode, res.body).toBe(200);
    const after = await readRequest(request.id);
    expect(after.trips.map((t) => t.num)).toEqual([1, 2]);
    // Старая осталась старой: заведение соседки её не «дочинило».
    expect(after.trips[0]!.fromAddress).toBeNull();
    expect(after.trips[1]!.fromAddress).toEqual(VERIFIED);
  });
});

describe.skipIf(!DB_URL)('id, которого у заявки нет', () => {
  /**
   * `id` чужой заявки — отказ, а **не** тихое заведение новой. Разница не формальная: под тем же
   * `id` в другой заявке едет свой груз, и молчаливое заведение подменило бы правку заведением, не
   * сказав об этом ни слова. Форма при этом продолжала бы показывать «ездку», которой человек
   * правил совсем другую заявку.
   */
  it('id ездки чужой заявки — отказ, а не тихое заведение новой', async () => {
    const stranger = await createRequest([goodTrip()]);
    const request = await legacyRequest();

    const res = await patchTrips(request, [
      echoTrip(request.trips[0]!, { id: stranger.trips[0]!.id }),
    ]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.0.id']).toBeTruthy();
    const after = await readRequest(request.id);
    expect(after.trips).toHaveLength(1);
    expect(after.trips[0]!.id).toBe(request.trips[0]!.id);
    expect(after.version).toBe(request.version);
    // Чужая заявка не тронута ни на йоту: отказ не должен ничего у неё переписать.
    const strangerAfter = await readRequest(stranger.id);
    expect(strangerAfter.version).toBe(stranger.version);
    expect(strangerAfter.trips[0]!.fromLocation).toBe(stranger.trips[0]!.fromLocation);
  });

  /**
   * `id` мягко удалённой ездки — тоже отказ (Р13а). Ездка исчезает из списка, но не из базы: на неё
   * может ссылаться выданный лист, и номер за ней остаётся навсегда. Прими сервер такой `id` как
   * «строки нет, заведём новую» — и «ТС-40/2» в старом листе и «ТС-40/2» в новом означали бы
   * разное, то есть журнал бланков строгой отчётности перестал бы отвечать, что именно печаталось.
   */
  it('id мягко удалённой ездки — отказ, а номер за ней остаётся', async () => {
    const request = await createRequest([goodTrip(), goodTrip({ toLocation: 'Полигон Тимохово' })]);
    const dropped = request.trips[1]!;

    // Ездка снимается тем же полным списком: отсутствие строки и есть удаление (Р13а).
    const remove = await patchTrips(request, [echoTrip(request.trips[0]!)]);
    expect(remove.statusCode, remove.body).toBe(200);
    const afterRemove = await readRequest(request.id);
    expect(afterRemove.trips.map((t) => t.num)).toEqual([1]);

    const back = await patchTrips(afterRemove, [
      echoTrip(afterRemove.trips[0]!),
      echoTrip(dropped),
    ]);

    expect(back.statusCode, back.body).toBe(422);
    expect(back.json().fields?.['trips.1.id']).toBeTruthy();
    // Номер снесённой не переиспользуется: новая ездка получает третий, а не второй.
    const added = await patchTrips(afterRemove, [echoTrip(afterRemove.trips[0]!), goodTrip()]);
    expect(added.statusCode, added.body).toBe(200);
    expect((await readRequest(request.id)).trips.map((t) => t.num)).toEqual([1, 3]);
  });

  /**
   * Одна ездка дважды в списке — отказ. Сама по себе такая посылка означала бы, что форма
   * потеряла счёт строкам, а принять её значило бы записать в одну строку два разных значения и
   * оставить, какое пришло последним.
   */
  it('одна и та же ездка дважды в списке — отказ', async () => {
    const request = await legacyRequest();
    const trip = echoTrip(request.trips[0]!);

    const res = await patchTrips(request, [trip, { ...trip, comment: 'Второй раз' }]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.1.id']).toBeTruthy();
  });
});

describe('где проходит граница между схемой и сервером (Р2а)', () => {
  /**
   * Договор схемы, записанный проверкой: строка с `id` выходит из разбора немедленно, строка без
   * `id` проходит жёсткую модель целиком.
   *
   * Эта половина работает и без базы, и проверяется здесь не ради повторения контрактных тестов, а
   * ради второй строки — той, где схема **пропускает** заведомо негодное. Без неё «схема приняла»
   * читалось бы как «значение годное», и серверные проверки выглядели бы перестраховкой.
   */
  it('строка с id принимается как есть, строка без id — только верифицированная', () => {
    const stored = {
      id: '11111111-2222-4333-8444-555555555555',
      fromLocation: LEGACY_FROM,
      toLocation: LEGACY_TO,
      fromAddress: null,
      toAddress: null,
      volumeM3: 5,
      fromResponsibleName: '',
      fromResponsiblePhone: '',
      toResponsibleName: '',
      toResponsiblePhone: '',
    };

    expect(updateRequestTripSchema.safeParse(stored).success).toBe(true);
    const { id: _id, ...asNew } = stored;
    expect(updateRequestTripSchema.safeParse(asNew).success).toBe(false);
  });

  /**
   * Чего схема **не** проверяет и не может: подменённый `id` и смену адреса. Оба вопроса требуют
   * прежнего значения, а в теле запроса его нет — оно есть только у сервера, под блокировкой строки.
   * Тест фиксирует границу, чтобы её не приняли за дыру в схеме и не «починили» ужесточением,
   * которое запрёт правку старых заявок.
   */
  it('чужой id и непроверенный адрес схема пропускает — этим занят сервер', () => {
    const parsed = updateRequestTripSchema.safeParse({
      // uuid чужой заявки от своего ничем не отличается — сравнивать схеме не с чем.
      id: '99999999-8888-4777-8666-555555555555',
      fromLocation: 'ул. Новая, 7',
      toLocation: LEGACY_TO,
      fromAddress: { source: 'manual' },
      toAddress: null,
      fromResponsibleName: '',
      fromResponsiblePhone: '',
      toResponsibleName: '',
      toResponsiblePhone: '',
    });

    expect(parsed.success).toBe(true);
  });
});
