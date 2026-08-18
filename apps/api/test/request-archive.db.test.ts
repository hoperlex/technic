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
 * Архив заявок обоих модулей (ADR 0070) — на живой схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Проверять здесь нечего, кроме того, что решает схема, а не код: удаление заявки
 * насовсем опирается на каскады подчинённых таблиц (детали типа, история статусов, назначение) и
 * на `RESTRICT` со стороны рейсов и путевых листов. Контрактный тест этого не увидит — расходятся
 * не правила, а код и схема, и цена расхождения тут либо 500 на кнопке, либо снесённая заявка, на
 * которую ссылается выписанный документ.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5432/technic_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-request-archive-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
  vehicleTypeId: string;
  vehicleId: string;
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

/** Свой адрес на каждый запрос: вход ограничен попытками с одного IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * Заявка вывоза сразу в рабочем статусе: заводится строкой, а не формой. Форма создаёт «Новую», а
 * её удаление до архива не доходит вовсе (hard delete) — архив начинается с заявки, по которой уже
 * шла работа, и именно её надо получить.
 */
async function wasteRequest(): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_requests (object_id, request_type, delivery_at, status, created_by, comment)
    VALUES (${ctx.objectId}, 'waste_removal', now(), 'confirmed', ${ctx.adminId}, 'архивная')
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Заказ спецтехники в рабочем статусе — вместе с деталями типа: их снос каскадом и проверяем. */
async function vehicleRequest(): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle_requests (object_id, request_type, vehicle_type_id, status, created_by)
    VALUES (${ctx.objectId}, 'special_equipment', ${ctx.vehicleTypeId}, 'confirmed', ${ctx.adminId})
    RETURNING id`);
  const id = res.rows[0]!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from)
    VALUES (${id}, current_date)`);
  return id;
}

/** Удаление заявки обычной ручкой: рабочая заявка уходит в архив (soft delete). */
async function archive(module: 'waste-requests' | 'vehicle-requests', id: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/${module}/${id}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().mode).toBe('soft');
}

interface ListRow {
  id: string;
  deletedAt: string | null;
  deletedByName: string | null;
}

async function list(
  module: 'waste-requests' | 'vehicle-requests',
  query: string,
): Promise<ListRow[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/${module}?pageSize=500&${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as ListRow[];
}

describe.skipIf(!DB_URL)('архив заявок (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');

    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
    const adminId =
      existing?.id ??
      (
        await db
          .insert(schema.users)
          .values({
            email: ADMIN_EMAIL,
            lastName: 'Тестовый',
            firstName: 'Администратор',
            middleName: '',
            passwordHash: await hashPassword(ADMIN_PASSWORD),
            role: 'admin',
            isActive: true,
          })
          .returning({ id: schema.users.id })
      )[0]!.id;

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const types = await db.execute<{ id: string }>(sql`SELECT id FROM vehicle_types LIMIT 1`);
    const vehicles = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicles WHERE deleted_at IS NULL LIMIT 1`,
    );
    if (!objects.rows[0] || !types.rows[0] || !vehicles.rows[0]) {
      throw new Error(
        'В базе нет объектов, типов ТС или техники: миграции наполнения не применены',
      );
    }

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      adminId,
      objectId: objects.rows[0].id,
      vehicleTypeId: types.rows[0].id,
      vehicleId: vehicles.rows[0].id,
    };
  }, 120_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь каждый
       * случай заводит заявку — за прогон в ней оседало по полдесятка заказов техники и столько же
       * заявок на вывоз, и все в архиве, то есть невидимые в обычных списках.
       *
       * Метка — собственная учётка файла: всё, что тут заводится, заводит она. Списком заведённого
       * уборка не пользуется намеренно — прибирать надо и за упавшим прогоном, который до записи в
       * список мог не дойти. Саму учётку уборка не трогает: её `beforeAll` ищет по адресу и заводит
       * один раз на все прогоны.
       *
       * Порядок обратен ссылкам: рейс держит заказ ключом `restrict`. Детали, история и файлы
       * заявок уходят каскадом вместе с ними.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
      const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
      await ctx.db.execute(sql`
        DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_routes WHERE source_request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM waste_requests WHERE created_by IN (${ourUsers})`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('вкладка «Архив» показывает удалённые заявки вывоза и только их', async () => {
    const archived = await wasteRequest();
    const live = await wasteRequest();
    await archive('waste-requests', archived);

    const inArchive = await list('waste-requests', 'archive=only');
    expect(inArchive.map((r) => r.id)).toContain(archived);
    expect(inArchive.map((r) => r.id)).not.toContain(live);
    // Кто удалил — первый вопрос к строке архива, и ответ на него приходит вместе со списком.
    expect(inArchive.find((r) => r.id === archived)?.deletedByName).toBe('Тестовый Администратор');

    // Рабочий список архивную заявку не показывает: удаление вывело её из работы.
    const working = await list('waste-requests', '');
    expect(working.map((r) => r.id)).not.toContain(archived);
    expect(working.map((r) => r.id)).toContain(live);
  });

  it('вкладка «Архив» показывает удалённые заказы техники и только их', async () => {
    const archived = await vehicleRequest();
    const live = await vehicleRequest();
    await archive('vehicle-requests', archived);

    const inArchive = await list('vehicle-requests', 'archive=only');
    expect(inArchive.map((r) => r.id)).toContain(archived);
    expect(inArchive.map((r) => r.id)).not.toContain(live);
    expect(inArchive.find((r) => r.id === archived)?.deletedByName).toBe('Тестовый Администратор');

    const working = await list('vehicle-requests', '');
    expect(working.map((r) => r.id)).not.toContain(archived);
  });

  it('порядок в архиве задаётся временем удаления', async () => {
    const first = await wasteRequest();
    const second = await wasteRequest();
    await archive('waste-requests', first);
    await archive('waste-requests', second);

    const rows = await list('waste-requests', 'archive=only&sortBy=deletedAt&sortOrder=desc');
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
  });

  it('удаление насовсем сносит архивную заявку вывоза и оставляет реквизиты в журнале', async () => {
    const id = await wasteRequest();
    const [num] = (
      await ctx.db.execute<{ num: number }>(sql`SELECT num FROM waste_requests WHERE id = ${id}`)
    ).rows;
    await archive('waste-requests', id);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/waste-requests/${id}/purge`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    const left = await ctx.db.execute(sql`SELECT 1 FROM waste_requests WHERE id = ${id}`);
    expect(left.rows).toHaveLength(0);
    // По entityId после удаления искать уже нечего — номер обязан остаться в журнале: «куда
    // делась М-128» спрашивают именно так.
    const audit = await ctx.db.execute<{ metadata: { num?: number } }>(
      sql`SELECT metadata FROM audit_log
          WHERE action = 'waste_request.purge' AND entity_id = ${id} LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata.num).toBe(num!.num);
  });

  it('удаление насовсем уносит подчинённые строки заказа техники каскадом', async () => {
    const id = await vehicleRequest();
    // История статусов появляется от самого удаления и правок; деталь типа заведена вместе с
    // заявкой. И то, и другое обязано уйти вместе с ней, иначе purge упрётся в внешний ключ.
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_status_history
        (vehicle_request_id, from_status, to_status, changed_by)
      VALUES (${id}, 'new', 'confirmed', ${ctx.adminId})`);
    await archive('vehicle-requests', id);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/vehicle-requests/${id}/purge`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    for (const table of [
      sql`SELECT 1 FROM vehicle_requests WHERE id = ${id}`,
      sql`SELECT 1 FROM special_equipment_request_details WHERE request_id = ${id}`,
      sql`SELECT 1 FROM vehicle_request_status_history WHERE vehicle_request_id = ${id}`,
    ]) {
      expect((await ctx.db.execute(table)).rows).toHaveLength(0);
    }
  });

  it('заказ техники, за которым едет рейс, удалить насовсем нельзя', async () => {
    const id = await vehicleRequest();
    await archive('vehicle-requests', id);
    // Перегон держит заявку-основание `RESTRICT` (ADR 0057): документ уже выписан, и стирать
    // строку, на которую он ссылается, нельзя.
    await ctx.db.execute(sql`
      INSERT INTO vehicle_routes
        (vehicle_id, route_date, purpose, source_request_id, move_from, move_to, created_by)
      VALUES (${ctx.vehicleId}, current_date, 'delivery', ${id}, 'база', 'объект', ${ctx.adminId})`);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/vehicle-requests/${id}/purge`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(409);
    // Отказ называет, кто держит запись: без названия таблицы человеку нечего с ним делать.
    expect(res.json().message).toContain('рейсы');
    expect(
      (await ctx.db.execute(sql`SELECT 1 FROM vehicle_requests WHERE id = ${id}`)).rows,
    ).toHaveLength(1);
  });

  it('живую заявку удалить насовсем нельзя — сначала архив', async () => {
    const waste = await wasteRequest();
    const vehicle = await vehicleRequest();

    for (const [module, id] of [
      ['waste-requests', waste],
      ['vehicle-requests', vehicle],
    ] as const) {
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/${module}/${id}/purge`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('не в архиве');
    }
  });

  it('восстановление возвращает заявку из архива в рабочий список', async () => {
    const id = await wasteRequest();
    await archive('waste-requests', id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${id}/restore`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ deletedAt: null, deletedByName: null });
    expect((await list('waste-requests', 'archive=only')).map((r) => r.id)).not.toContain(id);
    expect((await list('waste-requests', '')).map((r) => r.id)).toContain(id);
  });

  it('восстановление возвращает заказ техники — в том числе с назначенной машиной', async () => {
    const id = await vehicleRequest();
    // Машина назначена намеренно: область возврата спрашивает и арендодателя, а он у заказа ТС
    // берётся с назначенной техники — без назначения та половина проверки не выполнялась бы вовсе.
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignments (request_id, vehicle_id, vehicle_type_id, assigned_by)
      VALUES (
        ${id},
        ${ctx.vehicleId},
        (SELECT vehicle_type_id FROM vehicles WHERE id = ${ctx.vehicleId}),
        ${ctx.adminId})`);
    await archive('vehicle-requests', id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${id}/restore`,
      headers: ctx.auth,
    });

    // Своей оси у администратора нет, и обе проверки области он проходит насквозь: возврат
    // отвечает тем же 200, что и до появления проверок.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ deletedAt: null });
    expect((await list('vehicle-requests', 'archive=only')).map((r) => r.id)).not.toContain(id);
    expect((await list('vehicle-requests', '')).map((r) => r.id)).toContain(id);
  });
});
