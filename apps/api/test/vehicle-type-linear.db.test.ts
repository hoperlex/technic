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
 * Зачем база. Половину поведения здесь решает не схема запроса, а состояние соседней таблицы:
 * менять признак у типа, по которому уже работают заявки, нельзя (ADR 0100 §1 — признак читается
 * живым, снимка в заявке нет). Проверить это на правилах невозможно: отказ считается запросом к
 * `vehicle_requests`, и разойтись могут ровно код и база — условие «в работе и не удалена».
 * Вторая половина — журнал: смена признака обязана попасть в него своим действием, иначе вопрос
 * «кто перевёл тип на дневной режим» останется без ответа.
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

  it('признак ездит через создание и правку, а не спрошенный остаётся прежним', async () => {
    const created = await createType({ isLinear: true });
    expect(created.isLinear).toBe(true);

    // Правка соседнего поля признака не роняет: PATCH правит названное, а не всю запись.
    const renamed = await patchType(created.id as string, { name: 'Тип переименованный' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().isLinear).toBe(true);

    const off = await patchType(created.id as string, { isLinear: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().isLinear).toBe(false);

    // Умолчание создания — «нет»: тип, заведённый без вопроса, ведёт себя как все прежние.
    const plain = await createType();
    expect(plain.isLinear).toBe(false);
  });

  it('смена признака — своё действие журнала, и оно перевешивает смену бланка', async () => {
    const created = await createType();

    const res = await patchType(created.id as string, { isLinear: true });
    expect(res.statusCode, res.body).toBe(200);
    const entry = await lastAudit(created.id as string);
    expect(entry.action).toBe('vehicle_type.linear');
    expect(entry.metadata.oldIsLinear).toBe(false);
    expect(entry.metadata.newIsLinear).toBe(true);

    // Оба поля в одной правке: журналу нужнее то изменение, после которого заявки начинают
    // вести себя иначе, — бланк решает, чем печатать рейс, линейность — рождаются ли листы.
    const both = await patchType(created.id as string, {
      isLinear: false,
      waybillFormCode: 'leg3',
    });
    expect(both.statusCode, both.body).toBe(200);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.linear');

    // Признак не тронут — запись прежняя: «обновлён» и «смена бланка» остались на своих местах.
    const formOnly = await patchType(created.id as string, { waybillFormCode: '4p' });
    expect(formOnly.statusCode, formOnly.body).toBe(200);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.waybill_form');

    const nameOnly = await patchType(created.id as string, { name: 'Тип с бланком' });
    expect(nameOnly.statusCode, nameOnly.body).toBe(200);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.update');
  });

  it('деактивация перевешивает линейность: выключенным типом больше ничего не заводят', async () => {
    const created = await createType();
    const res = await patchType(created.id as string, { isActive: false, isLinear: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().isLinear).toBe(true);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.deactivate');
  });

  it('пока у типа есть заявки в работе, признак не меняется — 422 с числом заявок', async () => {
    const created = await createType();
    await request(created.id as string, 'confirmed');
    await request(created.id as string, 'confirmed');

    const res = await patchType(created.id as string, { isLinear: true });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toBe(
      'У типа есть заявки в работе (2): сначала закройте их — иначе заявка сменит режим документооборота на ходу',
    );

    // Отказ обязан быть до записи: иначе признак уехал бы в базу, а человек увидел бы ошибку.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-types/${created.id}`,
      headers: ctx.auth,
    });
    expect(after.json().isLinear).toBe(false);

    // Остальные поля того же типа правятся: запрет держит признак, а не всю запись.
    const renamed = await patchType(created.id as string, { name: 'Занятый тип' });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('новые, закрытые, отменённые и архивные заявки смене не мешают', async () => {
    const created = await createType();
    await request(created.id as string, 'new');
    await request(created.id as string, 'done');
    await request(created.id as string, 'cancelled');
    // Архивная — та же «в работе», но удалённая: работой она уже не является (ADR 0070).
    await request(created.id as string, 'confirmed', { deleted: true });

    const res = await patchType(created.id as string, { isLinear: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().isLinear).toBe(true);
  });

  it('признак того же значения запрет не поднимает: менять нечего', async () => {
    const created = await createType({ isLinear: true });
    await request(created.id as string, 'confirmed');

    const res = await patchType(created.id as string, { isLinear: true, name: 'Тот же признак' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().isLinear).toBe(true);
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.update');
  });
});
