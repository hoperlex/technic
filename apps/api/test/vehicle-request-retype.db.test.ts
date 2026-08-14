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
 * Переоформление заявки в другой тип (ADR 0091) — на живой схеме, через настоящий HTTP-путь.
 *
 * Почему на базе, а не на правилах. Переоформление — единственное место модуля, где строка заявки
 * меняет **деталь**: одна таблица теряет строку, другая её получает, и обе половины держат CHECK'и,
 * которых код не видит (`vehicle_requests_customer_check`, `vehicle_requests_department_freight_check`).
 * Тест на правилах проверил бы схему тела и промолчал бы ровно там, где ошибка и живёт: заявка
 * отдела, переоформленная в заказ техники на объект, обязана переехать на площадку — иначе
 * транзакция падает ошибкой целостности, а человек видит пятисотку.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   createdb technic_retype_test && psql technic_retype_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;
 *     CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm'
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_retype_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует и требовать
 * не должен — иначе `pnpm test` перестанет работать там, где PostgreSQL не поднят.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'retype-admin@example.invalid';
/**
 * Диспетчер нужен ради визы: право визировать — у заказчика со стороны объекта (ADR 0025), и
 * снимается виза переоформлением ровно тогда, когда переоформляет **не** тот, кто мог бы её
 * поставить. Одним администратором эту развилку не проверить: у него право визы есть.
 */
const DISPATCHER_EMAIL = 'retype-dispatcher@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Верифицированный адрес: у грузоперевозки оба конца маршрута обязаны быть выбраны, а не набраны. */
const RESOLVED_ADDRESS = {
  source: 'resolved',
  fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
  fiasLevel: 8,
  geoLat: 55.75,
  geoLon: 37.61,
};

interface Classification {
  typeId: string;
  categoryId: string | null;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  dispatcherAuth: { authorization: string };
  /** Грузовая позиция классификатора: она одна годится обоим типам заявки. */
  freight: Classification;
  /** Позиция другого вида — ею проверяется отказ: экскаватор грузоперевозкой не станет. */
  special: Classification;
  objectId: string;
  departmentId: string;
  today: string;
}

let ctx: Ctx;

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

/** Учётки: справочники — объекты, отделы, классификатор — приходят миграциями наполнения. */
async function seedUsers(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  for (const [email, role] of [
    [ADMIN_EMAIL, 'admin'],
    [DISPATCHER_EMAIL, 'dispatcher'],
  ] as const) {
    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${email}`);
    if (existing) continue;
    await db.insert(schema.users).values({
      email,
      lastName: 'Тестовый',
      firstName: role === 'admin' ? 'Администратор' : 'Диспетчер',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    });
  }
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

/** Тело заказа техники на объект — с площадкой и сроком в один день. */
function specialPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestType: 'special_equipment',
    objectId: ctx.objectId,
    vehicleTypeId: ctx.freight.typeId,
    vehicleCategoryId: ctx.freight.categoryId,
    dateFrom: ctx.today,
    responsibleName: 'Петров Пётр Петрович',
    responsiblePhone: '+79990000001',
    comment: 'Вывоз грунта с площадки',
    ...over,
  };
}

/** Тело грузоперевозки — с маршрутом, грузом и контактами на обоих концах. */
function freightPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestType: 'freight_transport',
    objectId: ctx.objectId,
    vehicleTypeId: ctx.freight.typeId,
    vehicleCategoryId: ctx.freight.categoryId,
    scheduledAt: `${ctx.today}T09:00:00+03:00`,
    // Адреса, количество и контакты — у ездки, а не у заявки (Р2): у заявки с ездками `A→B` и
    // `A→C` «адрес разгрузки заявки» не существует. Одна ездка — то же, чем была пара полей.
    trips: [
      {
        fromLocation: 'г Москва, ул Тверская, д 1',
        toLocation: 'г Москва, ул Арбат, д 2',
        fromAddress: RESOLVED_ADDRESS,
        toAddress: RESOLVED_ADDRESS,
        volumeM3: 12,
        fromResponsibleName: 'Сидоров Сидор Сидорович',
        fromResponsiblePhone: '+79990000002',
        toResponsibleName: 'Кузнецов Кузьма Кузьмич',
        toResponsiblePhone: '+79990000003',
      },
    ],
    comment: 'Плиты перекрытия',
    ...over,
  };
}

async function createRequest(
  payload: Record<string, unknown>,
): Promise<{ id: string; version: number; num: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { id: body.id, version: body.version, num: body.num };
}

function retype(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.auth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${id}/request-type`,
    headers: auth,
    payload,
  });
}

describe.skipIf(!DB_URL)('переоформление заявки в другой тип (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedUsers();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    // Позиции классификатора берутся из справочника, а не пишутся руками: состав наполняют
    // миграции, и зафиксированный здесь идентификатор разошёлся бы с ними при первой правке.
    const pick = async (kind: string): Promise<Classification> => {
      const rows = await db.execute<{ type_id: string; category_id: string | null }>(sql`
        SELECT vt.id AS type_id,
               (SELECT c.id FROM vehicle_categories c
                 WHERE c.vehicle_type_id = vt.id AND c.is_active
                 ORDER BY c.sort_order LIMIT 1) AS category_id
        FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE vk.code = ${kind} AND vt.is_active AND vk.is_active
        ORDER BY vt.sort_order
        LIMIT 1`);
      const row = rows.rows[0];
      if (!row) throw new Error(`В справочнике нет активного типа ТС вида «${kind}»`);
      return { typeId: row.type_id, categoryId: row.category_id };
    };

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const departments = await db.execute<{ id: string }>(
      sql`SELECT id FROM departments WHERE is_active ORDER BY code LIMIT 1`,
    );
    const object = objects.rows[0];
    const department = departments.rows[0];
    if (!object || !department) {
      throw new Error('В базе нет объекта или отдела: миграции наполнения не применены');
    }

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: '' },
      dispatcherAuth: { authorization: '' },
      freight: await pick('freight_transport'),
      special: await pick('special_equipment'),
      objectId: object.id,
      departmentId: department.id,
      // Заявку заводят не раньше чем на сегодня (`isAllowedRequestDate`) — от этого дня и пляшем.
      today: moscowDateKeyOf(new Date()),
    };
    ctx.auth = await login(ADMIN_EMAIL);
    ctx.dispatcherAuth = await login(DISPATCHER_EMAIL);
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('заказ техники на объект становится грузоперевозкой: номер и файлы остаются, деталь меняется', async () => {
    const request = await createRequest(specialPayload());

    const res = await retype(request.id, { ...freightPayload(), version: request.version });

    expect(res.statusCode, res.body).toBe(200);
    const after = res.json();
    expect(after.requestType).toBe('freight_transport');
    // Заявка та же: номер — то, чем её называют в разговоре, и потерять его нельзя.
    expect(after.num).toBe(request.num);
    expect(after.status).toBe('new');
    expect(after.scheduledAt).toBeTruthy();
    expect(after.trips[0].fromLocation).toBe('г Москва, ул Тверская, д 1');
    expect(after.version).toBe(request.version + 1);
    // Деталь прежнего типа снята физически, а не оставлена «про запас».
    const details = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM special_equipment_request_details WHERE request_id = ${request.id}`,
    );
    expect(Number(details.rows[0]!.n)).toBe(0);
  });

  it('грузоперевозка отдела переезжает на площадку — иначе CHECK не пустит', async () => {
    const request = await createRequest(
      freightPayload({ objectId: undefined, departmentId: ctx.departmentId }),
    );

    const res = await retype(request.id, { ...specialPayload(), version: request.version });

    expect(res.statusCode, res.body).toBe(200);
    const after = res.json();
    expect(after.requestType).toBe('special_equipment');
    expect(after.objectId).toBe(ctx.objectId);
    expect(after.departmentId).toBeNull();
    expect(after.dateFrom).toBe(ctx.today);
  });

  /**
   * Задний ход переоформления (ADR 0101, Р29). До этой правки дверь пускала дату в прошлое молча:
   * правила «не раньше сегодня» у схемы нет намеренно, а ручка её не спрашивала — четвёртая дыра
   * того же рода, что заведение рейса и выписка листа.
   *
   * Проверяется именно **сдвиг**, а не «дата в прошлом»: переоформление, переносящее прежний срок
   * один в один, права не требует — иначе смена вида заказа заставляла бы двигать сам заказ.
   */
  it('переоформление в прошлое требует права и причины, а без сдвига проходит как прежде', async () => {
    const yesterday = shiftDateKey(ctx.today, -1);

    // Диспетчер (у него есть `waybills.correct`) без причины — отказ с кодом `reason`.
    const request = await createRequest(specialPayload());
    const noReason = await retype(
      request.id,
      {
        ...freightPayload({ scheduledAt: `${yesterday}T09:00:00+03:00` }),
        version: request.version,
      },
      ctx.dispatcherAuth,
    );
    expect(noReason.statusCode, noReason.body).toBe(422);

    // С причиной — проходит, и объяснение уходит в событие переоформления.
    const ok = await retype(
      request.id,
      {
        ...freightPayload({ scheduledAt: `${yesterday}T09:00:00+03:00` }),
        version: request.version,
        backdateReason: 'техника вышла вчера, вид заказа перепутали при заведении',
      },
      ctx.dispatcherAuth,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(moscowDateKeyOf(new Date(ok.json().scheduledAt))).toBe(yesterday);
    const events = await ctx.db.execute<{ metadata: Record<string, unknown> }>(
      sql`SELECT metadata FROM audit_log
          WHERE entity_id = ${request.id} AND action = 'vehicle_request.change_type'
          ORDER BY created_at DESC LIMIT 1`,
    );
    expect(events.rows[0]!.metadata).toMatchObject({ backdated: true });
  });

  it('переоформление без сдвига календаря права задним числом не спрашивает', async () => {
    // Заявка сегодняшняя, срок переезжает один в один — сдвига нет, и штаб переоформляет её сам.
    const request = await createRequest(specialPayload());
    const res = await retype(
      request.id,
      { ...freightPayload(), version: request.version },
      ctx.dispatcherAuth,
    );
    expect(res.statusCode, res.body).toBe(200);
  });

  it('переоформление пишется своим событием истории — с типом и полями обеих деталей', async () => {
    const request = await createRequest(specialPayload());
    const res = await retype(request.id, { ...freightPayload(), version: request.version });
    expect(res.statusCode, res.body).toBe(200);

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/history`,
      headers: ctx.auth,
    });
    expect(history.statusCode, history.body).toBe(200);
    const event = history.json().find((e: { kind: string }) => e.kind === 'typeChanged') as
      { changes: { field: string; from: string | null; to: string | null }[] } | undefined;
    expect(event, 'событие переоформления не найдено').toBeTruthy();
    const fields = event!.changes.map((c) => c.field);
    expect(fields[0]).toBe('requestType');
    // Срок работ ушёл в прочерк, момент подачи появился: по истории видно, что стало с заказом.
    expect(event!.changes).toContainEqual(expect.objectContaining({ field: 'dateFrom', to: '—' }));
    expect(fields).toContain('scheduledAt');
  });

  it('технику не грузового вида грузоперевозкой не заказать', async () => {
    const request = await createRequest(
      specialPayload({
        vehicleTypeId: ctx.special.typeId,
        vehicleCategoryId: ctx.special.categoryId,
      }),
    );

    const res = await retype(request.id, {
      ...freightPayload({
        vehicleTypeId: ctx.special.typeId,
        vehicleCategoryId: ctx.special.categoryId,
      }),
      version: request.version,
    });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toMatch(/грузовой техники/);
  });

  it('у закрытой заявки тип не меняют', async () => {
    const request = await createRequest(specialPayload());
    const cancelled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: { status: 'cancelled', comment: 'Заказ не понадобился', version: request.version },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const res = await retype(request.id, {
      ...freightPayload(),
      version: cancelled.json().version,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toMatch(/Новая/);
  });

  /**
   * Виза (ADR 0025): согласовывали не то, чем заявка стала. Снимается она у того, кто визировать
   * не вправе, — а визирующий подтверждает переоформление самим фактом правки.
   */
  it('виза снимается переоформлением, но не у того, кто мог бы её поставить', async () => {
    const request = await createRequest(specialPayload());
    const approved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/approval`,
      headers: ctx.auth,
      payload: { approved: true, version: request.version },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().approvedAt).toBeTruthy();

    const byDispatcher = await retype(
      request.id,
      { ...freightPayload(), version: approved.json().version },
      ctx.dispatcherAuth,
    );
    expect(byDispatcher.statusCode, byDispatcher.body).toBe(200);
    expect(byDispatcher.json().approvedAt).toBeNull();

    // Обратно — руками администратора, у которого право визы есть: она остаётся на месте.
    const again = await createRequest(specialPayload());
    const approvedAgain = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${again.id}/approval`,
      headers: ctx.auth,
      payload: { approved: true, version: again.version },
    });
    const byAdmin = await retype(again.id, {
      ...freightPayload(),
      version: approvedAgain.json().version,
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(byAdmin.json().approvedAt).toBeTruthy();
  });

  it('устаревшая версия отклоняется, как и у обычной правки', async () => {
    const request = await createRequest(specialPayload());
    const first = await retype(request.id, { ...freightPayload(), version: request.version });
    expect(first.statusCode, first.body).toBe(200);

    const stale = await retype(request.id, { ...specialPayload(), version: request.version });
    expect(stale.statusCode).toBe(409);
  });
});
