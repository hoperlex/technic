import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentEarlyEnd from '../src/services/assignment-early-end';

/**
 * ДОСРОЧНОЕ ЗАВЕРШЕНИЕ ЗАКАЗА — три ветви и два предпросмотра, этап Э10 плана
 * [vehicle-request-actual-end-date-plan.md](../../../docs/vehicle-request-actual-end-date-plan.md)
 * (Р19, Р26, Р28; ADR 0044).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ
 *
 * 1. **Ветвь без визы ничего не применяет**: заводит `pending`, срок и бумагу не трогает, а
 *    присланные рукопожатия отвергает 422 — тело у маршрута одно на две ветви, и какая пойдёт,
 *    считает сервер (Р28, вторая граница).
 * 2. **Запрос визирующего требует отпечаток** (Р17): без него 409 «посмотрите последствия заново»,
 *    с ним — срок сокращён, строка запроса согласована, бумага переоформлена.
 * 3. **Виза требует СВОЙ отпечаток** и отвергает отпечаток заявителя (Р19): между запросом и
 *    решением проходит время, а решает другой человек — имя двери входит в отпечаток, и чужой
 *    предпросмотр не подходит физически, а не по проверке.
 * 4. **Отказ работает прежним телом** и ничего не двигает.
 * 5. **Повтор по ключу возвращает прежний результат** — отдельно для автовизы и для визы (Р19).
 *    Это и есть смысл переноса предметных проверок внутрь `plan`: спрошенные до транзакции, они
 *    после первого применения ложны, и повтор получал бы 422 вместо прежнего результата.
 * 6. **Два инварианта Р19**: исход у этой двери не бывает `crew` (разблокировок нет и право
 *    коррекции не спрашивается никогда) и снимаемых смен не бывает вовсе (снимаемый диапазон
 *    целиком в будущем).
 * 7. **Предпросмотр обезличен** (Р26): ни номера бланка, ни фамилии, ни `requiredUnlocks` — и это
 *    верно **для всех**, включая администратора, у которого право на журнал листов есть.
 * 8. **Административная виза сохранена**: `canApproveRequest` пропускает неограниченную роль с
 *    правом визы, и волна этого не отбирает.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЭСМ2-РАЗРЕЗ. Границ листа файл не читает и листов не вставляет: бумагу он спрашивает счётом и
 * **правой границей действующих листов** («ни один лист не выходит за новый срок»), а этот вопрос
 * одинаково честен и при недельном разрезе, и при отрезковом. Прогон один, в режиме `legacy` — том,
 * в котором дверь поедет на прод; в `history` тот же шаг исполняет отрезковый план, и равенство
 * двух планировщиков сторожит теневое сравнение (Э4).
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: половина утверждений здесь про **точные** числа
 * («событие ровно одно», «строка коррекции одна»), и чужая строка в тех же таблицах сделала бы их
 * ложными. База заводится с нуля, мигрируется и сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/vehicle-request-early-end.db.test.ts --maxWorkers=1
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_e10_earlyend';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const ADMIN_EMAIL = 'db-e10-admin@example.invalid';
const CHIEF_EMAIL = 'db-e10-chief@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Уникальный хвост прогона: коды справочников уникальны глобально. */
const RUN = Date.now().toString(36);

/** Фамилия машиниста сцены: её отсутствие в обезличенном теле — предмет отдельной проверки. */
const DRIVER_LAST_NAME = 'Сокращенцев';
/** Контакт заказа: номер выдуман и своими цифрами ни на кого не похож. */
const SITE = { name: 'Досрочнов Илья Петрович', phone: '9007770902' };

interface RequestDto {
  id: string;
  version: number;
  status: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Каркас и дверь — значениями: один случай зовёт расчёт напрямую, минуя HTTP (см. мост причины). */
  command: typeof AssignmentCommand;
  earlyEnd: typeof AssignmentEarlyEnd;
  adminUserId: string;
  /** Администратор: заводит сцену, а в двух случаях сам просит и сам визирует. */
  auth: { authorization: string };
  /**
   * Руководитель строительства своего объекта — единственный субъект автовизы (`approvesOwnRequestOnCreate`)
   * и он же визирует чужие запросы. Ни `waybills.read`, ни `waybills.correct` у роли нет вовсе, и
   * это здесь предмет проверки, а не обстоятельство сцены.
   */
  chiefAuth: { authorization: string };
  objectId: string;
  vehicleId: string;
  vehicleTypeId: string;
  /** Позиция классификатора этого типа; `null` — у типа активных категорий нет вовсе. */
  vehicleCategoryId: string | null;
  /** Вторая машина: ею заводится будущее решение истории, которое гасит сокращение. */
  otherVehicleId: string;
  driverId: string;
  otherDriverId: string;
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

// ── Вход и сцена ──

async function login(email: string): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/**
 * Заказ техники на объект, доведённый до работы назначенной машиной и названным машинистом.
 *
 * Заведение задним числом — операция журнала (ADR 0101): причина без ключа не принимается, потому
 * что повтор после обрыва связи сжёг бы второй номер бланка.
 */
async function inWork(options: { dateFrom?: string; dateTo?: string } = {}): Promise<RequestDto> {
  const backdated = (options.dateFrom ?? ctx.today) < ctx.today;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      ...(ctx.vehicleCategoryId ? { vehicleCategoryId: ctx.vehicleCategoryId } : {}),
      dateFrom: options.dateFrom ?? ctx.today,
      dateTo: options.dateTo ?? shiftDateKey(ctx.today, 5),
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: 'ТЕСТ Э10: досрочное завершение',
      ...(backdated
        ? {
            backdateReason: 'ТЕСТ Э10: заявка оформлена позже выхода техники',
            operationId: randomUUID(),
          }
        : {}),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json() as RequestDto;

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      version: (approved.json() as RequestDto).version,
      status: 'confirmed',
      comment: '',
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return confirmed.json() as RequestDto;
}

/**
 * Будущее решение о машине — то самое, которое сокращение выносит за срок и обязано погасить (Д2).
 *
 * Пишется прямо в историю, а не дверью смены техники: предмет случая — **гашение** группы и
 * вытекающий из него исход `assignment_tail`, а не путь, которым группа появилась. Группа парная
 * (машина плюс её машинист): гашение групповое, и однобокая сцена ловила бы не дверь, а себя.
 */
async function planFutureVehicleChange(requestId: string, effectiveDate: string): Promise<void> {
  const group = randomUUID();
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${requestId}, ${effectiveDate}, 'vehicle', ${ctx.otherVehicleId}, NULL, NULL,
            'reassignment', ${group}),
           (${requestId}, ${effectiveDate}, 'driver', NULL, ${ctx.otherDriverId}, 'set',
            'reassignment', ${group})`);
}

/** Заявка, перечитанная целиком: версия после чужой правки нужна почти каждому случаю. */
async function reload(id: string, auth = ctx.auth): Promise<RequestDto & Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto & Record<string, unknown>;
}

// ── Двери ──

function askPreview(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/early-end/preview`,
    headers: auth,
    payload,
  });
}

function decisionPreview(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/early-end/decision/preview`,
    headers: auth,
    payload,
  });
}

function ask(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${id}/early-end`,
    headers: auth,
    payload,
  });
}

function decide(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${id}/early-end`,
    headers: auth,
    payload,
  });
}

/** Обезличенное тело предпросмотра — так, как его читает окно визирующего. */
interface PreviewDto {
  newDateTo: string;
  daysSaved: number;
  paper: { trimmed: number; cancelled: number; trimmedTo: string | null };
  linearDays: { detachable: string[]; frozen: string[] };
  cancelGroups: { effectiveDate: string }[];
  operationRequirement: {
    kind: string;
    reasonRequired: boolean;
    operationIdRequired: boolean;
  } | null;
  asOf: string;
  fingerprint: string;
  cancelGroupsFingerprint: string | null;
}

// ── Чтение последствий ──

async function earlyEndRow(requestId: string): Promise<{
  status: string;
  new_date_to: string;
  previous_date_to: string;
  reason: string;
  decision_comment: string;
  decided_by: string | null;
} | null> {
  const rows = await ctx.db.execute<{
    status: string;
    new_date_to: string;
    previous_date_to: string;
    reason: string;
    decision_comment: string;
    decided_by: string | null;
  }>(sql`SELECT status, new_date_to, previous_date_to, reason, decision_comment, decided_by
           FROM vehicle_request_early_endings WHERE request_id = ${requestId}`);
  return rows.rows[0] ?? null;
}

async function termOf(requestId: string): Promise<{ date_from: string; date_to: string | null }> {
  const rows = await ctx.db.execute<{ date_from: string; date_to: string | null }>(sql`
    SELECT date_from, date_to FROM special_equipment_request_details WHERE request_id = ${requestId}`);
  return rows.rows[0]!;
}

async function auditActions(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ action: string }>(sql`
    SELECT action FROM audit_log
     WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}
     ORDER BY created_at`);
  return rows.rows.map((row) => row.action);
}

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

/** Действующие листы заявки: их номера и правая граница периода. */
async function liveSheets(
  requestId: string,
): Promise<{ id: string; period_to: string | null; status: string }[]> {
  const rows = await ctx.db.execute<{ id: string; period_to: string | null; status: string }>(sql`
    SELECT id, period_to, status FROM waybills
     WHERE source_request_id = ${requestId} AND status <> 'cancelled'
     ORDER BY period_to NULLS FIRST, id`);
  return rows.rows;
}

async function shiftDates(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ shift_date: string }>(sql`
    SELECT shift_date FROM vehicle_request_shifts WHERE request_id = ${requestId}
     ORDER BY shift_date`);
  return rows.rows.map((row) => row.shift_date);
}

/** Операции журнала, заведённые этой заявкой: вид и снимок требований. */
async function corrections(
  requestId: string,
): Promise<{ kind: string; operation_id: string; requires_correct: boolean; reason: string }[]> {
  const rows = await ctx.db.execute<{
    kind: string;
    operation_id: string;
    requires_correct: boolean;
    reason: string;
  }>(sql`
    SELECT c.kind, c.operation_id, c.reason,
           coalesce((c.authorization_scope ->> 'requiresCorrect')::boolean, false) AS requires_correct
      FROM waybill_corrections c
      JOIN vehicle_request_corrections r ON r.correction_id = c.id
     WHERE r.request_id = ${requestId}
     ORDER BY c.created_at`);
  return rows.rows;
}

/** Заполнить смену дня; `approved` ставит и подпись объекта. */
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

describe.skipIf(!DB_URL)('досрочное завершение заказа: три ветви (Э10)', () => {
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
    const personOf = async (lastName: string): Promise<string> => {
      const [person] = await db
        .insert(schema.persons)
        .values({
          lastName,
          firstName: 'Тест',
          middleName: 'Машинистович',
          comment: 'ТЕСТОВЫЕ ДАННЫЕ: досрочное завершение заказа',
        })
        .returning({ id: schema.persons.id });
      await db.insert(schema.personSpecializations).values({
        personId: person!.id,
        specializationId: specialization.id,
        isPrimary: true,
        startedOn: '2024-01-15',
      });
      return person!.id;
    };
    const driverId = await personOf(DRIVER_LAST_NAME);
    const otherDriverId = await personOf('Сменщиков');

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id LIMIT 1`,
    );
    const vehicles = await db.execute<{ id: string; vehicle_type_id: string }>(sql`
      SELECT v.id, v.vehicle_type_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vk.code = 'special_equipment' AND vt.is_linear = false
       ORDER BY v.registration_number
       LIMIT 2`);
    const object = objects.rows[0];
    const [vehicle, otherVehicle] = vehicles.rows;
    if (!object || !vehicle || !otherVehicle) {
      throw new Error('в базе нет площадки или двух своих нелинейных машин: миграции не применены');
    }
    /*
     * Позиция классификатора: у типа с активными категориями заказ обязан её назвать
     * (`resolveClassification`), у типа без них — не вправе. Спрашивается справочник, а не
     * подставляется догадка: набор категорий приезжает миграциями и меняется вместе с ними.
     */
    const categories = await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicle_categories
       WHERE vehicle_type_id = ${vehicle.vehicle_type_id} AND is_active
       ORDER BY id LIMIT 1`);

    /*
     * Руководитель строительства своего объекта — субъект автовизы (ADR 0025 п. 5, ADR 0032). Роль
     * несёт `vehicleRequests.update` и `vehicleRequests.approve` и **не несёт** ни одного права на
     * листы: обе половины здесь предмет проверки, а не удобство сцены.
     */
    const [chief] = await db
      .insert(schema.users)
      .values({
        email: CHIEF_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Руководитель',
        middleName: '',
        passwordHash,
        role: 'rukstroy',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    await db.insert(schema.userConstructionObjects).values({
      userId: chief!.id,
      constructionObjectId: object.id,
    });

    const app = await buildApp();
    ctx = {
      app,
      db,
      closeDb,
      command: await import('../src/services/assignment-command'),
      earlyEnd: await import('../src/services/assignment-early-end'),
      adminUserId: admin!.id,
      auth: { authorization: '' },
      chiefAuth: { authorization: '' },
      objectId: object.id,
      vehicleId: vehicle.id,
      vehicleTypeId: vehicle.vehicle_type_id,
      vehicleCategoryId: categories.rows[0]?.id ?? null,
      otherVehicleId: otherVehicle.id,
      driverId,
      otherDriverId,
      today: moscowDateKeyOf(new Date()),
    };
    ctx.auth = await login(ADMIN_EMAIL);
    ctx.chiefAuth = await login(CHIEF_EMAIL);
    void RUN;
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

  // ── Ветвь 1: запрос без визы ──

  it('запрос без визы заводит ожидание и не трогает ни срок, ни бумагу', async () => {
    const request = await inWork();
    const planned = shiftDateKey(ctx.today, 5);
    const sheetsBefore = await liveSheets(request.id);
    // Событие сверки у заявки уже есть — его написал перевод в работу. Значит меряется прирост, а
    // не отсутствие: «бумагу не трогали» это «сверка не работала ещё раз».
    const syncBefore = (await auditOf(request.id, 'waybill.esm2_sync')).length;

    /*
     * Просит администратор: под правило автовизы он не подпадает намеренно (ADR 0032) — право визы
     * у него есть, но действует он не за объект. Значит эта ветвь и есть «запрос уходит на визу».
     */
    const asked = await ask(request.id, {
      newDateTo: shiftDateKey(ctx.today, 2),
      reason: 'ТЕСТ Э10: работы на фундаменте закончены',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);

    expect(await earlyEndRow(request.id)).toMatchObject({
      status: 'pending',
      new_date_to: shiftDateKey(ctx.today, 2),
      previous_date_to: planned,
      decided_by: null,
    });
    // Срок и бумага — ровно те же: запрос ничего не применяет, он ждёт визы.
    expect(await termOf(request.id)).toMatchObject({ date_to: planned });
    expect(await liveSheets(request.id)).toEqual(sheetsBefore);
    const actions = await auditActions(request.id);
    expect(actions.filter((a) => a === 'vehicle_request.early_end_request')).toHaveLength(1);
    expect(actions).not.toContain('vehicle_request.early_end_approve');
    expect(await auditOf(request.id, 'waybill.esm2_sync')).toHaveLength(syncBefore);
  });

  it('этой ветви рукопожатия не применимы: 422 по рассчитанной ветви, а не 400 по схеме', async () => {
    const request = await inWork();
    /*
     * Схема принимает допустимое надмножество — тело у маршрута одно на две ветви, — а какая ветвь
     * пойдёт, считает сервер по субъекту (Р28, вторая граница). Отсюда 422, а не 400: поле в теле
     * законно, неприменима сама ветвь.
     */
    const refused = await ask(request.id, {
      newDateTo: shiftDateKey(ctx.today, 2),
      reason: 'ТЕСТ Э10: работы закончены',
      version: request.version,
      previewFingerprint: 'a'.repeat(64),
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(await earlyEndRow(request.id)).toBeNull();

    // И предпросмотра у этой ветви нет вовсе: обещание «что будет, когда завизируют» к моменту визы
    // устареет, и показывает его предпросмотр решения.
    const shown = await askPreview(request.id, {
      newDateTo: shiftDateKey(ctx.today, 2),
      reason: 'ТЕСТ Э10: работы закончены',
      version: request.version,
    });
    expect(shown.statusCode, shown.body).toBe(422);
  });

  // ── Ветвь 2: запрос визирующего ──

  it('запрос визирующего требует отпечаток и применяет срок сразу', async () => {
    const request = await inWork();
    const planned = shiftDateKey(ctx.today, 5);
    const newDateTo = shiftDateKey(ctx.today, 2);
    const body = {
      newDateTo,
      reason: 'ТЕСТ Э10: техника освободилась раньше',
      version: request.version,
    };

    // Без отпечатка — 409 «посмотрите последствия заново», а не 400: пуста команда или нет, видно
    // только после расчёта под блокировкой (Р17).
    const blind = await ask(request.id, body, ctx.chiefAuth);
    expect(blind.statusCode, blind.body).toBe(409);
    expect(blind.json().code).toBe('assignment_preview_stale');
    expect(await termOf(request.id)).toMatchObject({ date_to: planned });

    const shown = await askPreview(request.id, body, ctx.chiefAuth);
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as PreviewDto;
    expect(dto).toMatchObject({ newDateTo, daysSaved: 3, asOf: ctx.today });
    // Гасить нечего: решений истории за новым концом срока у этой заявки нет.
    expect(dto.cancelGroups).toEqual([]);
    expect(dto.cancelGroupsFingerprint).toBeNull();
    expect(dto.operationRequirement).toBeNull();

    const applied = await ask(
      request.id,
      { ...body, previewFingerprint: dto.fingerprint },
      ctx.chiefAuth,
    );
    expect(applied.statusCode, applied.body).toBe(200);

    expect(await termOf(request.id)).toMatchObject({ date_to: newDateTo });
    expect(await earlyEndRow(request.id)).toMatchObject({
      status: 'approved',
      new_date_to: newDateTo,
      previous_date_to: planned,
      decision_comment: '',
    });
    // Своя виза — отдельным событием с пометкой `auto`, как и при заведении заявки.
    const approve = await auditOf(request.id, 'vehicle_request.early_end_approve');
    expect(approve).toHaveLength(1);
    expect(approve[0]!.metadata).toMatchObject({ auto: true, door: 'early_end_request' });
    expect(approve[0]!.metadata.changes).toEqual([
      { field: 'dateTo', from: expect.any(String), to: expect.any(String) },
    ]);
    // Бумага переоформлена той же транзакцией: ни один действующий лист не выходит за новый срок.
    for (const sheet of await liveSheets(request.id)) {
      expect(sheet.period_to === null || sheet.period_to <= newDateTo).toBe(true);
    }
  });

  it('предпросмотр обезличен для всех, включая администратора', async () => {
    const request = await inWork();
    await planFutureVehicleChange(request.id, shiftDateKey(ctx.today, 4));
    const asked = await ask(request.id, {
      newDateTo: shiftDateKey(ctx.today, 1),
      reason: 'ТЕСТ Э10: работы закончены раньше',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);

    // Смотрит администратор — у него `waybills.read` есть, и тело всё равно обезличено (Р26): две
    // формы ответа на одном маршруте разошлись бы при первой правке.
    const shown = await decisionPreview(request.id, {
      approved: true,
      version: (await reload(request.id)).version,
    });
    expect(shown.statusCode, shown.body).toBe(200);
    const raw = shown.body;
    for (const forbidden of [
      'waybillId',
      'displayNumber',
      'requiredUnlocks',
      'unlockFingerprint',
      'clearedShift',
      'routeNumber',
      DRIVER_LAST_NAME,
      'Сменщиков',
    ]) {
      expect(raw, `обезличенное тело называет «${forbidden}»`).not.toContain(forbidden);
    }
    const dto = shown.json() as PreviewDto;
    // Гашение показано датой, а не составом: «что погаснет» визирующему объясняет день, а машины и
    // фамилии в нём — ровно то, ради сокрытия чего заведено обезличивание.
    expect(dto.cancelGroups).toEqual([{ effectiveDate: shiftDateKey(ctx.today, 4) }]);
    expect(dto.cancelGroupsFingerprint).not.toBeNull();
    // Своя проекция требования (Р19): причину назвал сам запрос, второго поля окно не показывает.
    expect(dto.operationRequirement).toEqual({
      kind: 'assignment_tail',
      reasonRequired: false,
      operationIdRequired: true,
    });
    expect(Object.keys(dto).sort()).toEqual([
      'asOf',
      'cancelGroups',
      'cancelGroupsFingerprint',
      'daysSaved',
      'fingerprint',
      // Предупреждения по выписываемым листам (Б4) — и они тоже обезличены: вид замечания и
      // отпечаток фактов, без номера бланка, без фамилии и без идентификатора человека. Подписать
      // бланк визирующий обязан, а увидеть, у кого именно пробел, — не вправе (Р26).
      'issues',
      'linearDays',
      'newDateTo',
      'operationRequirement',
      'paper',
    ]);
  });

  // ── Ветвь 3: решение ──

  it('виза требует свой отпечаток и отвергает отпечаток заявителя', async () => {
    const request = await inWork();
    const newDateTo = shiftDateKey(ctx.today, 2);
    const asked = await ask(request.id, {
      newDateTo,
      reason: 'ТЕСТ Э10: работы закончены',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const pending = await reload(request.id);

    // Без отпечатка виза не проходит — она применяет срок так же, как и запрос визирующего.
    const blind = await decide(
      request.id,
      { approved: true, version: pending.version },
      ctx.chiefAuth,
    );
    expect(blind.statusCode, blind.body).toBe(409);

    /*
     * Отпечаток заявителя по тому же состоянию — и он не подходит: имя двери входит в отпечаток, а
     * у запроса и у решения они разные. Между запросом и визой проходит время и решает другой
     * человек, поэтому чужой предпросмотр подтверждает не то (Р19).
     */
    const asRequester = await askPreview(
      request.id,
      { newDateTo, reason: 'ТЕСТ Э10: работы закончены', version: pending.version },
      ctx.chiefAuth,
    );
    expect(asRequester.statusCode, asRequester.body).toBe(200);
    const foreign = await decide(
      request.id,
      {
        approved: true,
        version: pending.version,
        previewFingerprint: (asRequester.json() as PreviewDto).fingerprint,
      },
      ctx.chiefAuth,
    );
    expect(foreign.statusCode, foreign.body).toBe(409);
    expect(await termOf(request.id)).toMatchObject({ date_to: shiftDateKey(ctx.today, 5) });

    const shown = await decisionPreview(
      request.id,
      { approved: true, version: pending.version },
      ctx.chiefAuth,
    );
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as PreviewDto;
    expect(dto.newDateTo).toBe(newDateTo);

    const visa = await decide(
      request.id,
      {
        approved: true,
        comment: 'ТЕСТ Э10: согласовано, техника нужна на другом объекте',
        version: pending.version,
        previewFingerprint: dto.fingerprint,
      },
      ctx.chiefAuth,
    );
    expect(visa.statusCode, visa.body).toBe(200);
    expect(await termOf(request.id)).toMatchObject({ date_to: newDateTo });
    // Комментарий одобряющей визы сохранён: он и остаётся единственным местом, где живёт слово
    // визирующего, — причиной операции он не становится (Р28).
    expect(await earlyEndRow(request.id)).toMatchObject({
      status: 'approved',
      decision_comment: 'ТЕСТ Э10: согласовано, техника нужна на другом объекте',
      reason: 'ТЕСТ Э10: работы закончены',
    });
    const approve = await auditOf(request.id, 'vehicle_request.early_end_approve');
    expect(approve).toHaveLength(1);
    expect(approve[0]!.metadata).toMatchObject({ door: 'early_end_decision' });
    expect(approve[0]!.metadata.auto).toBeUndefined();
  });

  it('отказ работает прежним телом и ничего не двигает', async () => {
    const request = await inWork();
    const planned = shiftDateKey(ctx.today, 5);
    const asked = await ask(request.id, {
      newDateTo: shiftDateKey(ctx.today, 2),
      reason: 'ТЕСТ Э10: работы закончены',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const pending = await reload(request.id);

    // Рукопожатия отказу не принимает **схема**: он ничего не применяет, и присланный отпечаток
    // означает ошибку клиента, то есть 400 (Р28, первая граница).
    const wrong = await decide(
      request.id,
      {
        approved: false,
        comment: 'Техника ещё нужна',
        version: pending.version,
        previewFingerprint: 'a'.repeat(64),
      },
      ctx.chiefAuth,
    );
    expect(wrong.statusCode, wrong.body).toBe(400);

    const rejected = await decide(
      request.id,
      { approved: false, comment: 'ТЕСТ Э10: техника ещё нужна', version: pending.version },
      ctx.chiefAuth,
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await earlyEndRow(request.id)).toMatchObject({
      status: 'rejected',
      decision_comment: 'ТЕСТ Э10: техника ещё нужна',
    });
    expect(await termOf(request.id)).toMatchObject({ date_to: planned });
    expect(await auditActions(request.id)).toContain('vehicle_request.early_end_reject');
  });

  it('административная виза сохранена: неограниченную роль с правом визы дверь пропускает', async () => {
    const request = await inWork();
    const newDateTo = shiftDateKey(ctx.today, 3);
    /*
     * Просит руководитель отдела? Нет — просит **штабной** путь: запрос заводит администратор (его
     * запрос ждёт визы), а визирует он же. `canApproveRequest` пропускает любую неограниченную роль
     * с правом визы, и волна этого не отбирает (Р26, блокер 4 седьмого ревью).
     */
    const asked = await ask(request.id, {
      newDateTo,
      reason: 'ТЕСТ Э10: техника освободилась',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const pending = await reload(request.id);
    const shown = await decisionPreview(request.id, { approved: true, version: pending.version });
    expect(shown.statusCode, shown.body).toBe(200);
    const visa = await decide(request.id, {
      approved: true,
      version: pending.version,
      previewFingerprint: (shown.json() as PreviewDto).fingerprint,
    });
    expect(visa.statusCode, visa.body).toBe(200);
    expect(await termOf(request.id)).toMatchObject({ date_to: newDateTo });
  });

  // ── Повтор по ключу ──

  it('повтор по ключу возвращает прежний результат: автовиза', async () => {
    const request = await inWork();
    const newDateTo = shiftDateKey(ctx.today, 1);
    await planFutureVehicleChange(request.id, shiftDateKey(ctx.today, 3));
    const core = {
      newDateTo,
      reason: 'ТЕСТ Э10: работы закончены, машина уходит',
      version: request.version,
    };
    const shown = await askPreview(request.id, core, ctx.chiefAuth);
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as PreviewDto;
    // Гашение будущей группы требует журнала: исход `assignment_tail`, и ключ операции обязателен.
    expect(dto.operationRequirement).toMatchObject({ kind: 'assignment_tail' });
    expect(dto.cancelGroupsFingerprint).not.toBeNull();

    const operationId = randomUUID();
    const payload = {
      ...core,
      previewFingerprint: dto.fingerprint,
      cancelGroupsFingerprint: dto.cancelGroupsFingerprint!,
      operationId,
    };
    const applied = await ask(request.id, payload, ctx.chiefAuth);
    expect(applied.statusCode, applied.body).toBe(200);
    const after = await reload(request.id);

    /*
     * Тот же ключ ещё раз — честный повтор: работы нет, версия не тронута, второго события и второй
     * строки журнала не появляется. Именно это и было недостижимо, пока предметные проверки стояли
     * до транзакции: повтор упирался бы в «срок заявки заканчивается сегодня» раньше, чем шаг 2
     * канона нашёл бы прежнюю операцию.
     */
    const repeated = await ask(request.id, payload, ctx.chiefAuth);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect((await reload(request.id)).version).toBe(after.version);
    expect(await auditOf(request.id, 'vehicle_request.early_end_approve')).toHaveLength(1);
    const journal = await corrections(request.id);
    expect(journal.filter((row) => row.operation_id === operationId)).toHaveLength(1);
    expect(await termOf(request.id)).toMatchObject({ date_to: newDateTo });
  });

  it('повтор по ключу возвращает прежний результат: виза', async () => {
    const request = await inWork();
    const newDateTo = shiftDateKey(ctx.today, 1);
    await planFutureVehicleChange(request.id, shiftDateKey(ctx.today, 3));
    const asked = await ask(request.id, {
      newDateTo,
      reason: 'ТЕСТ Э10: работы закончены, машина уходит',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const pending = await reload(request.id);

    const shown = await decisionPreview(
      request.id,
      { approved: true, version: pending.version },
      ctx.chiefAuth,
    );
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as PreviewDto;
    expect(dto.operationRequirement).toMatchObject({ kind: 'assignment_tail' });

    const operationId = randomUUID();
    const payload = {
      approved: true,
      comment: 'ТЕСТ Э10: согласовано',
      version: pending.version,
      previewFingerprint: dto.fingerprint,
      cancelGroupsFingerprint: dto.cancelGroupsFingerprint!,
      operationId,
    };
    const visa = await decide(request.id, payload, ctx.chiefAuth);
    expect(visa.statusCode, visa.body).toBe(200);
    const after = await reload(request.id);

    const repeated = await decide(request.id, payload, ctx.chiefAuth);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect((await reload(request.id)).version).toBe(after.version);
    expect(await auditOf(request.id, 'vehicle_request.early_end_approve')).toHaveLength(1);
    expect(
      (await corrections(request.id)).filter((row) => row.operation_id === operationId),
    ).toHaveLength(1);

    /*
     * Причина операции — из запроса, а не из комментария визы (мост причины, Р19): у обоих полей
     * предел 2000 символов, и склейка однажды упала бы на схеме журнала.
     */
    const journal = (await corrections(request.id)).find((row) => row.operation_id === operationId);
    expect(journal!.reason).toBe('ТЕСТ Э10: работы закончены, машина уходит');
  });

  it('мост причины: envelope, собранный по другому состоянию, визу не проводит', async () => {
    const request = await inWork();
    const asked = await ask(request.id, {
      newDateTo: shiftDateKey(ctx.today, 2),
      reason: 'ТЕСТ Э10: первая причина',
      version: request.version,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const row = (await earlyEndRow(request.id))!;

    /*
     * Расчёт зовётся напрямую, а не через HTTP, и это не обход двери, а единственный способ дойти
     * до предмета. Гонка, которую закрывает мост, живёт **между двумя чтениями одного запроса**:
     * предварительным (из него собран envelope журнала) и тем, что идёт из-под блокировки. Снаружи
     * этого шва нет — маршрут читает строку сам, и в снимке у него всегда свежее значение. Поэтому
     * снимок подставляется руками, тем же колбэком, каким его зовёт дверь.
     */
    const planWith = (snapshot: { newDateTo: string; reason: string } | null) =>
      ctx.command.previewAssignmentCommand<AssignmentEarlyEnd.EarlyEndPlan>(ctx.db, {
        requestId: request.id,
        actor: { id: ctx.adminUserId },
        asOf: ctx.today,
        plan: (planCtx) =>
          ctx.earlyEnd.planEarlyEndCommand(planCtx, { branch: 'decision', snapshot, comment: '' }),
      });

    // Тот же снимок — расчёт идёт: строка под блокировкой та же, по которой собран envelope.
    await expect(
      planWith({ newDateTo: row.new_date_to, reason: row.reason }),
    ).resolves.toBeTruthy();
    // Причина в строке другая — 409 тем же кодом, что и устаревший отпечаток: человек в обоих
    // случаях делает одно и то же — смотрит последствия заново.
    await expect(
      planWith({ newDateTo: row.new_date_to, reason: 'ТЕСТ Э10: причины такой в запросе нет' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'assignment_preview_stale' });
    // Другая дата — то же самое: envelope собран по запросу, которого больше нет.
    await expect(
      planWith({ newDateTo: shiftDateKey(ctx.today, 3), reason: row.reason }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Снимка нет вовсе, а строка есть: маршрут её не видел — значит состояние поменялось под
    // командой, и это тот же разговор «посмотрите заново», а не «запроса нет».
    await expect(planWith(null)).rejects.toMatchObject({ statusCode: 409 });

    // А когда ожидающего запроса действительно нет — 422 по существу, и решает это расчёт под
    // блокировкой, а не маршрут: иначе повтор по ключу до шага 2 канона не доходил бы.
    const bare = await inWork();
    await expect(
      ctx.command.previewAssignmentCommand<AssignmentEarlyEnd.EarlyEndPlan>(ctx.db, {
        requestId: bare.id,
        actor: { id: ctx.adminUserId },
        asOf: ctx.today,
        plan: (planCtx) =>
          ctx.earlyEnd.planEarlyEndCommand(planCtx, {
            branch: 'decision',
            snapshot: { newDateTo: shiftDateKey(ctx.today, 2), reason: 'ТЕСТ Э10' },
            comment: '',
          }),
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // ── Инварианты Р19 ──

  it('инварианты: исход не бывает `crew`, разблокировок нет и смен не снимают', async () => {
    /*
     * Самая враждебная сцена, какую эта дверь допускает: заказ идёт **с прошлой недели**, бумага за
     * отработанные дни выписана, смены заполнены и подписаны, а сокращают его до **сегодня** —
     * нижней границы (`earlyEndDateBounds.min = onDate`). Если исход `crew` вообще достижим, он
     * достижим здесь.
     */
    const request = await inWork({
      dateFrom: shiftDateKey(ctx.today, -7),
      dateTo: shiftDateKey(ctx.today, 5),
    });
    await planFutureVehicleChange(request.id, shiftDateKey(ctx.today, 3));
    await fillShift(request.id, shiftDateKey(ctx.today, -2), true);
    await fillShift(request.id, ctx.today);
    const shiftsBefore = await shiftDates(request.id);
    expect(shiftsBefore.length).toBeGreaterThan(0);

    const core = {
      newDateTo: ctx.today,
      reason: 'ТЕСТ Э10: техника уходит сегодня',
      version: (await reload(request.id)).version,
    };
    const shown = await askPreview(request.id, core, ctx.chiefAuth);
    expect(shown.statusCode, shown.body).toBe(200);
    const dto = shown.json() as PreviewDto;
    // Первый инвариант — исход: `crew` недостижим даже здесь, гашение даёт ровно `assignment_tail`.
    expect(dto.operationRequirement).toMatchObject({ kind: 'assignment_tail' });

    const operationId = randomUUID();
    const applied = await ask(
      request.id,
      {
        ...core,
        previewFingerprint: dto.fingerprint,
        cancelGroupsFingerprint: dto.cancelGroupsFingerprint!,
        operationId,
      },
      ctx.chiefAuth,
    );
    /*
     * Команда прошла, хотя у визирующего нет ни `waybills.correct`, ни `waybills.read`. Это и есть
     * доказательство обоих следствий инварианта: право коррекции спрашивается ровно при исходе
     * `crew`, а разблокировки считаются только при нём же — будь исход `crew`, здесь стояло бы 403.
     */
    expect(applied.statusCode, applied.body).toBe(200);
    const journal = (await corrections(request.id)).find((row) => row.operation_id === operationId);
    expect(journal).toBeDefined();
    expect(journal!.kind).toBe('assignment_tail');
    expect(journal!.requires_correct).toBe(false);

    /*
     * Второй инвариант — смены: снимаемый диапазон `(newDateTo, previousDateTo]` целиком в будущем,
     * а смену будущим днём не ведут. Ни одна строка смен не тронута, включая подписанную за
     * прошлый день, — снимать этой двери нечего, и полей под подтверждение у неё нет вовсе.
     */
    expect(await shiftDates(request.id)).toEqual(shiftsBefore);
    expect(await termOf(request.id)).toMatchObject({ date_to: ctx.today });
  });
});
