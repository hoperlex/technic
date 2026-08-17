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
 * Разметка ТО у типа техники (план «Показания техники», Р13; миграция 0147) — на живой схеме,
 * через настоящие HTTP-пути.
 *
 * Колонка `vehicle_types.maintenance_basis` появилась вместе с расчётом обслуживания, но задать её
 * было неоткуда: ни в DTO, ни в схемах ручек, ни в форме справочника. У всех типов навсегда стояло
 * `none`, у всех машин — «ТО по пробегу не ведётся», и весь модуль обслуживания стоял мёртвым.
 *
 * Здесь живёт договор разметки: признак ездит через заведение, правится обычным `PATCH` (своего
 * протокола у него нет — в отличие от линейности, он ничего не переписывает у заявок в работе),
 * записывается в журнал своим действием — и, главное, доезжает до расчёта: сводка машины отвечает
 * `not_tracked` ровно до тех пор, пока тип не размечен.
 *
 * Зачем база. Проверяется не схема запроса, а путь «форма справочника → колонка → расчёт»: он идёт
 * через три модуля и разойтись может ровно на живой схеме.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run vehicle-type-maintenance-basis
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-maintenance-basis-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка своих машин: база у db-тестов общая, уборка идёт по ней. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: разметка ТО типа';
/** Свои типы: правка чужой строки справочника унесла бы с собой соседние тесты. */
const TYPE_CODE_PREFIX = 'zz_basis_test_';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  kindId: string;
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

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Механик',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/** Свой код на каждый заведённый тип: справочник общий, а прогонов у теста много. */
let typeNo = 0;
const nextCode = () => `${TYPE_CODE_PREFIX}${Date.now()}_${(typeNo += 1)}`;

async function createType(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: { kindId: ctx.kindId, code: nextCode(), name: 'Тип для разметки ТО', ...over },
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

/** Машина этого типа: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(typeId: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles (ownership, vehicle_type_id, status, note)
    VALUES ('own', ${typeId}, 'active', ${MARK})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Сводка ТО машины — тем же путём, которым её берёт портал. */
async function summaryOf(vehicleId: string): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-maintenance/vehicles/${vehicleId}/summary`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
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

describe.skipIf(!DB_URL)('разметка ТО у типа техники (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    // Вид ТС берётся из справочника: состав наполняют миграции, и зафиксированный здесь
    // идентификатор разошёлся бы с ними при первой правке.
    const kinds = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_kinds WHERE is_active ORDER BY sort_order, code LIMIT 1`,
    );
    const kind = kinds.rows[0];
    if (!kind) throw new Error('в базе нет вида ТС: миграции не применены');

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
      kindId: kind.id,
    };
  }, 120_000);

  afterAll(async () => {
    // За собой убираем: база у db-тестов общая, и заведённые здесь типы с машинами иначе видны
    // соседним файлам — круговому обмену справочников, отборам гаража, срезам. Порядок обратный
    // ссылкам: машины, потом типы. Учётка теста остаётся намеренно — на неё ссылается журнал
    // аудита, а `seedAdmin` переиспользует её при следующем прогоне.
    if (ctx?.db) {
      await ctx.db.execute(sql`DELETE FROM vehicles WHERE note = ${MARK}`);
      await ctx.db.execute(
        sql`DELETE FROM vehicle_types WHERE code LIKE ${`${TYPE_CODE_PREFIX}%`}`,
      );
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('признак ездит через заведение, а без него тип остаётся неразмеченным', async () => {
    const tracked = await createType({ maintenanceBasis: 'odometer' });
    expect(tracked.maintenanceBasis).toBe('odometer');

    // Умолчание безопасное: тип, заведённый без вопроса (старым клиентом, обменом справочников),
    // ТО ни с кого не требует.
    const plain = await createType();
    expect(plain.maintenanceBasis).toBe('none');

    // И то же значение приходит обратно списком, а не только ответом на создание: форма правки
    // читает тип оттуда, и пустое поле открывало бы галочку снятой у размеченного типа.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicle-types',
      headers: ctx.auth,
      query: { search: String(tracked.code), pageSize: '100' },
    });
    expect(list.statusCode, list.body).toBe(200);
    const found = (list.json().items as { id: string; maintenanceBasis: string }[]).find(
      (t) => t.id === tracked.id,
    );
    expect(found?.maintenanceBasis).toBe('odometer');
  });

  it('признак правится обычным PATCH — туда и обратно, своим действием журнала', async () => {
    const created = await createType();

    const on = await patchType(created.id as string, { maintenanceBasis: 'odometer' });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().maintenanceBasis).toBe('odometer');
    const audit = await lastAudit(created.id as string);
    expect(audit.action).toBe('vehicle_type.maintenance_basis');
    expect(audit.metadata).toMatchObject({
      oldMaintenanceBasis: 'none',
      newMaintenanceBasis: 'odometer',
    });

    // Выключение — такой же правкой: своего протокола с подтверждением у признака нет, потому что
    // он ничего не переписывает у заявок в работе (в отличие от линейности).
    const off = await patchType(created.id as string, { maintenanceBasis: 'none' });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().maintenanceBasis).toBe('none');

    // Правка соседнего поля признак не роняет и событием разметки не является.
    const renamed = await patchType(created.id as string, {
      name: 'Тип переименованный',
      maintenanceBasis: 'none',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().maintenanceBasis).toBe('none');
    expect((await lastAudit(created.id as string)).action).toBe('vehicle_type.update');
  });

  it('разметка доезжает до расчёта: сводка машины перестаёт отвечать «не ведётся»', async () => {
    const created = await createType();
    const vehicleId = await newVehicle(created.id as string);

    // Пока тип не размечен, вопроса про срок нет вовсе — это норма справочника, а не незнание.
    const before = await summaryOf(vehicleId);
    expect(before.maintenanceBasis).toBe('none');
    expect(before.state).toBe('not_tracked');

    const on = await patchType(created.id as string, { maintenanceBasis: 'odometer' });
    expect(on.statusCode, on.body).toBe(200);

    // После разметки вопрос появился, а ответа нет: показаний и актов у машины не заводили —
    // «неизвестно», и это уже повод разобраться, а не норма.
    const after = await summaryOf(vehicleId);
    expect(after.maintenanceBasis).toBe('odometer');
    expect(after.state).toBe('unknown');

    // И обратно: снятый признак возвращает машину к «не ведётся», ничего не удаляя.
    const off = await patchType(created.id as string, { maintenanceBasis: 'none' });
    expect(off.statusCode, off.body).toBe(200);
    expect((await summaryOf(vehicleId)).state).toBe('not_tracked');
  });

  it('чужого значения признак не принимает: список закрытый', async () => {
    const created = await createType();
    const res = await patchType(created.id as string, { maintenanceBasis: 'engine_hours' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('validation_error');
  });
});
