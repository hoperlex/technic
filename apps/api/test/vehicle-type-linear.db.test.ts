import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Признак «линейная техника» у типа ТС (ADR 0100, миграция 0127) — на живой схеме, через
 * настоящие HTTP-пути.
 *
 * Здесь живёт договор **правки типа**: признак ездит через заведение, соседние поля правятся
 * свободно, а журнал различает деактивацию, смену бланка и обычное обновление.
 *
 * Самого переключения признака в этой ручке больше нет: у него свой протокол — предпросмотр,
 * отпечаток подтверждения и ответ с номерами замороженных заявок (ADR 0107), и проверяется он
 * соседним файлом `vehicle-type-linear-switch.db.test.ts`. Здесь от этого остался ровно один
 * кейс — что `PATCH` отвечает `422` и объясняет, куда идти.
 *
 * Зачем база. Поведение решает не схема запроса, а состояние соседних таблиц и журнал: разойтись
 * могут ровно код и база.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-linear-type-admin@example.invalid';
const PASSWORD = 'db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  kindId: string;
  objectId: string;
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
  return `linear_test_${Date.now()}_${typeNo}`;
}

async function createType(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: { kindId: ctx.kindId, code: nextCode(), name: 'Тип для линейной проверки', ...over },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function patchType(
  id: string,
  payload: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-types/${id}`,
    headers: ctx.auth,
    payload,
  });
}

/** Заказ техники этого типа в нужном статусе — строкой, а не формой: форма заводит только «Новую». */
async function request(
  typeId: string,
  status: 'new' | 'confirmed' | 'done' | 'cancelled',
  options: { deleted?: boolean } = {},
): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle_requests (object_id, request_type, vehicle_type_id, status, created_by, deleted_at)
    VALUES (${ctx.objectId}, 'special_equipment', ${typeId}, ${status}, ${ctx.adminId},
            ${options.deleted ? sql`now()` : sql`NULL`})
    RETURNING id`);
  const id = res.rows[0]!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from)
    VALUES (${id}, current_date)`);
  return id;
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

describe.skipIf(!DB_URL)('линейная техника: признак типа ТС (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const adminId = await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    // Вид ТС и объект берутся из справочника: состав наполняют миграции, и зафиксированный здесь
    // идентификатор разошёлся бы с ними при первой правке.
    const kinds = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_kinds WHERE is_active ORDER BY sort_order, code LIMIT 1`,
    );
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const kind = kinds.rows[0];
    const object = objects.rows[0];
    if (!kind || !object) throw new Error('в базе нет вида ТС или объекта: миграции не применены');

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
    };
  }, 120_000);

  afterAll(async () => {
    // За собой убираем: база у db-тестов общая, и заведённые здесь типы с заказами иначе видны
    // соседним файлам — круговому обмену справочников, отборам списка заявок, срезам. Порядок
    // обратный ссылкам: заказы (детали уходят каскадом), потом сами типы. Учётка теста остаётся
    // намеренно — на неё ссылается журнал аудита, а `seedAdmin` переиспользует её при следующем
    // прогоне вместо того, чтобы плодить однофамильцев.
    if (ctx?.db) {
      await ctx.db.execute(sql`
        DELETE FROM vehicle_requests
        WHERE vehicle_type_id IN (SELECT id FROM vehicle_types WHERE code LIKE 'linear_test_%')`);
      await ctx.db.execute(sql`DELETE FROM vehicle_types WHERE code LIKE 'linear_test_%'`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('признак ездит через создание, а правкой типа больше не меняется', async () => {
    const created = await createType({ isLinear: true });
    expect(created.isLinear).toBe(true);

    // Правка соседнего поля признака не роняет: PATCH правит названное, а не всю запись.
    const renamed = await patchType(created.id as string, { name: 'Тип переименованный' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().isLinear).toBe(true);

    // А вот сам признак этой ручкой не переключается: у переключения свой протокол —
    // предпросмотр и подтверждение (ADR 0107, решение 5). Отказ именно 422 и с объяснением, куда
    // идти: `400` схемы старый клиент прочитал бы как поломку портала.
    const off = await patchType(created.id as string, { isLinear: false });
    expect(off.statusCode, off.body).toBe(422);
    expect(off.json().code).not.toBe('validation_error');
    expect(off.json().message).toMatch(/Линейная техника/);

    // Умолчание создания — «нет»: тип, заведённый без вопроса, ведёт себя как все прежние.
    const plain = await createType();
    expect(plain.isLinear).toBe(false);
  });

  it('деактивация правится и у линейного типа: запрет держит признак, а не запись', async () => {
    const created = await createType({ isLinear: true });
    const res = await patchType(created.id as string, { isActive: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().isLinear).toBe(true);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.deactivate');
  });

  it('смена бланка остаётся своим действием журнала', async () => {
    const created = await createType();

    const formOnly = await patchType(created.id as string, { waybillFormCode: 'leg3' });
    expect(formOnly.statusCode, formOnly.body).toBe(200);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.waybill_form');

    const nameOnly = await patchType(created.id as string, { name: 'Тип с бланком' });
    expect(nameOnly.statusCode, nameOnly.body).toBe(200);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.update');
  });

  it('заявки в работе правке прочих полей не мешают', async () => {
    const created = await createType();
    await request(created.id as string, 'confirmed');
    await request(created.id as string, 'confirmed');

    // Прежний запрет «у типа есть заявки в работе» снят вместе с самим переключением через PATCH
    // (ADR 0107): теперь такой тип правится как любой другой, а признак переключают своей ручкой —
    // её договор проверяет `vehicle-type-linear-switch.db.test.ts`.
    const renamed = await patchType(created.id as string, { name: 'Занятый тип' });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('признак того же значения правкой не является: менять нечего', async () => {
    const created = await createType({ isLinear: true });
    await request(created.id as string, 'confirmed');

    // Форма справочника собирает полный объект правки, а не изменённые поля, — и присланное
    // совпадающее значение обязано проходить: иначе переименовать линейный тип стало бы нельзя.
    const res = await patchType(created.id as string, { isLinear: true, name: 'Тот же признак' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().isLinear).toBe(true);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.update');
  });
});
