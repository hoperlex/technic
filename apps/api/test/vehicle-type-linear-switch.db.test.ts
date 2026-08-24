import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeReadModes, inLegacy, useReadModeDatabase } from './assignment-read-mode';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Переключение признака «Линейная техника» под работающими заказами (миграция 0137) — на живой
 * схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Всё поведение здесь решает состояние соседних таблиц, а не схема запроса: кого
 * морозить, совпал ли отпечаток подтверждения, что увидит гараж после переключения и выпишется ли
 * крайняя неделя ЭСМ-2 при закрытии. Проверить это на правилах невозможно — расходятся ровно код и
 * база.
 *
 * Соседний файл `vehicle-type-linear.db.test.ts` держит **прежний** договор признака: заведение,
 * правку и журнал. После хотфикса `PATCH` признак не меняет вовсе, и та проверка переписана там же.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_linear_hotfix_test \
 *     pnpm --filter @technic/api test vehicle-type-linear-switch
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

/*
 * ЭСМ2-РАЗРЕЗ. Файл заводит свою базу механикой двух режимов: режим чтения живёт в управляющей строке, одной на базу.
 */
const readMode = useReadModeDatabase('linsw');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const ADMIN_EMAIL = 'db-linear-switch-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Код заведённых здесь типов: по нему же идёт уборка, поэтому префикс свой, не общий с соседями. */
const CODE_PREFIX = 'linear_switch_test_';
/** Метка заведённого водителя — ею он и убирается: база у db-тестов общая. */
const PERSON_MARK = 'linear-switch-test';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  kindId: string;
  objectId: string;
  /** Своя машина под назначение: занятость проверяется именно на ней. */
  vehicleId: string;
  vehicleNumber: string;
  /** Машина дня линейного заказа — та, что поедет, не будучи назначенной (ADR 0100 §4). */
  dayVehicleId: string;
  driverId: string;
  today: string;
  /** Конец срока заказов: сегодня плюс три дня — сегодняшний день и спрашивают срезы. */
  dateTo: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
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

async function seedAdmin(): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Свой код на каждый заведённый тип: справочник общий, а прогонов у теста много. */
let typeNo = 0;
function nextCode(): string {
  typeNo += 1;
  return `${CODE_PREFIX}${Date.now()}_${typeNo}`;
}

async function createType(over: Record<string, unknown> = {}): Promise<{
  id: string;
  isLinear: boolean;
  frozenRequests: number;
}> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: { kindId: ctx.kindId, code: nextCode(), name: 'Тип для переключения', ...over },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function preview(id: string, isLinear: boolean): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-types/${id}/linear-switch-preview?isLinear=${isLinear}`,
    headers: ctx.auth,
  });
}

function switchLinear(
  id: string,
  payload: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-types/${id}/linear`,
    headers: ctx.auth,
    payload,
  });
}

/**
 * Заказ этого типа в нужном статусе — строкой, а не формой: форма заводит только «Новую», а
 * половине проверок нужна именно заявка в работе, уже с назначенной машиной или без неё.
 */
async function request(
  typeId: string,
  status: 'new' | 'confirmed' | 'done' | 'cancelled',
  options: { deleted?: boolean; freight?: boolean } = {},
): Promise<{ id: string; num: number }> {
  const res = await ctx.db.execute<{ id: string; num: number }>(sql`
    INSERT INTO vehicle_requests (object_id, request_type, vehicle_type_id, status, created_by, deleted_at)
    VALUES (${ctx.objectId}, ${options.freight ? 'freight_transport' : 'special_equipment'},
            ${typeId}, ${status}, ${ctx.adminId}, ${options.deleted ? sql`now()` : sql`NULL`})
    RETURNING id, num`);
  const row = res.rows[0]!;
  if (options.freight) {
    // У грузоперевозки свои детали и своя обязательная подача: без строки деталей заявка не
    // читается ни списком, ни DTO.
    await ctx.db.execute(sql`
      INSERT INTO freight_transport_request_details (request_id, scheduled_at)
      VALUES (${row.id}, now())`);
  } else {
    await ctx.db.execute(sql`
      INSERT INTO special_equipment_request_details (request_id, date_from)
      VALUES (${row.id}, current_date)`);
  }
  return row;
}

/** Снимок режима у заявки: `null` — заморозки нет, и заявка читает справочник живым. */
async function frozenOf(
  requestId: string,
): Promise<{ isLinear: boolean | null; at: string | null }> {
  const res = await ctx.db.execute<{
    is_linear_frozen: boolean | null;
    linear_frozen_at: string | null;
  }>(sql`SELECT is_linear_frozen, linear_frozen_at FROM vehicle_requests WHERE id = ${requestId}`);
  const row = res.rows[0]!;
  return { isLinear: row.is_linear_frozen, at: row.linear_frozen_at };
}

/**
 * Водитель заказа: человек со специализацией «водитель». Удостоверения не заводим — назначение
 * спрашивает ровно «человек есть и он водитель» (ADR 0064), а листов рейса тест не печатает.
 */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.comment} = ${PERSON_MARK}`);
  if (existing) return existing.id;

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');

  const [person] = await db
    .insert(schema.persons)
    .values({
      lastName: 'Переключаев',
      firstName: 'Тест',
      middleName: 'Линейный',
      comment: PERSON_MARK,
      /*
       * СНИЛС обязателен не этому тесту, а соседнему: круговой обмен справочника водителей
       * выгружает всех людей и загружает выгруженное обратно, и человек без ключевой колонки
       * роняет его чужой строкой. Заведённый тестом водитель обязан быть таким же полноценным,
       * как настоящий, — иначе он ломает не себя, а того, кто окажется рядом в прогоне.
       */
      snils: '11223344595',
    })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
  });
  return person!.id;
}

/** Виза руководителя: без неё заявку в работу не берут (ADR 0025). */
async function approve(request: { id: string; version: number }): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

interface WorkingRequest {
  id: string;
  num: number;
  version: number;
}

/**
 * Заказ техники на объект, доведённый до работы настоящими ручками, — в отличие от `request()`,
 * который кладёт строку напрямую. Здесь это принципиально: заморозка снимается транзакцией смены
 * статуса, и проверять её на заявке, никогда через эту транзакцию не проходившей, нечестно.
 */
/*
 * ЭСМ2-РАЗРЕЗ. Заказ переводится в работу в сегодняшнем мире (`inLegacy`): в `history` статусная
 * ручка упирается в бэкстоп (Р22), а предмет файла — заморозка работающих заказов при переключении
 * линейности, не она.
 */
async function requestInProgress(typeId: string): Promise<WorkingRequest> {
  return inLegacy(readMode, () => requestInProgressNow(typeId));
}

async function requestInProgressNow(typeId: string): Promise<WorkingRequest> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.today,
      dateTo: ctx.dateTo,
      responsibleName: 'Прорабов Пётр Петрович',
      responsiblePhone: '+7 900 000-00-01',
      comment: 'Работы по переключению режима',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: 1000,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo: ctx.dateTo },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return {
    id: request.id as string,
    num: request.num as number,
    version: confirmed.json().version as number,
  };
}

/** Закрыть заявку фактом — им и заканчивается работа (ADR 0029). */
async function closeRequest(id: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'done',
      comment: '',
      version: (await readRequest(id)).version,
      completion: { workedUnit: 'hours', workedAmount: 8, totalCost: 8000 },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.statusCode;
}

/**
 * Тело отката «Выполнена» → «В работе»: машина и машинист называются заново, как их называет
 * окно назначения. Ровно это тело идёт и в предпросмотр, и в саму смену статуса — иначе отпечаток
 * не сошёлся бы, и это не придирка, а второй его сомножитель.
 */
function rollbackBody(): Record<string, unknown> {
  return {
    status: 'confirmed',
    comment: 'Заявка закрыта по ошибке',
    assignment: {
      vehicleId: ctx.vehicleId,
      pricePerHour: 1000,
      pricePerShift: null,
      shiftHours: null,
      driverPersonId: ctx.driverId,
    },
  };
}

/** Заявка глазами портала: этим же DTO её видит карточка и список. */
async function readRequest(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Сколько действующих недельных ЭСМ-2 выписано по заявке — ими и говорит режим. */
async function esm2Count(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM waybills
    WHERE source_request_id = ${requestId} AND form_code = 'esm2' AND status <> 'cancelled'`);
  return Number(res.rows[0]!.n);
}

/** Строка гаража на сегодня: состояние машины и перечень занятостей одним ответом. */
async function garageRow(): Promise<{ state: string; busy: { requestId?: string }[] }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/vehicles?on=${ctx.today}&pageSize=500&search=${encodeURIComponent(ctx.vehicleNumber)}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const row = res.json().items.find((v: { id: string }) => v.id === ctx.vehicleId);
  expect(row, 'машина не найдена в гараже').toBeTruthy();
  return row;
}

/** Последнее событие журнала по этому типу — им и проверяется, чем правку записали. */
async function lastAudit(
  typeId: string,
): Promise<{ action: string; metadata: Record<string, unknown> }> {
  const res = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
    SELECT action, metadata FROM audit_log
    WHERE entity_type = 'vehicle_type' AND entity_id = ${typeId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1`);
  const row = res.rows[0];
  if (!row) throw new Error('в журнале нет ни одной записи по типу');
  return row;
}

describe.skipIf(!DB_URL)('переключение признака линейности под работающими заказами', () => {
  beforeAll(async () => {
    // Окружение и своя база готовы хуком механики (`useReadModeDatabase`).
    const adminId = await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    /*
     * Машины берутся из справочника, а вид ТС — у них: тип теста обязан быть того же вида, что
     * машина, которой заказ берут в работу (граница замены, ADR 0059). Две свободные на сегодня —
     * назначенная и машина дня; порядок с конца, чтобы не столкнуться с соседними db-тестами,
     * которые берут ту же выборку с начала.
     */
    const vehicles = await db.execute<{ id: string; registration_number: string; kind_id: string }>(
      sql`
        SELECT v.id, v.registration_number, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
          AND v.registration_number IS NOT NULL
          AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
        ORDER BY v.registration_number DESC
        LIMIT 2`,
    );
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const [assigned, dayVehicle] = vehicles.rows;
    const object = objects.rows[0];
    if (!assigned || !dayVehicle) throw new Error('в базе нет двух своих грузовых машин с 4-П');
    if (!object) throw new Error('в базе нет объекта: миграции не применены');
    const kind = { id: assigned.kind_id };
    const driverId = await seedDriver();
    const today = new Date().toISOString().slice(0, 10);
    const dateTo = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      adminId,
      kindId: kind.id,
      objectId: object.id,
      vehicleId: assigned.id,
      vehicleNumber: assigned.registration_number,
      dayVehicleId: dayVehicle.id,
      driverId,
      today,
      dateTo,
    };
  }, 120_000);

  afterAll(async () => {
    // За собой убираем: база у db-тестов общая, и заведённые здесь типы с заказами иначе видны
    // соседним файлам — обмену справочников, отборам списка заявок, срезам. Порядок обратный
    // ссылкам: заказы (детали уходят каскадом), потом сами типы.
    if (ctx?.db) {
      const mine = sql`
        SELECT id FROM vehicle_requests
        WHERE vehicle_type_id IN (SELECT id FROM vehicle_types WHERE code LIKE ${CODE_PREFIX + '%'})`;
      // Бумага держит заявку внешним ключом, и это правильно: журнал бланков строгой отчётности
      // обязан помнить, что печаталось. Поэтому сначала уходят листы — недельные ЭСМ-2, выписанные
      // сверкой, и талоны рейсов, — и только потом сами заявки.
      await ctx.db.execute(sql`DELETE FROM waybill_requests WHERE request_id IN (${mine})`);
      await ctx.db.execute(sql`DELETE FROM waybills WHERE source_request_id IN (${mine})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_route_requests WHERE request_id IN (${mine})`);
      // Рейсы, заведённые планированием дня: без заявок они уже ничьи.
      await ctx.db.execute(sql`
        DELETE FROM vehicle_routes
        WHERE id NOT IN (SELECT route_id FROM vehicle_route_requests)
          AND created_by = ${ctx.adminId}`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${mine})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_types WHERE code LIKE ${CODE_PREFIX + '%'}`);
      // Водитель уходит последним: на него ссылались назначения и листы удалённых заявок. Оставить
      // его в справочнике нельзя — соседний тест выгружает водителей и загружает выгруженное
      // обратно, и лишний человек ломает круговой обмен чужой строкой.
      await ctx.db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
    }
    /*
     * Журнал уборка сносит по автору: писали в него только здешние учётки, а видов записей у них
     * несколько — отбор по одному виду сущности оставлял бы остальные. `audit_log` — самая большая
     * таблица общей базы db-тестов, и набирается она как раз такими остатками.
     */
    await ctx?.db.execute(sql`
      DELETE FROM audit_log
       WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  /*
   * Случаи гоняются в обоих режимах чтения; инфраструктура файла (`beforeAll`/`afterAll`) остаётся
   * снаружи — два блока означали бы два `afterAll`, и первый закрыл бы соединение.
   *
   * Сегодня половины совпадают: заморозка считает работающие заказы и их листы, а нарезка бумаги на счёт не влияет. На этапе 5 число листов у заказа может вырасти, и счётчик операции придётся пересчитать.
   */
  describeReadModes(readMode, 'переключение линейности', (mode) => {
    void mode;

  it('переключение морозит работающие заказы и отвечает номерами этой операции', async () => {
    const type = await createType();
    const first = await request(type.id, 'confirmed');
    const second = await request(type.id, 'confirmed');
    // Соседние статусы не морозятся: у «Новой» ничего не начиналось, у закрытой всё случилось.
    const fresh = await request(type.id, 'new');
    const done = await request(type.id, 'done');

    const shown = await preview(type.id, true);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().count).toBe(2);

    const res = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.type.isLinear).toBe(true);
    expect(body.frozenNow).toBe(2);
    expect(body.frozenNums.sort()).toEqual([first.num, second.num].sort());
    expect(body.frozenTotal).toBe(2);

    // Снимок хранит ПРЕЖНИЙ режим: заявка дорабатывает так, как её заводили.
    expect((await frozenOf(first.id)).isLinear).toBe(false);
    expect((await frozenOf(first.id)).at).not.toBeNull();
    expect((await frozenOf(fresh.id)).isLinear).toBeNull();
    expect((await frozenOf(done.id)).isLinear).toBeNull();

    const entry = await lastAudit(type.id);
    expect(entry.action).toBe('vehicle_type.linear');
    expect(entry.metadata.oldIsLinear).toBe(false);
    expect(entry.metadata.newIsLinear).toBe(true);
    expect(entry.metadata.frozenNow).toBe(2);
  });

  it('без отпечатка при непустом множестве — 422 со счётчиком, а не 400 схемы', async () => {
    const type = await createType();
    await request(type.id, 'confirmed');

    const res = await switchLinear(type.id, { isLinear: true });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('1');

    // Отказ до записи: признак остался прежним, снимков не появилось.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-types/${type.id}`,
      headers: ctx.auth,
    });
    expect(after.json().isLinear).toBe(false);
    expect(after.json().frozenRequests).toBe(0);
  });

  it('разошедшийся отпечаток — 409 с текущим числом, и ни одного снимка', async () => {
    const type = await createType();
    await request(type.id, 'confirmed');
    const shown = await preview(type.id, true);
    expect(shown.statusCode, shown.body).toBe(200);

    // Состав изменился между просмотром и нажатием — ровно тот случай, ради которого отпечаток и
    // заведён: подтверждали одно множество, применилось бы другое.
    const late = await request(type.id, 'confirmed');

    const res = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('2');
    expect((await frozenOf(late.id)).isLinear).toBeNull();

    // Перечитали предпросмотр — переключение проходит.
    const again = await preview(type.id, true);
    const ok = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: again.json().fingerprint,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().frozenNow).toBe(2);
  });

  it('пустое множество: переключение проходит и без отпечатка, и с отпечатком пустоты', async () => {
    const withoutField = await createType();
    const bare = await switchLinear(withoutField.id, { isLinear: true });
    expect(bare.statusCode, bare.body).toBe(200);
    expect(bare.json().frozenNow).toBe(0);

    // `md5('')` — а не NULL: `string_agg` пустого множества даёт NULL, и сравнение отпечатков
    // всегда было бы ложным, то есть переключение типа без заявок стало бы невозможным.
    const withField = await createType();
    const shown = await preview(withField.id, true);
    expect(shown.json().count).toBe(0);
    expect(shown.json().fingerprint).toBe('d41d8cd98f00b204e9800998ecf8427e');
    const ok = await switchLinear(withField.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('повтор после потерянного ответа отвечает 200 и нулём, а не 409', async () => {
    const type = await createType();
    await request(type.id, 'confirmed');
    const shown = await preview(type.id, true);

    const first = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().frozenNow).toBe(1);

    // Клиент не получил ответа и шлёт тот же запрос со СТАРЫМ отпечатком. Множество к этому
    // моменту пусто (всех уже заморозили), и сверка отпечатка ответила бы 409 на успешной
    // операции — поэтому «значение уже такое» проверяется раньше неё.
    const repeat = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json().frozenNow).toBe(0);
    expect(repeat.json().frozenTotal).toBe(1);
  });

  it('PATCH с признаком отвечает 422 про свою ручку, а не 400 схемы', async () => {
    const type = await createType();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-types/${type.id}`,
      headers: ctx.auth,
      payload: { isLinear: true },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).not.toBe('validation_error');

    // Совпадающее значение правкой не является: форма шлёт полный объект, а не изменённые поля.
    const same = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-types/${type.id}`,
      headers: ctx.auth,
      payload: { name: 'Тип с прежним признаком', isLinear: false },
    });
    expect(same.statusCode, same.body).toBe(200);
  });

  it('второе переключение не переписывает режим застигнутым первым', async () => {
    const type = await createType();
    const early = await request(type.id, 'confirmed');

    const firstView = await preview(type.id, true);
    const first = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: firstView.json().fingerprint,
    });
    expect(first.json().frozenNow).toBe(1);

    // Заявка, заведённая уже после переключения, живёт по новому режиму — и морозится второй
    // раз своим значением, а не значением соседки.
    const late = await request(type.id, 'confirmed');
    const secondView = await preview(type.id, false);
    const second = await switchLinear(type.id, {
      isLinear: false,
      fingerprint: secondView.json().fingerprint,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().frozenNow).toBe(1);
    expect(second.json().frozenNums).toEqual([late.num]);
    expect(second.json().frozenTotal).toBe(2);

    expect((await frozenOf(early.id)).isLinear).toBe(false);
    expect((await frozenOf(late.id)).isLinear).toBe(true);
  });

  it('работающая грузоперевозка того же типа не морозится', async () => {
    const type = await createType();
    const freight = await request(type.id, 'confirmed', { freight: true });
    const special = await request(type.id, 'confirmed');

    const shown = await preview(type.id, true);
    expect(shown.json().count).toBe(1);
    expect(shown.json().requests.map((r: { num: number }) => r.num)).toEqual([special.num]);

    const res = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.json().frozenNow).toBe(1);
    // Признак к грузоперевозке не относится вовсе: у неё нет ни листов ЭСМ-2, ни дней работы, и
    // снимок держал бы уборку колонок ради заявки, которой он ничего не говорит.
    expect((await frozenOf(freight.id)).isLinear).toBeNull();
    expect(res.json().frozenTotal).toBe(1);
  });

  it('замороженная заявка ведётся по-старому, а соседняя нового набора — по-новому', async () => {
    const type = await createType();
    const frozen = await requestInProgress(type.id);
    // Перевод в работу выписал неделю ЭСМ-2 сам: заказ пока обычный.
    expect(await esm2Count(frozen.id)).toBeGreaterThan(0);

    const shown = await preview(type.id, true);
    const done = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(done.json().frozenNow).toBe(1);

    // Признак типа уже дневной, а заявка — нет: она читает свой снимок.
    const dto = await readRequest(frozen.id);
    expect(dto.isLinear).toBe(false);
    expect((dto.linearFrozen as { isLinear: boolean }).isLinear).toBe(false);

    // Дней ей не планируют: у обычного заказа их не бывает вовсе.
    const day = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${frozen.id}/days/${ctx.today}/route`,
      headers: ctx.auth,
      payload: { newRoute: { vehicleId: ctx.dayVehicleId, driverPersonId: ctx.driverId } },
    });
    expect(day.statusCode, day.body).toBe(422);

    // А заведённая после переключения — уже линейная: два режима живут в одной таблице рядом.
    const fresh = await requestInProgress(type.id);
    expect((await readRequest(fresh.id)).isLinear).toBe(true);
    expect((await readRequest(fresh.id)).linearFrozen).toBeNull();
    expect(await esm2Count(fresh.id)).toBe(0);
  });

  it('замороженная заявка занимает машину весь срок — и в списке, и состоянием', async () => {
    const type = await createType();
    const frozen = await requestInProgress(type.id);

    const shown = await preview(type.id, true);
    await switchLinear(type.id, { isLinear: true, fingerprint: shown.json().fingerprint });

    /*
     * Самое дорогое из пропущенного (§5.1 плана): у гаража два самостоятельных читателя признака —
     * состояние машины считает сырой `EXISTS`, перечень занятостей отдельный запрос. Забудь любой
     * из них, и замороженный заказ отпустит свою машину: гараж покажет её свободной, и на те же
     * дни лягут два заказа.
     */
    const row = await garageRow();
    expect(row.state).toBe('on_site');
    expect(row.busy.some((b) => b.requestId === frozen.id)).toBe(true);

    // Фильтр по состоянию отвечает так же — он считает тем же выражением.
    const free = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles?on=${ctx.today}&state=free&pageSize=500&search=${encodeURIComponent(ctx.vehicleNumber)}`,
      headers: ctx.auth,
    });
    expect(free.statusCode, free.body).toBe(200);
    expect(free.json().items.some((v: { id: string }) => v.id === ctx.vehicleId)).toBe(false);
  });

  it('закрытие снимает заморозку, и крайняя неделя ЭСМ-2 при этом выписывается', async () => {
    const type = await createType();
    const working = await requestInProgress(type.id);
    const shown = await preview(type.id, true);
    await switchLinear(type.id, { isLinear: true, fingerprint: shown.json().fingerprint });
    const before = await esm2Count(working.id);

    const closed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${working.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'done',
        comment: '',
        version: (await readRequest(working.id)).version,
        completion: { workedUnit: 'hours', workedAmount: 8, totalCost: 8000 },
      },
    });
    expect(closed.statusCode, closed.body).toBe(200);

    /*
     * Порядок Р4: сверка ЭСМ-2 отрабатывает ДО снятия снимка. Сними его раньше — и заявка уехала
     * бы в закрытие уже дневной, а неделя за отработанное так и не выписалась бы.
     */
    expect(await esm2Count(working.id)).toBeGreaterThanOrEqual(before);
    expect((await frozenOf(working.id)).isLinear).toBeNull();
    expect((await frozenOf(working.id)).at).toBeNull();
  });

  it('отмена и возврат в «Новую» снимают заморозку', async () => {
    const type = await createType();
    const cancelled = await requestInProgress(type.id);
    const returned = await requestInProgress(type.id);
    const shown = await preview(type.id, true);
    const res = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.json().frozenNow).toBe(2);

    const cancel = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${cancelled.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'cancelled',
        comment: 'Работы отменены заказчиком',
        version: (await readRequest(cancelled.id)).version,
      },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await frozenOf(cancelled.id)).isLinear).toBeNull();

    // Возврат в «Новую» стирает работу целиком (ADR 0058) — снимок уходит вместе с ней: заявка
    // после него выглядит только что заведённой и работать начнёт заново, по справочнику.
    const back = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${returned.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'new',
        comment: 'Заявка взята в работу по ошибке',
        version: (await readRequest(returned.id)).version,
      },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect((await frozenOf(returned.id)).isLinear).toBeNull();
  });

  it('обратное направление: линейный тип становится обычным, дни замороженной остаются', async () => {
    const type = await createType({ isLinear: true });
    const working = await requestInProgress(type.id);
    // День линейного заказа: он и есть то, что заморозка обязана уберечь.
    const day = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${working.id}/days/${ctx.today}/route`,
      headers: ctx.auth,
      payload: { newRoute: { vehicleId: ctx.dayVehicleId, driverPersonId: ctx.driverId } },
    });
    expect(day.statusCode, day.body).toBe(200);

    const shown = await preview(type.id, false);
    const res = await switchLinear(type.id, {
      isLinear: false,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().frozenNow).toBe(1);

    // Заявка осталась дневной, день на месте, и недельных листов ей не завели поверх дней.
    const dto = await readRequest(working.id);
    expect(dto.isLinear).toBe(true);
    expect((dto.linearFrozen as { isLinear: boolean }).isLinear).toBe(true);
    expect(await esm2Count(working.id)).toBe(0);
    const planned = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${working.id}/days`,
      headers: ctx.auth,
    });
    expect(planned.statusCode, planned.body).toBe(200);
    expect(
      planned.json().items.filter((d: { route: unknown }) => d.route).length,
      planned.body,
    ).toBe(1);
  });

  it('смена заказанного типа снимает заморозку: она была про прежний тип', async () => {
    const type = await createType();
    const other = await createType();
    /*
     * Заказ без назначенной машины — единственный, у кого тип вообще меняется: при назначении
     * смена типа отклоняется, потому что машину выбирали именно под него (ADR 0027). Снятие
     * снимка здесь — страховка на редкий путь, а не рабочий сценарий, и проверяется она ровно на
     * том состоянии, где путь открыт.
     */
    const working = await request(type.id, 'confirmed');
    const shown = await preview(type.id, true);
    await switchLinear(type.id, { isLinear: true, fingerprint: shown.json().fingerprint });
    expect((await frozenOf(working.id)).isLinear).toBe(false);

    const dto = await readRequest(working.id);
    const moved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${working.id}`,
      headers: ctx.auth,
      payload: {
        requestType: 'special_equipment',
        objectId: ctx.objectId,
        vehicleTypeId: other.id,
        dateFrom: ctx.today,
        dateTo: ctx.dateTo,
        responsibleName: 'Прорабов Пётр Петрович',
        responsiblePhone: '+7 900 000-00-01',
        comment: 'Тип уточнён',
        version: dto.version,
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    // Носить на новом типе снимок прежнего заявка не вправе: он отвечал на вопрос про другой тип.
    expect((await frozenOf(working.id)).isLinear).toBeNull();
  });

  it('предпросмотр отката называет режим и последствия — и совпадает с самим откатом', async () => {
    const type = await createType();
    const working = await requestInProgress(type.id);
    await closeRequest(working.id);
    const sheetsAfterClose = await esm2Count(working.id);

    const body = rollbackBody();
    const shown = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${working.id}/status/preview`,
      headers: ctx.auth,
      payload: { ...body, version: (await readRequest(working.id)).version },
    });
    expect(shown.statusCode, shown.body).toBe(200);
    const plan = shown.json();
    expect(plan.mode).toBe('weekly');
    expect(plan.busy).toBe('term');
    expect(plan.fingerprint).toBeTruthy();

    // Предпросмотр ничего не пишет: заявка, её листы и статус — те же, что были.
    expect(await esm2Count(working.id)).toBe(sheetsAfterClose);
    expect((await readRequest(working.id)).status).toBe('done');

    // И обещанное сбывается: сверка после отката делает ровно то, что показал диалог. Прошедшая
    // неделя без листа при этом не выписывается — расчёт «недели срока минус выписанные» обещал бы
    // её, и разошёлся бы с реальностью (§5.4 плана).
    const rolled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${working.id}/status`,
      headers: ctx.auth,
      payload: {
        ...body,
        version: (await readRequest(working.id)).version,
        previewFingerprint: plan.fingerprint,
      },
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect(await esm2Count(working.id)).toBe(sheetsAfterClose + plan.esm2.issue.length);
  });

  it('откат без отпечатка отклоняется, а прочие переходы его не спрашивают', async () => {
    const type = await createType();
    const working = await requestInProgress(type.id);
    await closeRequest(working.id);

    const bare = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${working.id}/status`,
      headers: ctx.auth,
      payload: { ...rollbackBody(), version: (await readRequest(working.id)).version },
    });
    expect(bare.statusCode, bare.body).toBe(422);
    expect((await readRequest(working.id)).status).toBe('done');

    // Перевод в работу и закрытие поля не требуют: советовать по ним нечего, и просить
    // подтверждение там значило бы ломать обычную работу диспетчера.
    const other = await requestInProgress(type.id);
    const closed = await closeRequest(other.id);
    expect(closed).toBe(200);
  });

  it('переключение типа между предпросмотром и откатом ловится отпечатком', async () => {
    const type = await createType();
    const working = await requestInProgress(type.id);
    await closeRequest(working.id);
    const sheets = await esm2Count(working.id);

    const body = rollbackBody();
    const shown = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${working.id}/status/preview`,
      headers: ctx.auth,
      payload: { ...body, version: (await readRequest(working.id)).version },
    });
    expect(shown.statusCode, shown.body).toBe(200);

    /*
     * Закрытая заявка не морозится, и её `version` переключение типа не двигает — то есть версия
     * этой перемены не видит вовсе. А план меняется: заказ, показанный недельным, вернулся бы в
     * работу дневным. Ловит это только отпечаток входов плана.
     */
    const scope = await preview(type.id, true);
    const switched = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: scope.json().fingerprint,
    });
    expect(switched.statusCode, switched.body).toBe(200);

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${working.id}/status`,
      headers: ctx.auth,
      payload: {
        ...body,
        version: (await readRequest(working.id)).version,
        previewFingerprint: shown.json().fingerprint,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    // Ни один лист не родился и не сгорел: отпечаток сверяется до первой записи.
    expect((await readRequest(working.id)).status).toBe('done');
    expect(await esm2Count(working.id)).toBe(sheets);

    // Снятый заново предпросмотр проходит — и показывает уже дневной режим.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${working.id}/status/preview`,
      headers: ctx.auth,
      payload: { ...body, version: (await readRequest(working.id)).version },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().mode).toBe('daily');
    const rolled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${working.id}/status`,
      headers: ctx.auth,
      payload: {
        ...body,
        version: (await readRequest(working.id)).version,
        previewFingerprint: again.json().fingerprint,
      },
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
  });

  it('гонка: вход в работу под блокировкой читает уже переключённый режим', async () => {
    const type = await createType();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-requests',
      headers: ctx.auth,
      payload: {
        requestType: 'special_equipment',
        objectId: ctx.objectId,
        vehicleTypeId: type.id,
        dateFrom: ctx.today,
        dateTo: ctx.dateTo,
        responsibleName: 'Прорабов Пётр Петрович',
        responsiblePhone: '+7 900 000-00-01',
        comment: 'Заявка для гонки',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const request = created.json();
    const version = await approve(request);

    /*
     * Порядок А. Внешнее соединение держит строку типа `FOR UPDATE` — ровно то, что делает
     * переключение, — и переводит признак в дневной, не отпуская блокировку. Перевод в работу
     * идёт параллельно и обязан встать на ней: без парного `FOR SHARE` он прочитал бы прежний
     * режим из `before`-DTO и ушёл бы в работу недельным, хотя признак к моменту записи уже
     * дневной.
     */
    // Своё соединение — в базу механики: файл переведён на свою (ЭСМ2-РАЗРЕЗ), и в исходной
    // `TEST_DATABASE_URL` его таблиц нет.
    const holder = new pg.Client({ connectionString: readMode.url });
    await holder.connect();
    let confirming: ReturnType<typeof ctx.app.inject>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM vehicle_types WHERE id = $1 FOR UPDATE', [type.id]);
      await holder.query('UPDATE vehicle_types SET is_linear = true WHERE id = $1', [type.id]);

      confirming = ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${request.id}/status`,
        headers: ctx.auth,
        payload: {
          status: 'confirmed',
          comment: '',
          version,
          assignment: {
            vehicleId: ctx.vehicleId,
            pricePerHour: 1000,
            pricePerShift: null,
            shiftHours: null,
            driverPersonId: ctx.driverId,
          },
          schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo: ctx.dateTo },
        },
      });

      // Пока блокировка держится, перевод не завершается: это и есть доказательство, что он её
      // ждёт, а не читает признак мимо неё.
      const raced = await Promise.race([
        confirming.then(() => 'ответил'),
        new Promise((resolve) => setTimeout(() => resolve('ждёт'), 700)),
      ]);
      expect(raced).toBe('ждёт');
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }

    const done = await confirming;
    expect(done.statusCode, done.body).toBe(200);
    // Заявка ушла в работу уже по НОВОМУ режиму — значение перечитано под блокировкой.
    const dto = await readRequest(request.id as string);
    expect(dto.isLinear).toBe(true);
    expect(dto.linearFrozen).toBeNull();
    expect(await esm2Count(request.id as string)).toBe(0);
  });

  it('гонка: успевший войти в работу морозится прежним значением', async () => {
    const type = await createType();
    // Порядок Б — обратный: перевод в работу завершился целиком, и переключение застаёт заявку
    // уже работающей. Она обязана попасть в множество заморозки.
    const working = await requestInProgress(type.id);

    const shown = await preview(type.id, true);
    expect(shown.json().count).toBe(1);
    const res = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.json().frozenNums).toEqual([working.num]);
    expect((await frozenOf(working.id)).isLinear).toBe(false);
  });

  it('архивная заявка в работе морозится, но в перечне приходит числом', async () => {
    const type = await createType();
    const visible = await request(type.id, 'confirmed');
    const archived = await request(type.id, 'confirmed', { deleted: true });

    const shown = await preview(type.id, true);
    expect(shown.statusCode, shown.body).toBe(200);
    // Отпечаток и счётчик — по полному множеству, иначе подтверждение защищало бы не то, что
    // записывается. А номера показываются только по тем заявкам, которые человек и так видит.
    expect(shown.json().count).toBe(2);
    expect(shown.json().archivedCount).toBe(1);
    expect(shown.json().requests.map((r: { num: number }) => r.num)).toEqual([visible.num]);

    const res = await switchLinear(type.id, {
      isLinear: true,
      fingerprint: shown.json().fingerprint,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().frozenNow).toBe(2);
    // Мягкое удаление статуса не меняет: восстановление обязано вернуть заявку такой, какой её
    // спрятали, — иначе она вернулась бы в работу в другом режиме и молча.
    expect((await frozenOf(archived.id)).isLinear).toBe(false);
  });
  });
});
