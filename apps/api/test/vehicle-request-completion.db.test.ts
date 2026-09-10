import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ДВЕРЬ ЗАКРЫТИЯ ЗАКАЗА ФАКТИЧЕСКОЙ ДАТОЙ — этап Э9 плана
 * [vehicle-request-actual-end-date-plan.md](../../../docs/vehicle-request-actual-end-date-plan.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ
 *
 * 1. **Условное право `waybills.read` — тремя проверками поимённо** (Р22). Это тот самый тест, на
 *    который ссылается `provenBy` двух строк `ACCESS_MANIFEST`: у вида `effectConditionalPermissions`
 *    страж маршрута получает только базовую половину (`vehicleRequests.status`), а вторая
 *    спрашивается **дверью** — и мест ровно три: предпросмотр, `authorize` боевой команды и
 *    `authorizeRepeat`, куда повтор по ключу приходит мимо `plan` и `authorize`. Перебором прав по
 *    манифесту это правило не проверить: телом запроса ветвь не выражается.
 * 2. **Обычное закрытие фактической датой**: срок сокращается, снимок `ended_on`/`previous_date_to`
 *    ложится парой, статус и факт пишутся одной транзакцией, события повторяют паритет Р24.
 * 3. **Закрытие ровно по `date_to`** — отпечаток обязателен даже там, где пусты все пять измерений
 *    (Р17), и однодневный заказ с пустой `date_to` не роняет CHECK снимка (§4).
 * 4. **Арендодательская ветвь** (Р16): дата не спрашивается, срок и бумага не трогаются, права на
 *    журнал листов не нужно, а присланная дата — 422. Парно: тот же арендованный заказ, закрытый
 *    администратором, идёт обычной ветвью и дату требует.
 * 5. **Границы тела и ветви** (Р28): 400 у структурно невозможного, 422 у вычисляемого.
 * 6. **Смены за границей факта** (Р10): заполненная без подписи снимается по подтверждению,
 *    подписанная — 422, и ни одна строка не тронута.
 * 7. **Линейные дни** (Р27): день внутри факта остаётся в рейсе, день за границей снимается, и
 *    сверка пишет своё событие.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: половина утверждений здесь про **точные** числа
 * («событие ровно одно», «дней в рейсах ровно один»), и чужая строка в тех же таблицах сделала бы
 * их ложными. База заводится с нуля, мигрируется и сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/vehicle-request-completion.db.test.ts --maxWorkers=1
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_e9_door';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const ADMIN_EMAIL = 'db-e9-admin@example.invalid';
const SITE_EMAIL = 'db-e9-site@example.invalid';
const LESSOR_EMAIL = 'db-e9-lessor@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Уникальный хвост прогона: коды справочников уникальны, а тип заводится на каждый случай свой. */
const RUN = Date.now().toString(36);

/** Свежий ключ операции: каждый повторно используемый ключ означал бы «тот же запрос» (Р9). */
let keys = 0;
function uuid(): string {
  return `00000000-0000-4000-8000-${String(++keys).padStart(12, '0')}`;
}

/** Контакт заказа: номер выдуман и своими цифрами ни на кого не похож. */
const SITE = { name: 'Закрытов Пётр Сергеевич', phone: '9007770901' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  /** Штаб с выданным набором «ход заказа»: у него есть `vehicleRequests.status` и нет листов. */
  siteAuth: { authorization: string };
  siteUserId: string;
  /** Набор с одним `waybills.read`: им и включается условное право в третьем случае. */
  paperGrantId: string;
  /** Арендодатель своей машины: его коридор — единственный без фактической даты (Р16). */
  lessorAuth: { authorization: string };
  objectId: string;
  kindId: string;
  vehicleId: string;
  /** Контрагент-арендодатель: его учётка закрывает свой заказ ветвью Р16. */
  lessorCounterpartyId: string;
  driverId: string;
  today: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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
  process.env.RATE_LIMIT_MAX ??= '100000';
}

// ── Сцена ──

interface RequestDto {
  id: string;
  version: number;
  status: string;
}

async function login(email: string): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/** Свой тип ТС на каждый случай: переключение линейности морозит все работающие заказы своего типа. */
async function createType(isLinear: boolean, tag: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: {
      kindId: ctx.kindId,
      code: `e9_${tag}_${RUN}`,
      // С «Яя» — требование соседства: половина db-тестов берёт тип выражением `ORDER BY … LIMIT 1`.
      name: `Яя тестовый тип закрытия (${tag} ${RUN})`,
      isLinear,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/**
 * Арендное предложение своего арендодателя: у аренды нет ни модели, ни номера — есть арендодатель,
 * описание и ставка (CHECK `vehicles_rental_fields_check`). Заводится прямо в базе: справочник
 * аренды ведут другой ручкой, и проходить её ради сцены значило бы проверять чужой модуль.
 */
async function createRentalVehicle(typeId: string): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles (vehicle_type_id, ownership, lessor_id, lessor_type, lessor_is_active,
                          description, price_per_shift, shift_hours, status)
    VALUES (${typeId}, 'rental', ${ctx.lessorCounterpartyId}, 'vehicle_lessor', true,
            ${`ТЕСТ Э9 аренда (${RUN})`}, 12000, 8, 'active')
    RETURNING id`);
  return rows.rows[0]!.id;
}

/**
 * Заказ техники на объект. `dateTo: null` заводит однодневный срок — им проверяется снимок
 * `previous_date_to` у заказа с пустой колонкой окончания.
 */
async function createRequest(
  typeId: string,
  options: { dateFrom?: string; dateTo?: string | null; backdateReason?: string } = {},
): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: options.dateFrom ?? ctx.today,
      dateTo: options.dateTo === undefined ? shiftDateKey(ctx.today, 5) : options.dateTo,
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: 'ТЕСТ Э9: дверь закрытия фактической датой',
      // Заведение задним числом — операция журнала (ADR 0101): причина без ключа не принимается,
      // потому что повтор после обрыва связи сжёг бы второй номер бланка.
      ...(options.backdateReason
        ? { backdateReason: options.backdateReason, operationId: uuid() }
        : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as RequestDto;
}

async function approve(request: RequestDto): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

/** Заказ, доведённый до работы назначенной машиной и названным машинистом. */
async function inWork(
  typeId: string,
  options: {
    dateFrom?: string;
    dateTo?: string | null;
    vehicleId?: string;
    backdateReason?: string;
  } = {},
): Promise<RequestDto> {
  const approved = await approve(await createRequest(typeId, options));
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${approved.id}/status`,
    headers: ctx.auth,
    payload: {
      version: approved.version,
      status: 'confirmed',
      comment: '',
      assignment: {
        vehicleId: options.vehicleId ?? ctx.vehicleId,
        // Ставка задаётся там, где машина арендная: закрытие аренды без суммы отклоняется самим
        // фактом (ADR 0027), и сцена не должна упираться в чужое правило.
        pricePerHour: null,
        pricePerShift: options.vehicleId ? 12000 : null,
        shiftHours: options.vehicleId ? 8 : null,
        driverPersonId: ctx.driverId,
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

/** Заявка, перечитанная целиком: версия после чужой правки нужна почти каждому случаю. */
async function reload(id: string, auth = ctx.auth): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

// ── Двери ──

function preview(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/completion/preview`,
    headers: auth,
    payload,
  });
}

function complete(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/completion`,
    headers: auth,
    payload,
  });
}

/** Тело закрытия: факт, версия и фактическая дата, если её спрашивают. */
function body(
  request: RequestDto,
  endedOn: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: request.version,
    comment: '',
    completion: {
      workedUnit: 'shifts',
      workedAmount: 1,
      ...(endedOn === null ? {} : { endedOn }),
    },
    ...extra,
  };
}

// ── Чтение последствий ──

async function auditOf(
  requestId: string,
  action: string,
): Promise<{ metadata: Record<string, unknown> }[]> {
  const rows = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId} AND action = ${action}
     ORDER BY created_at`);
  return rows.rows.map((row) => ({ metadata: row.metadata }));
}

async function auditActions(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ action: string }>(sql`
    SELECT action FROM audit_log
     WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}
     ORDER BY created_at`);
  return rows.rows.map((row) => row.action);
}

/** Снимок закрытия прямо из таблицы: ответ ручки его повторяет, но CHECK держит именно строка. */
async function completionRow(requestId: string): Promise<{
  ended_on: string | null;
  previous_date_to: string | null;
  worked_amount: string;
} | null> {
  const rows = await ctx.db.execute<{
    ended_on: string | null;
    previous_date_to: string | null;
    worked_amount: string;
  }>(sql`SELECT ended_on, previous_date_to, worked_amount
           FROM vehicle_request_completions WHERE request_id = ${requestId}`);
  return rows.rows[0] ?? null;
}

async function termOf(requestId: string): Promise<{ date_from: string; date_to: string | null }> {
  const rows = await ctx.db.execute<{ date_from: string; date_to: string | null }>(sql`
    SELECT date_from, date_to FROM special_equipment_request_details WHERE request_id = ${requestId}`);
  return rows.rows[0]!;
}

async function statusOf(requestId: string): Promise<string> {
  const rows = await ctx.db.execute<{ status: string }>(
    sql`SELECT status FROM vehicle_requests WHERE id = ${requestId}`,
  );
  return rows.rows[0]!.status;
}

async function shiftDates(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ shift_date: string }>(sql`
    SELECT shift_date FROM vehicle_request_shifts WHERE request_id = ${requestId}
     ORDER BY shift_date`);
  return rows.rows.map((row) => row.shift_date);
}

async function daysInRoutes(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ work_date: string }>(sql`
    SELECT work_date FROM vehicle_route_requests
     WHERE request_id = ${requestId} AND work_date IS NOT NULL
     ORDER BY work_date`);
  return rows.rows.map((row) => row.work_date);
}

async function pendingEarlyEnds(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM vehicle_request_early_endings
     WHERE request_id = ${requestId} AND status = 'pending'`);
  return Number(rows.rows[0]!.n);
}

// ── Действия сцены ──

/** «24.07.2026» — так перечень дат печатает общий оформитель событий (`shiftsPendingChange`). */
function dateRu(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** Снимок режима у заявки: `null` — заморозки нет, и заявка читает справочник живым. */
async function frozenOf(
  requestId: string,
): Promise<{ isLinear: boolean | null; at: string | null }> {
  const rows = await ctx.db.execute<{
    is_linear_frozen: boolean | null;
    linear_frozen_at: string | null;
  }>(sql`SELECT is_linear_frozen, linear_frozen_at FROM vehicle_requests WHERE id = ${requestId}`);
  const row = rows.rows[0]!;
  return { isLinear: row.is_linear_frozen, at: row.linear_frozen_at };
}

/** Сколько действующих листов ЭСМ-2 у заказа: им и меряется, каким режимом посчитана бумага. */
async function esm2Count(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM waybills
     WHERE source_request_id = ${requestId} AND form_code = 'esm2' AND status <> 'cancelled'`);
  return Number(rows.rows[0]!.n);
}

/** Переключение линейности типа: с предпросмотром и его отпечатком, как это делает человек. */
async function switchLinear(typeId: string, isLinear: boolean): Promise<void> {
  const shown = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-types/${typeId}/linear-switch-preview?isLinear=${isLinear}`,
    headers: ctx.auth,
  });
  expect(shown.statusCode, shown.body).toBe(200);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-types/${typeId}/linear`,
    headers: ctx.auth,
    payload: { isLinear, fingerprint: shown.json().fingerprint },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Поставить день линейного заказа в свежий рейс своей машины. */
async function planDay(requestId: string, date: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload: { newRoute: { vehicleId: ctx.vehicleId, driverPersonId: ctx.driverId } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Заполнить смену дня; `approve` ставит и подпись объекта. */
async function fillShift(requestId: string, date: string, approved = false): Promise<void> {
  const filled = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/vehicle-requests/${requestId}/shifts/${date}`,
    headers: ctx.auth,
    payload: { startedAt: '08:00', endedAt: '17:00', machineHours: 8, refuel: '', comment: '' },
  });
  expect(filled.statusCode, filled.body).toBe(200);
  if (!approved) return;
  const signed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/shifts/${date}/approval`,
    headers: ctx.auth,
    payload: { approved: true },
  });
  expect(signed.statusCode, signed.body).toBe(200);
}

/** Попросить досрочное завершение и оставить запрос ждать визы. */
async function askEarlyEnd(request: RequestDto, newDateTo: string): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/early-end`,
    headers: ctx.auth,
    payload: { newDateTo, reason: 'ТЕСТ Э9: работы кончились раньше', version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

/** Выдать учётке набор прав; отзыв — удалением строки назначения. */
async function grantTo(userId: string, grantId: string): Promise<void> {
  await ctx.db.execute(
    sql`INSERT INTO user_grants (user_id, grant_id) VALUES (${userId}, ${grantId})`,
  );
}

async function revokeFrom(userId: string, grantId: string): Promise<void> {
  await ctx.db.execute(
    sql`DELETE FROM user_grants WHERE user_id = ${userId} AND grant_id = ${grantId}`,
  );
}

describe.skipIf(!DB_URL)('дверь закрытия заказа фактической датой (Э9)', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе, — их
     * ставим до журнала миграций, а не надеемся на образ. Справочники (площадки, парк, серии
     * бланков) приезжают теми же миграциями: сцене есть на чём стоять сразу.
     */
    const adminClient = new pg.Client({ connectionString: ADMIN_DB });
    await adminClient.connect();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
      await adminClient.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await adminClient.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await client.query('CREATE EXTENSION IF NOT EXISTS unaccent');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');

    const passwordHash = await hashPassword(PASSWORD);
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash,
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [specialization] = await db
      .select({ id: schema.specializations.id })
      .from(schema.specializations)
      .where(sql`${schema.specializations.code} = 'driver'`);
    if (!specialization) throw new Error('в справочнике нет специализации «водитель»');
    const [person] = await db
      .insert(schema.persons)
      .values({
        lastName: 'Закрытов',
        firstName: 'Тест',
        middleName: 'Машинистович',
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: дверь закрытия фактической датой',
      })
      .returning({ id: schema.persons.id });
    await db.insert(schema.personSpecializations).values({
      personId: person!.id,
      specializationId: specialization.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id LIMIT 1`,
    );
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vk.code = 'special_equipment'
       ORDER BY v.registration_number
       LIMIT 1`);
    const object = objects.rows[0];
    const vehicle = vehicles.rows[0];
    if (!object || !vehicle) {
      throw new Error('в базе нет площадки или своей спецтехники: миграции не применены');
    }

    /*
     * Арендодатель. Его машина заводится не здесь, а в самих случаях: у арендного предложения свой
     * тип, а тип у каждого случая свой (переключение линейности морозит все заказы своего типа).
     * Сцене нужен заказ, у которого арендодатель назначенной машины совпадает с контрагентом
     * учётки, — иначе ветвь Р16 недостижима, а именно её и проверяют два случая ниже.
     */
    const [counterparty] = await db
      .insert(schema.counterparties)
      .values({
        name: `ТЕСТ Э9 Арендодатель (${RUN})`,
        type: 'vehicle_lessor',
        // ИНН обязателен и уникален: берём десять цифр текущего времени — на живого контрагента
        // такой номер не похож, а формат CHECK устраивает.
        inn: String(Date.now()).slice(-10),
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: арендодательская ветвь закрытия',
      })
      .returning({ id: schema.counterparties.id });
    await db.insert(schema.users).values({
      email: LESSOR_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Арендодатель',
      middleName: '',
      passwordHash,
      // Роль у внешнего исполнителя одна на все модули (`operator`), а модуль ему выбирает **тип
      // контрагента** (ADR 0038): арендодателем эту учётку делает `counterparty_id`, а не роль.
      role: 'operator',
      counterpartyId: counterparty!.id,
      isActive: true,
    });

    /*
     * Штаб с назначаемыми наборами (ADR 0106) — субъект трёх проверок условного права. Роль сама по
     * себе `vehicleRequests.status` не имеет, а `waybills.read` не имеет и с набором: право на
     * журнал листов выдаётся **вторым** набором, и именно он отзывается в третьем случае.
     */
    const [siteUser] = await db
      .insert(schema.users)
      .values({
        email: SITE_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Штаб',
        middleName: '',
        passwordHash,
        role: 'shtab',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    await db.insert(schema.userConstructionObjects).values({
      userId: siteUser!.id,
      constructionObjectId: object.id,
    });
    const [statusGrant] = await db
      .insert(schema.grants)
      .values({ code: `e9_status_${RUN}`, name: `ТЕСТ Э9: ход заказа (${RUN})` })
      .returning({ id: schema.grants.id });
    await db.insert(schema.grantPermissions).values([
      { grantId: statusGrant!.id, permission: 'vehicleRequests.read' },
      { grantId: statusGrant!.id, permission: 'vehicleRequests.status' },
      // Право коррекции нужно третьему случаю: повтор по ключу бывает только у операции журнала, а
      // операцию заводит закрытие задним числом.
      { grantId: statusGrant!.id, permission: 'waybills.correct' },
    ]);
    await db.insert(schema.grantRoles).values({ grantId: statusGrant!.id, role: 'shtab' });
    const [paperGrant] = await db
      .insert(schema.grants)
      .values({ code: `e9_paper_${RUN}`, name: `ТЕСТ Э9: журнал листов (${RUN})` })
      .returning({ id: schema.grants.id });
    await db
      .insert(schema.grantPermissions)
      .values([{ grantId: paperGrant!.id, permission: 'waybills.read' }]);
    await db.insert(schema.grantRoles).values({ grantId: paperGrant!.id, role: 'shtab' });
    await db.insert(schema.userGrants).values({ userId: siteUser!.id, grantId: statusGrant!.id });

    const app = await buildApp();
    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: '' },
      siteAuth: { authorization: '' },
      siteUserId: siteUser!.id,
      paperGrantId: paperGrant!.id,
      lessorAuth: { authorization: '' },
      objectId: object.id,
      kindId: vehicle.kind_id,
      vehicleId: vehicle.id,
      lessorCounterpartyId: counterparty!.id,
      driverId: person!.id,
      today: moscowDateKeyOf(new Date()),
    };
    void admin;
    ctx.auth = await login(ADMIN_EMAIL);
    ctx.siteAuth = await login(SITE_EMAIL);
    ctx.lessorAuth = await login(LESSOR_EMAIL);
  }, 180_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ── Обычное закрытие ──

  it('закрытие фактической датой сокращает срок и кладёт снимок парой', async () => {
    const request = await inWork(await createType(false, 'plain'));
    const planned = shiftDateKey(ctx.today, 5);

    const shown = await preview(request.id, body(request, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as {
      fingerprint: string;
      completion: { endedOn: string; previousDateTo: string };
      cancelGroups: unknown[];
      cancelGroupsFingerprint: string | null;
      operationRequirement: unknown;
      linearDays: { detachable: unknown[]; frozen: unknown[] };
    };
    // Предпросмотр показывает сам факт: окно спрашивает «чем закрываем», а не только «что сгорит».
    expect(dto.completion).toMatchObject({ endedOn: ctx.today, previousDateTo: planned });
    // Гасить нечего, объяснять нечего: закрытие сегодняшним днём — обычная работа, а не операция.
    expect(dto.cancelGroups).toEqual([]);
    expect(dto.cancelGroupsFingerprint).toBeNull();
    expect(dto.operationRequirement).toBeNull();
    expect(dto.linearDays).toEqual({ detachable: [], frozen: [] });

    // Устаревшая версия — 409, и шаг 3 канона отвечает им до расчёта: закрытие тем и защищено от
    // повторного применения, что версию заявки поднимает единственный шаг 14 (Р25).
    const stale = await complete(request.id, {
      ...body(request, ctx.today, { previewFingerprint: dto.fingerprint }),
      version: request.version - 1,
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const closed = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: dto.fingerprint }),
    );
    expect(closed.statusCode, closed.body).toBe(200);
    const result = closed.json() as {
      version: number;
      repeated: boolean;
      status: string;
      dateTo: string | null;
      endedOn: string | null;
      previousDateTo: string | null;
    };
    expect(result).toMatchObject({
      repeated: false,
      status: 'done',
      dateTo: ctx.today,
      endedOn: ctx.today,
      previousDateTo: planned,
    });
    expect(result.version).toBe(request.version + 1);

    // Срок и снимок — в базе, а не только в ответе: CHECK держит именно строку.
    expect(await termOf(request.id)).toMatchObject({ date_to: ctx.today });
    expect(await completionRow(request.id)).toMatchObject({
      ended_on: ctx.today,
      previous_date_to: planned,
    });
    expect(await statusOf(request.id)).toBe('done');

    // Паритет имён (Р24): факт зовётся `complete`, а не `completion`.
    const actions = await auditActions(request.id);
    expect(actions).toContain('vehicle_request.complete');
    expect(actions).not.toContain('vehicle_request.completion');
    /*
     * Долг подписей — тем же оформителем, что у статусной ручки, и по **фактическому** периоду
     * (Р24): заказ отработал один день, объект за него не расписался, и в истории это обязано
     * остаться. Будущие дни срока в перечень не попадают — их у закрытого заказа больше нет.
     */
    const [factEvent] = await auditOf(request.id, 'vehicle_request.complete');
    const pending = ((factEvent!.metadata.changes ?? []) as { field: string; to: string }[]).filter(
      (change) => change.field === 'shiftsPending',
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.to).toBe(dateRu(ctx.today));
    const status = (await auditOf(request.id, 'vehicle_request.status')).filter(
      (e) => e.metadata.to === 'done',
    );
    expect(status).toHaveLength(1);
    expect(status[0]!.metadata.door).toBe('completion');

    /*
     * Повтор тем же телом — 409: ключа операции у обычного закрытия нет (исход `none`, журнала
     * нет), и единственная защита от повторного применения — версия заявки, поднятая первым
     * вызовом (Р25). Заявка уже закрыта, второго факта не появляется.
     */
    const again = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: dto.fingerprint }),
    );
    expect(again.statusCode, again.body).toBe(409);
  }, 120_000);

  it('закрытие ровно по date_to требует отпечаток и не роняет CHECK у однодневного заказа', async () => {
    /*
     * Все пять измерений пусты: срок не двигается (закрываем единственным днём), бумага не
     * меняется, гасить нечего, часов за границей нет, дней в рейсах нет. Признай каркас такую
     * команду «пустой по построению» — она прошла бы без предпросмотра, хотя человек последствия
     * смотрел и мог смотреть вчерашние (Р17).
     */
    const request = await inWork(await createType(false, 'exact'), { dateTo: null });

    const blind = await complete(request.id, body(request, ctx.today));
    expect(blind.statusCode, blind.body).toBe(409);
    expect(blind.json().code).toBe('assignment_preview_stale');

    const shown = await preview(request.id, body(request, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as { fingerprint: string; plan: { cancel: []; issue: [] } };
    const closed = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: dto.fingerprint }),
    );
    expect(closed.statusCode, closed.body).toBe(200);

    // Пустая `date_to` осталась пустой: срок однодневный, и переписывать его равными краями незачем.
    expect(await termOf(request.id)).toMatchObject({ date_to: null });
    // А снимок написан **эффективным** концом — сырой `null` уронил бы CHECK «оба или ни одного».
    expect(await completionRow(request.id)).toMatchObject({
      ended_on: ctx.today,
      previous_date_to: ctx.today,
    });
  }, 120_000);

  // ── Арендодательская ветвь (Р16) ──

  it('арендодатель закрывает заказ без даты, предпросмотра и права на листы — срок и бумага не трогаются', async () => {
    const typeId = await createType(false, 'lessor');
    const request = await inWork(typeId, { vehicleId: await createRentalVehicle(typeId) });
    const planned = shiftDateKey(ctx.today, 5);
    const asked = await askEarlyEnd(request, shiftDateKey(ctx.today, 2));
    expect(await pendingEarlyEnds(request.id)).toBe(1);

    const mine = await reload(asked.id, ctx.lessorAuth);
    const closed = await complete(
      request.id,
      {
        version: mine.version,
        comment: '',
        completion: { workedUnit: 'shifts', workedAmount: 1, totalCost: 12000 },
      },
      ctx.lessorAuth,
    );
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({
      status: 'done',
      // Срок остался плановым: приводит его к факту сторона заказчика, а не арендодатель.
      dateTo: planned,
      endedOn: null,
      previousDateTo: null,
      esm2: { cancelled: [], issued: [], trimmed: [] },
    });
    expect(await termOf(request.id)).toMatchObject({ date_to: planned });
    expect(await completionRow(request.id)).toMatchObject({
      ended_on: null,
      previous_date_to: null,
    });
    // Спутники заявки ветвь ведёт наравне с прочими: ожидающий визы запрос снят своим событием.
    expect(await pendingEarlyEnds(request.id)).toBe(0);
    const cancelled = await auditOf(request.id, 'vehicle_request.early_end_cancel');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.metadata.reason).toBe('closed');
  }, 120_000);

  it('присланная арендодателем фактическая дата — 422, а тот же заказ у администратора её требует', async () => {
    const typeId = await createType(false, 'lessorpair');
    const request = await inWork(typeId, { vehicleId: await createRentalVehicle(typeId) });
    const mine = await reload(request.id, ctx.lessorAuth);
    const withDate = await complete(
      request.id,
      {
        version: mine.version,
        comment: '',
        completion: { workedUnit: 'shifts', workedAmount: 1, totalCost: 9000, endedOn: ctx.today },
      },
      ctx.lessorAuth,
    );
    expect(withDate.statusCode, withDate.body).toBe(422);
    expect(String(withDate.json().message)).toContain('не спрашивают');
    expect(await statusOf(request.id)).toBe('confirmed');

    /*
     * Парный случай Р16: тот же арендованный заказ, но закрывает его администратор — ветвь обычная,
     * и дату у него спрашивают. Выбери дверь ветвь по принадлежности машины (`ownership`), этот
     * запрос прошёл бы без даты и без предпросмотра.
     */
    const blind = await complete(request.id, {
      version: request.version,
      comment: '',
      completion: { workedUnit: 'shifts', workedAmount: 1, totalCost: 9000 },
    });
    expect(blind.statusCode, blind.body).toBe(422);
    expect(String(blind.json().message)).toContain('фактическую дату');
  }, 120_000);

  // ── Условное право `waybills.read` — три места (Р22) ──

  it('waybills.read спрашивается на предпросмотре и в боевой команде, а без него — 403 и ни одной записи', async () => {
    const request = await inWork(await createType(false, 'paper'));

    const shown = await preview(request.id, body(request, ctx.today), ctx.siteAuth);
    expect(shown.statusCode, shown.body).toBe(403);

    /*
     * Отпечаток для боевого вызова берётся у администратора: он от субъекта не зависит вовсе —
     * хешируются последствия, а не тот, кто их смотрел. Без него отказ пришёл бы **раньше** и
     * другой (409 шага 7 канона стоит перед авторизацией шага 9), и случай доказывал бы не то.
     */
    const asAdmin = await preview(request.id, body(request, ctx.today));
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    const fingerprint = (asAdmin.json() as { fingerprint: string }).fingerprint;
    const applied = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: fingerprint }),
      ctx.siteAuth,
    );
    expect(applied.statusCode, applied.body).toBe(403);
    // Отказ авторизации не оставляет следа: заявка осталась в работе, факта нет.
    expect(await statusOf(request.id)).toBe('confirmed');
    expect(await completionRow(request.id)).toBeNull();

    // С набором, дающим право на журнал листов, тот же субъект проходит обе двери.
    await grantTo(ctx.siteUserId, ctx.paperGrantId);
    const auth = await login(SITE_EMAIL);
    const ok = await preview(request.id, body(request, ctx.today), auth);
    expect(ok.statusCode, ok.body).toBe(200);
    await revokeFrom(ctx.siteUserId, ctx.paperGrantId);
  }, 120_000);

  it('повтор по ключу спрашивает waybills.read сам: отобранное между вызовами право даёт 403', async () => {
    /*
     * Повтор по ключу выходит на шаге 2 канона — до `plan` и до `authorize`, — поэтому право на
     * бумагу у него своя проверка. Ключ операции бывает только у коррекционной ветви, поэтому заказ
     * заводится задним числом и закрывается вчерашним днём: исход `crew`, операция журнала есть.
     */
    await grantTo(ctx.siteUserId, ctx.paperGrantId);
    const auth = await login(SITE_EMAIL);
    const request = await inWork(await createType(false, 'repeat'), {
      dateFrom: shiftDateKey(ctx.today, -3),
      dateTo: shiftDateKey(ctx.today, 2),
      backdateReason: 'ТЕСТ Э9: заявка оформлена позже выхода техники',
    });
    const endedOn = shiftDateKey(ctx.today, -1);

    const shown = await preview(request.id, body(request, endedOn), auth);
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as {
      fingerprint: string;
      unlockFingerprint: string | null;
      cancelGroupsFingerprint: string | null;
      operationRequirement: { kind: string } | null;
    };
    // Закрытие задним числом — операция журнала: причину и ключ спрашивает исход, а не календарь.
    expect(dto.operationRequirement).not.toBeNull();
    const operationId = uuid();
    const payload = body(request, endedOn, {
      previewFingerprint: dto.fingerprint,
      ...(dto.unlockFingerprint ? { unlockFingerprint: dto.unlockFingerprint } : {}),
      ...(dto.cancelGroupsFingerprint
        ? { cancelGroupsFingerprint: dto.cancelGroupsFingerprint }
        : {}),
      operation: { operationId, reason: 'ТЕСТ Э9: закрываем прошедшим днём' },
    });
    const closed = await complete(request.id, payload, auth);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().operationId).toBe(operationId);

    // Тот же ключ ещё раз — честный повтор: работы нет, ответ прежний.
    const repeated = await complete(request.id, payload, auth);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().repeated).toBe(true);

    // А теперь право на журнал листов отобрали. Повтор обязан упереться в 403 — иначе тот, у кого
    // право успели забрать, получал бы прежний результат молча.
    await revokeFrom(ctx.siteUserId, ctx.paperGrantId);
    const without = await login(SITE_EMAIL);
    const denied = await complete(request.id, payload, without);
    expect(denied.statusCode, denied.body).toBe(403);
  }, 120_000);

  // ── Границы тела и ветви (Р28) ──

  it('границы Р28: 400 у структурно невозможного, 422 у вычисляемого ветвью', async () => {
    const request = await inWork(await createType(false, 'limits'));

    // Рукопожатие в теле предпросмотра схема не описывает вовсе — это 400, а не 422.
    const handshaken = await preview(
      request.id,
      body(request, ctx.today, { previewFingerprint: 'x'.repeat(64) }),
    );
    expect(handshaken.statusCode, handshaken.body).toBe(400);

    // Незнакомое поле — тоже 400: тело строгое с обеих сторон.
    const unknown = await complete(request.id, body(request, ctx.today, { endedOnComment: 'нет' }));
    expect(unknown.statusCode, unknown.body).toBe(400);

    // Дата в будущем и дата раньше начала срока — 422 по границам, посчитанным под блокировкой.
    const future = await complete(request.id, body(request, shiftDateKey(ctx.today, 1)));
    expect(future.statusCode, future.body).toBe(422);
    const early = await complete(request.id, body(request, shiftDateKey(ctx.today, -1)));
    expect(early.statusCode, early.body).toBe(422);

    /*
     * Лишние подтверждения — 422 **шага 8**, и добраться до него можно только с верным отпечатком
     * последствий: шаг 7 стоит раньше и отвечает 409 «посмотрите заново». Порядок этот и есть
     * правило Р28 — устаревший предпросмотр не должен объясняться словами «уберите поле».
     */
    const shown = await preview(request.id, body(request, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const fingerprint = (shown.json() as { fingerprint: string }).fingerprint;
    const extraGroups = await complete(
      request.id,
      body(request, ctx.today, {
        previewFingerprint: fingerprint,
        cancelGroupsFingerprint: 'y'.repeat(64),
      }),
    );
    expect(extraGroups.statusCode, extraGroups.body).toBe(422);
    const extraOperation = await complete(
      request.id,
      body(request, ctx.today, {
        previewFingerprint: fingerprint,
        operation: { operationId: uuid(), reason: 'ТЕСТ' },
      }),
    );
    expect(extraOperation.statusCode, extraOperation.body).toBe(422);

    // Ни один из отказов ничего не записал.
    expect(await statusOf(request.id)).toBe('confirmed');
    expect(await completionRow(request.id)).toBeNull();
  }, 120_000);

  // ── Смены за границей факта (Р10) ──

  it('заполненная без подписи смена за границей факта снимается по подтверждению, подписанная — 422', async () => {
    const typeId = await createType(false, 'shifts');
    const dateFrom = shiftDateKey(ctx.today, -3);
    const endedOn = shiftDateKey(ctx.today, -2);
    const filledDay = shiftDateKey(ctx.today, -1);

    const request = await inWork(typeId, {
      dateFrom,
      dateTo: shiftDateKey(ctx.today, 2),
      backdateReason: 'ТЕСТ Э9: заявка оформлена позже выхода техники',
    });
    await fillShift(request.id, filledDay);

    const shown = await preview(request.id, body(request, endedOn));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as {
      fingerprint: string;
      clearedShiftDays: { date: string }[];
      clearedShiftsFingerprint: string | null;
      unlockFingerprint: string | null;
      cancelGroupsFingerprint: string | null;
      operationRequirement: unknown;
    };
    expect(dto.clearedShiftDays.map((d) => d.date)).toEqual([filledDay]);
    expect(dto.clearedShiftsFingerprint).not.toBeNull();

    // Ключ один на все попытки этого случая: повтор по нему и есть проверка идемпотентности.
    const repeatKey = uuid();
    const handshake = (extra: Record<string, unknown> = {}) =>
      body(request, endedOn, {
        previewFingerprint: dto.fingerprint,
        ...(dto.unlockFingerprint ? { unlockFingerprint: dto.unlockFingerprint } : {}),
        ...(dto.cancelGroupsFingerprint
          ? { cancelGroupsFingerprint: dto.cancelGroupsFingerprint }
          : {}),
        ...(dto.operationRequirement
          ? {
              operation: { operationId: repeatKey, reason: 'ТЕСТ Э9: закрываем прошедшим днём' },
            }
          : {}),
        ...extra,
      });

    // Без подтверждения часы не снимаются: 422 и перечень дат.
    const blind = await complete(request.id, handshake());
    expect(blind.statusCode, blind.body).toBe(422);
    expect(await shiftDates(request.id)).toEqual([filledDay]);

    const closed = await complete(
      request.id,
      handshake({ clearedShiftsFingerprint: dto.clearedShiftsFingerprint }),
    );
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().clearedShiftDays).toEqual([filledDay]);
    expect(await shiftDates(request.id)).toEqual([]);

    /*
     * Подписанный день за границей факта — отказ, и отказывает уже предпросмотр: команда терминальна,
     * и человек обязан узнать о невозможности до нажатия, а не после.
     */
    const signed = await inWork(typeId, {
      dateFrom,
      dateTo: shiftDateKey(ctx.today, 2),
      backdateReason: 'ТЕСТ Э9: заявка оформлена позже выхода техники',
    });
    await fillShift(signed.id, filledDay, true);
    const refused = await preview(signed.id, body(signed, endedOn));
    expect(refused.statusCode, refused.body).toBe(422);
    expect(String(refused.json().message)).toContain('подпись объекта');
    const applied = await complete(signed.id, body(signed, endedOn));
    expect(applied.statusCode, applied.body).toBe(422);
    // Ни одна строка не тронута — ни смена, ни статус.
    expect(await shiftDates(signed.id)).toEqual([filledDay]);
    expect(await statusOf(signed.id)).toBe('confirmed');
  }, 180_000);

  // ── Заморозка режима — хвост шага 12 (Р24) ──

  it('заморозка режима снимается последней: бумагу считает режим, в котором работали', async () => {
    /*
     * Сцена та же, какой она зафиксирована у статусной ручки (характеризующий тест Э8), и это
     * ровно паритет: заказ заводится линейным типом (листов ЭСМ-2 у него нет), справочник
     * переключают на недельный — заявка застигнута в работе и морозится **прежним** значением
     * (миграция 0137). С этой минуты снимок и справочник отвечают по-разному: снимок говорит
     * «линейный, бумаги нет», справочник — «недельный, выпиши листы на весь срок».
     *
     * Закрытие обязано посчитать бумагу снимком, а снять его — последним действием. Сними дверь
     * заморозку раньше сверки — крайняя неделя выписалась бы закрываемому заказу, который её
     * никогда не имел.
     */
    const typeId = await createType(true, 'freeze');
    const request = await inWork(typeId);
    expect(await esm2Count(request.id)).toBe(0);

    await switchLinear(typeId, false);
    const frozen = await frozenOf(request.id);
    expect(frozen.isLinear).toBe(true);
    expect(frozen.at).not.toBeNull();

    // Контроль: тот же тип и тот же срок, но уже без снимка — этот заказ бумагу получает.
    const control = await inWork(typeId);
    expect(await frozenOf(control.id)).toEqual({ isLinear: null, at: null });
    expect(await esm2Count(control.id)).toBeGreaterThan(0);

    const fresh = await reload(request.id);
    const shown = await preview(fresh.id, body(fresh, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const closed = await complete(
      fresh.id,
      body(fresh, ctx.today, {
        previewFingerprint: (shown.json() as { fingerprint: string }).fingerprint,
      }),
    );
    expect(closed.statusCode, closed.body).toBe(200);

    // Бумага посчитана снимком: недельных листов у линейно отработавшего заказа не появилось.
    expect(await esm2Count(request.id)).toBe(0);
    // А сам снимок снят — той же командой, но после сверок: заявка возвращена справочнику.
    expect(await frozenOf(request.id)).toEqual({ isLinear: null, at: null });
  }, 180_000);

  // ── Линейные дни (Р27) ──

  it('дни внутри факта остаются в рейсах, за границей — снимаются со своим событием', async () => {
    const request = await inWork(await createType(true, 'linear'), {
      dateTo: shiftDateKey(ctx.today, 3),
    });
    const worked = ctx.today;
    const beyond = shiftDateKey(ctx.today, 2);
    await planDay(request.id, worked);
    await planDay(request.id, beyond);
    expect(await daysInRoutes(request.id)).toEqual([worked, beyond]);

    const shown = await preview(request.id, body(request, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as {
      fingerprint: string;
      linearDays: { detachable: { date: string }[]; frozen: unknown[] };
    };
    // Предпросмотр показывает ровно те дни, которые уйдут: пятое измерение отпечатка обязано быть
    // видимым, иначе человек подтверждает изменение чужих рейсов, которого не видел.
    expect(dto.linearDays.detachable.map((d) => d.date)).toEqual([beyond]);
    expect(dto.linearDays.frozen).toEqual([]);

    const closed = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: dto.fingerprint }),
    );
    expect(closed.statusCode, closed.body).toBe(200);

    // Отработанный день остался в рейсе — это и есть отменённое поведение статусной ручки (Р27).
    expect(await daysInRoutes(request.id)).toEqual([worked]);
    const sync = await auditOf(request.id, 'vehicle_request.days_sync');
    expect(sync).toHaveLength(1);
    expect(sync[0]!.metadata.reason).toBe('status:done');
    expect(sync[0]!.metadata.detached).toHaveLength(1);
    expect(String((sync[0]!.metadata.detached as string[])[0])).toContain(beyond);
  }, 120_000);

  // ── Комментарий закрытия (Р24) ──

  /**
   * История статуса заявки. Комментарий перехода живёт здесь и только здесь: карточка читает его
   * этой таблицей, а `cancelReason` собирается тем же запросом у отменённых.
   */
  async function statusHistory(
    requestId: string,
  ): Promise<{ from_status: string; to_status: string; comment: string }[]> {
    const rows = await ctx.db.execute<{ from_status: string; to_status: string; comment: string }>(
      sql`SELECT from_status, to_status, comment
            FROM vehicle_request_status_history
           WHERE vehicle_request_id = ${requestId}
           ORDER BY changed_at`,
    );
    return rows.rows;
  }

  it('комментарий закрытия сохранён там же, где его пишет статусная ручка — в истории статуса', async () => {
    /*
     * Паритет Р24 перечисляет имена событий и порядок шагов, но `comment` в перечень не попал — а
     * он в контракте двери есть (§4: «`comment` есть в **обеих** ветвях, сегодня его шлёт портал
     * тем же полем»). Поле, которое схема принимает, а дверь молча теряет, — самый тихий вид
     * потери паритета: ответ успешен, заявка закрыта, и заметит пропажу только тот, кто через
     * месяц спросит карточку «почему заказ закрыли средой».
     *
     * Поэтому случай проверяет **оба** места, куда комментарий кладёт старая ручка: строку
     * `vehicle_request_status_history` (её читает карточка и из неё же собирается причина отмены) и
     * метаданные закрывающего события ленты. Одного мало: событие и строка пишутся разными шагами
     * канона — шагом 11 и шагом 13, — и потерять комментарий можно в любом из них по отдельности.
     */
    const request = await inWork(await createType(false, 'comment'));
    const said = 'ТЕСТ Э12: техника ушла с объекта в среду, объект подтвердил по телефону';

    const shown = await preview(request.id, { ...body(request, ctx.today), comment: said });
    expect(shown.statusCode, shown.body).toBe(200);
    const closed = await complete(request.id, {
      ...body(request, ctx.today, {
        previewFingerprint: (shown.json() as { fingerprint: string }).fingerprint,
      }),
      comment: said,
    });
    expect(closed.statusCode, closed.body).toBe(200);

    /*
     * Закрывающая запись ровно одна, и берётся она по `to_status`, а не «последней»: у заявки к
     * этому моменту уже три перехода, и «последняя строка» ответила бы верно случайно.
     */
    const closing = (await statusHistory(request.id)).filter((row) => row.to_status === 'done');
    expect(closing, 'закрывающая запись истории статуса ровно одна').toHaveLength(1);
    expect(closing[0]!).toMatchObject({ from_status: 'confirmed', comment: said });

    // Перевод в работу своей строки не лишился и чужого комментария не получил: комментарий
    // принадлежит переходу, а не заявке.
    const toWork = (await statusHistory(request.id)).filter((row) => row.to_status === 'confirmed');
    expect(toWork).toHaveLength(1);
    expect(toWork[0]!.comment).toBe('');

    const [event] = (await auditOf(request.id, 'vehicle_request.status')).filter(
      (e) => e.metadata.to === 'done',
    );
    expect(event!.metadata.comment).toBe(said);
  }, 120_000);

  // ── Гашение групп истории (Р18) и необратимость сокращения (Р14) ──

  /** Госномера выдуманные и своими цифрами ни на кого не похожи; счётчик держит их разными. */
  let plates = 0;

  /**
   * Вторая своя машина того же типа: ею решение «с этого дня работает другая машина» и отличается
   * от решения «с этого дня работает другой машинист», а тип у каждого случая свой.
   *
   * Прежде тут стояло «гасимая группа обязана нести **vehicle**-строку — по ней и только по ней
   * `cancelGroupsOf` собирает группы». Это больше не так: группы собираются по строке **любой**
   * шкалы за новым концом срока, и соседний случай про одну лишь смену машиниста держит как раз
   * это.
   */
  async function createOwnVehicle(typeId: string): Promise<string> {
    const plate = `Х${String(900 + ++plates)}ХХ199`;
    const rows = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicles (vehicle_type_id, ownership, registration_number, status)
      VALUES (${typeId}, 'own', ${plate}, 'active')
      RETURNING id`);
    return rows.rows[0]!.id;
  }

  /** Второй машинист: вместе с машиной группа уводит и назначенного на неё человека (В2). */
  async function createDriver(tag: string): Promise<string> {
    const rows = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, middle_name, comment)
      VALUES ('Сменов', ${tag}, 'Машинистович', 'ТЕСТОВЫЕ ДАННЫЕ: дверь закрытия фактической датой')
      RETURNING id`);
    return rows.rows[0]!.id;
  }

  /**
   * История назначения заявки: стартовая группа и решение «с этого дня работает другая машина».
   *
   * Пишется прямой записью строк, и это осознанный приём, а не срез угла. Vehicle-изменение внутри
   * срока сегодня заводят только двери коррекции и ремонта — каждая со своим телом, своими правами
   * и своей операцией журнала, — и проходить любую из них ради **входа** значило бы проверять
   * чужой модуль в файле про закрытие. Тем же приёмом и по той же причине сцену собирает
   * `assignment-period.db.test.ts`: гашение групп предметно одно и то же у двери срока и у двери
   * закрытия (Р18), и вход у обоих файлов обязан быть одинаково дешёвым.
   *
   * Обе строки группы — одним `change_group_id`: гашение групповое (В2), и группа, собранная из
   * двух разных идентификаторов, не проверяла бы ничего.
   */
  async function splitHistory(
    requestId: string,
    params: { startOn: string; splitOn: string; vehicleId: string; driverPersonId: string },
  ): Promise<void> {
    const start = uuid();
    const split = uuid();
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES
        (${requestId}, ${params.startOn}, 'vehicle', ${ctx.vehicleId}, NULL, NULL, 'assignment',
         ${start}),
        (${requestId}, ${params.startOn}, 'driver', NULL, ${ctx.driverId}, 'set', 'assignment',
         ${start}),
        (${requestId}, ${params.splitOn}, 'vehicle', ${params.vehicleId}, NULL, NULL,
         'reassignment', ${split}),
        (${requestId}, ${params.splitOn}, 'driver', NULL, ${params.driverPersonId}, 'set',
         'reassignment', ${split})`);
  }

  /**
   * Та же история, но решение хвоста — **одна смена машиниста**: машина у заказа всю дорогу одна.
   *
   * Отдельная функция, а не флаг у `splitHistory`: разница между сценами ровно в одной строке
   * группы, и читаться она должна глазами, а не через ветвление входа.
   */
  async function driverSwapHistory(
    requestId: string,
    params: { startOn: string; splitOn: string; driverPersonId: string },
  ): Promise<void> {
    const start = uuid();
    const split = uuid();
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES
        (${requestId}, ${params.startOn}, 'vehicle', ${ctx.vehicleId}, NULL, NULL, 'assignment',
         ${start}),
        (${requestId}, ${params.startOn}, 'driver', NULL, ${ctx.driverId}, 'set', 'assignment',
         ${start}),
        (${requestId}, ${params.splitOn}, 'driver', NULL, ${params.driverPersonId}, 'set',
         'reassignment', ${split})`);
  }

  /** Строки истории с признаком гашения: погашенные лежат рядом с актуальными, а не исчезают. */
  async function changeRows(
    requestId: string,
  ): Promise<{ effective_date: string; dimension: string; superseded_kind: string | null }[]> {
    const rows = await ctx.db.execute<{
      effective_date: string;
      dimension: string;
      superseded_kind: string | null;
    }>(sql`SELECT effective_date, dimension, superseded_kind
             FROM vehicle_request_assignment_changes
            WHERE request_id = ${requestId}
            ORDER BY effective_date, dimension`);
    return rows.rows;
  }

  it('решение истории за фактическим концом гасится по подтверждённому перечню и не оживает после отката с продлением', async () => {
    /*
     * Блокер второго ревью целиком: без гашения смена машины с субботы переживает закрытие средой
     * и **оживает** при первом же продлении после отката — прямо вопреки Р14. Поэтому случай
     * проверяет три вещи подряд, и третья и есть предмет:
     *
     * 1. предпросмотр показывает перечень гасимых групп и его отпечаток (Р18);
     * 2. команда без подтверждения перечня — 422, и не записывает ничего: подтверждение
     *    симметрично лишнему (Р28), и гашение истории человек обязан увидеть до нажатия;
     * 3. после отката «Выполнена» → «В работе» и продления срока обратно **погашенное решение не
     *    возвращается**: откат ничего не восстанавливает (Р14), а продление считает состав по
     *    оставшейся истории.
     *
     * Решение стоит в будущем, поэтому исход команды — обычная работа: прошлого гашение не
     * трогает, коррекционных прав не требует, и `operationRequirement` пуст. Это тот самый рабочий
     * случай, ради которого Р8 писал «закрываем в среду, лист идёт до воскресенья».
     */
    const typeId = await createType(false, 'groups');
    const planned = shiftDateKey(ctx.today, 5);
    const request = await inWork(typeId, { dateTo: planned });
    const splitOn = shiftDateKey(ctx.today, 3);
    await splitHistory(request.id, {
      startOn: ctx.today,
      splitOn,
      vehicleId: await createOwnVehicle(typeId),
      driverPersonId: await createDriver('Второй'),
    });

    const shown = await preview(request.id, body(request, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as {
      fingerprint: string;
      cancelGroups: { rows: { effectiveDate: string; dimension: string }[] }[];
      cancelGroupsFingerprint: string | null;
      operationRequirement: unknown;
    };
    expect(dto.cancelGroups, 'группа за новым концом ровно одна').toHaveLength(1);
    expect(dto.cancelGroups[0]!.rows.map((row) => row.dimension).sort()).toEqual([
      'driver',
      'vehicle',
    ]);
    expect(dto.cancelGroups[0]!.rows.map((row) => row.effectiveDate)).toEqual([splitOn, splitOn]);
    expect(dto.cancelGroupsFingerprint).not.toBeNull();
    /*
     * Гашение решения истории — операция журнала, и это не «заднее число»: решение стоит в
     * будущем, прошлого команда не трогает, а объяснить исчезнувшее решение всё равно обязана
     * (Р12: «исход `assignment_tail` — такая же операция журнала, как `crew`»). Поэтому дверь
     * спрашивает envelope, а не молчит, и повтор по ключу у такого закрытия достижим.
     */
    expect(dto.operationRequirement).toEqual({
      kind: 'assignment_tail',
      reasonRequired: true,
      operationIdRequired: true,
    });
    const envelope = {
      operation: { operationId: uuid(), reason: 'ТЕСТ Э12: заказ закрыт фактической датой' },
    };

    const active = [
      { effective_date: ctx.today, dimension: 'driver', superseded_kind: null },
      { effective_date: ctx.today, dimension: 'vehicle', superseded_kind: null },
      { effective_date: splitOn, dimension: 'driver', superseded_kind: null },
      { effective_date: splitOn, dimension: 'vehicle', superseded_kind: null },
    ];
    expect(await changeRows(request.id)).toEqual(active);

    // Без подтверждения перечня — 422, и ни одна строка не тронута: заявка осталась в работе.
    const blind = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: dto.fingerprint, ...envelope }),
    );
    expect(blind.statusCode, blind.body).toBe(422);
    expect(String(blind.json().message)).toContain('гасит решения о технике');
    expect(await changeRows(request.id)).toEqual(active);
    expect(await statusOf(request.id)).toBe('confirmed');

    const closed = await complete(
      request.id,
      body(request, ctx.today, {
        previewFingerprint: dto.fingerprint,
        cancelGroupsFingerprint: dto.cancelGroupsFingerprint,
        ...envelope,
      }),
    );
    expect(closed.statusCode, closed.body).toBe(200);
    const cancelled = [
      { effective_date: ctx.today, dimension: 'driver', superseded_kind: null },
      { effective_date: ctx.today, dimension: 'vehicle', superseded_kind: null },
      { effective_date: splitOn, dimension: 'driver', superseded_kind: 'cancelled' },
      { effective_date: splitOn, dimension: 'vehicle', superseded_kind: 'cancelled' },
    ];
    expect(await changeRows(request.id), 'погашена вся группа, а не одна её строка').toEqual(
      cancelled,
    );

    /*
     * Откат в работу и продление обратно — тот самый путь, которым погашенное решение и оживало бы.
     * Откат не возвращает ни срока, ни бумаги (Р14), продление идёт общим путём двери срока, а
     * история к этому моменту помнит только стартовую группу: суббота снова в сроке, но работает в
     * неё та машина, которую назначили с самого начала.
     */
    const done = await reload(request.id);
    const rollback = {
      version: done.version,
      status: 'confirmed',
      comment: 'ТЕСТ Э12: вернули в работу',
    };
    // Возврат в работу переписывает недельные листы и потому спрашивает свой отпечаток последствий
    // — тот же приём, что и у закрытия, только считает его старая ручка.
    const advice = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${done.id}/status/preview`,
      headers: ctx.auth,
      payload: rollback,
    });
    expect(advice.statusCode, advice.body).toBe(200);
    const back = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${done.id}/status`,
      headers: ctx.auth,
      payload: {
        ...rollback,
        previewFingerprint: (advice.json() as { fingerprint: string }).fingerprint,
      },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await termOf(request.id), 'откат оставляет заказ сокращённым').toMatchObject({
      date_to: ctx.today,
    });

    const revived = await reload(request.id);
    const term = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${revived.id}/period/preview`,
      headers: ctx.auth,
      payload: { version: revived.version, dateTo: planned },
    });
    expect(term.statusCode, term.body).toBe(200);
    const extended = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${revived.id}/period`,
      headers: ctx.auth,
      payload: {
        version: revived.version,
        dateTo: planned,
        previewFingerprint: (term.json() as { fingerprint: string }).fingerprint,
      },
    });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(await termOf(request.id)).toMatchObject({ date_to: planned });

    expect(
      await changeRows(request.id),
      'продление не воскрешает погашенное решение: оно осталось погашенным',
    ).toEqual(cancelled);
  }, 180_000);
  it('решение из одной смены машиниста гасится тем же правилом и тоже не оживает после отката с продлением', async () => {
    /*
     * Расширение правила Р18 решением заказчика: гасятся **любые** решения за новым концом срока, а
     * не только те, в которых есть строка о технике. Соседний случай проверяет пару «машина + её
     * машинист»; здесь за фактическим концом стоит группа из **одной** `driver`-строки — сменщик с
     * субботы, машина у заказа всю дорогу одна.
     *
     * Почему её нельзя было оставлять. Прежняя редакция `cancelGroupsOf` брала в счёт только
     * vehicle-строки, ссылаясь на послабление Р24 плана `assignment-periods-plan.md` («изменение за
     * сроком дремлет»). Но Р24 разрешает **поставить** машиниста за концом срока, а здесь решение
     * стояло внутри срока и наружу его вынесла сама команда: непогашенным оно переживало бы
     * закрытие средой и оживало при первом же продлении после отката — тем же способом и по тому же
     * пути, каким оживала бы машина, и прямо вопреки Р14.
     *
     * Проверяются те же три вещи, что и у соседа, потому что предмет у них общий: перечень в
     * предпросмотре, отказ команде без подтверждения и невозвращение решения после отката с
     * продлением. Отличие ровно одно — в перечне стоит группа без машины.
     */
    const typeId = await createType(false, 'driver_groups');
    const planned = shiftDateKey(ctx.today, 5);
    const request = await inWork(typeId, { dateTo: planned });
    const splitOn = shiftDateKey(ctx.today, 3);
    await driverSwapHistory(request.id, {
      startOn: ctx.today,
      splitOn,
      driverPersonId: await createDriver('Субботний'),
    });

    const shown = await preview(request.id, body(request, ctx.today));
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as {
      fingerprint: string;
      cancelGroups: {
        rows: { effectiveDate: string; dimension: string; vehicle: unknown }[];
      }[];
      cancelGroupsFingerprint: string | null;
      operationRequirement: unknown;
    };
    expect(dto.cancelGroups, 'группа за новым концом ровно одна').toHaveLength(1);
    // Состав — одна строка и без машины: гасится решение о человеке, и окно показывает именно его.
    expect(dto.cancelGroups[0]!.rows.map((row) => row.dimension)).toEqual(['driver']);
    expect(dto.cancelGroups[0]!.rows[0]!.vehicle).toBeNull();
    expect(dto.cancelGroups[0]!.rows[0]!.effectiveDate).toBe(splitOn);
    expect(dto.cancelGroupsFingerprint).not.toBeNull();
    /*
     * Исход тот же, что у гашения группы техники: гашение принятого решения — операция журнала
     * (`assignment_tail`), даже когда решение стоит в будущем и прошлого не трогает. Шкала на исход
     * не влияет — «почему сменщика вдруг не стало» портал обязан уметь ответить так же, как «почему
     * не стало машины».
     */
    expect(dto.operationRequirement).toEqual({
      kind: 'assignment_tail',
      reasonRequired: true,
      operationIdRequired: true,
    });
    const envelope = {
      operation: {
        operationId: uuid(),
        reason: 'ТЕСТ: заказ закрыт фактической датой, сменщик снят',
      },
    };

    const active = [
      { effective_date: ctx.today, dimension: 'driver', superseded_kind: null },
      { effective_date: ctx.today, dimension: 'vehicle', superseded_kind: null },
      { effective_date: splitOn, dimension: 'driver', superseded_kind: null },
    ];
    expect(await changeRows(request.id)).toEqual(active);

    // Без подтверждения перечня — 422 и ни одной тронутой строки: человек обязан увидеть, что
    // вместе со сроком уходит и назначенный на субботу машинист.
    const blind = await complete(
      request.id,
      body(request, ctx.today, { previewFingerprint: dto.fingerprint, ...envelope }),
    );
    expect(blind.statusCode, blind.body).toBe(422);
    expect(await changeRows(request.id)).toEqual(active);
    expect(await statusOf(request.id)).toBe('confirmed');

    const closed = await complete(
      request.id,
      body(request, ctx.today, {
        previewFingerprint: dto.fingerprint,
        cancelGroupsFingerprint: dto.cancelGroupsFingerprint,
        ...envelope,
      }),
    );
    expect(closed.statusCode, closed.body).toBe(200);
    const cancelled = [
      { effective_date: ctx.today, dimension: 'driver', superseded_kind: null },
      { effective_date: ctx.today, dimension: 'vehicle', superseded_kind: null },
      { effective_date: splitOn, dimension: 'driver', superseded_kind: 'cancelled' },
    ];
    expect(await changeRows(request.id), 'решение о сменщике погашено').toEqual(cancelled);

    /*
     * Откат в работу и продление обратно — путь, которым решение и оживало бы. Откат не возвращает
     * ни срока, ни бумаги (Р14), продление идёт общим путём двери срока: суббота снова в сроке, но
     * работает в неё тот машинист, которого назначили с самого начала.
     */
    const done = await reload(request.id);
    const rollback = {
      version: done.version,
      status: 'confirmed',
      comment: 'ТЕСТ: вернули в работу',
    };
    const advice = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${done.id}/status/preview`,
      headers: ctx.auth,
      payload: rollback,
    });
    expect(advice.statusCode, advice.body).toBe(200);
    const back = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${done.id}/status`,
      headers: ctx.auth,
      payload: {
        ...rollback,
        previewFingerprint: (advice.json() as { fingerprint: string }).fingerprint,
      },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await termOf(request.id), 'откат оставляет заказ сокращённым').toMatchObject({
      date_to: ctx.today,
    });

    const revived = await reload(request.id);
    const term = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${revived.id}/period/preview`,
      headers: ctx.auth,
      payload: { version: revived.version, dateTo: planned },
    });
    expect(term.statusCode, term.body).toBe(200);
    const extended = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${revived.id}/period`,
      headers: ctx.auth,
      payload: {
        version: revived.version,
        dateTo: planned,
        previewFingerprint: (term.json() as { fingerprint: string }).fingerprint,
      },
    });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(await termOf(request.id)).toMatchObject({ date_to: planned });

    expect(
      await changeRows(request.id),
      'продление не воскрешает погашенную смену машиниста',
    ).toEqual(cancelled);
  }, 180_000);
});
