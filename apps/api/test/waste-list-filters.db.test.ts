import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Фильтры рабочего списка заявок на вывоз: вид предмета целиком («все контейнеры», «все
 * самосвалы») и период подачи.
 *
 * Зачем база. Оба отбора живут в SQL и оба легко ошибаются молча: вид спрашивается подзапросом по
 * справочнику, а не колонкой самой заявки, и промах здесь возвращает не отказ, а пустую или
 * лишнюю выдачу — то есть ответ «таких заявок нет», который человек примет за правду. Считается
 * тем же условием и `total`, в чьём запросе справочник не присоединён, — расхождение видно только
 * на настоящем ответе маршрута.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-list-filters
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `db-waste-filters-admin-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
/** Код с «яя» в начале — чтобы объект не стал первым у соседних тестов, берущих `LIMIT 1`. */
const OBJECT_CODE = `яя-waste-filters-${RUN}`;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
  contTypeId: string;
  truckTypeId: string;
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
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
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

/**
 * Заявка прямой вставкой: проверяется отбор, а не форма. Установка несёт контейнер, вывоз —
 * самосвал из заявок, заведённых до ADR 0022, либо не несёт предмета вовсе.
 */
async function newRequest(over: {
  requestType: 'container_install' | 'waste_removal';
  containerTypeId?: string;
  deliveryAt: Date;
}): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: over.requestType,
      containerTypeId: over.containerTypeId ?? null,
      deliveryAt: over.deliveryAt,
      volumeM3: over.requestType === 'waste_removal' ? 8 : null,
      status: 'confirmed',
      createdBy: ctx.adminId,
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: фильтры списка вывоза',
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

async function list(query: string): Promise<{ ids: string[]; total: number }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests?pageSize=200&objectId=${ctx.objectId}&${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { items: { id: string }[]; total: number };
  return { ids: body.items.map((r) => r.id), total: body.total };
}

describe.skipIf(!DB_URL)('вывоз: фильтры списка по виду предмета и периоду', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { hashPassword } = await import('../src/auth/password');

    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: 'Фильтровый',
        passwordHash: await hashPassword(PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: OBJECT_CODE,
        name: `Площадка фильтров ${RUN}`,
        address: 'г. Москва, тестовый проезд, 2',
      })
      .returning({ id: schema.constructionObjects.id });

    // Типы берутся из справочника, а не заводятся тестом: сид их и так кладёт (миграция 0006),
    // а лишняя строка справочника осталась бы видна соседним сценариям.
    const [cont] = await db
      .select({ id: schema.containerTypes.id })
      .from(schema.containerTypes)
      .where(sql`${schema.containerTypes.type} = 'cont'`)
      .limit(1);
    const [truck] = await db
      .select({ id: schema.containerTypes.id })
      .from(schema.containerTypes)
      .where(sql`${schema.containerTypes.type} = 'truck'`)
      .limit(1);

    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      schema,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      adminId: admin!.id,
      objectId: object!.id,
      contTypeId: cont!.id,
      truckTypeId: truck!.id,
    };
  }, 60_000);

  afterAll(async () => {
    if (!ctx) return;
    const admin = sql`(SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
    await ctx.db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${admin}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${OBJECT_CODE}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('вид предмета отбирает весь свой справочник и только его', async () => {
    const day = new Date('2026-03-10T07:00:00.000Z');
    const container = await newRequest({
      requestType: 'container_install',
      containerTypeId: ctx.contTypeId,
      deliveryAt: day,
    });
    const truck = await newRequest({
      requestType: 'waste_removal',
      containerTypeId: ctx.truckTypeId,
      deliveryAt: day,
    });
    // Заявка без предмета: у вывоза после ADR 0022 техники нет вовсе — ни в один вид она не
    // попадает, и «все самосвалы» не должны её подобрать заодно.
    const noSubject = await newRequest({ requestType: 'waste_removal', deliveryAt: day });

    const cont = await list('containerKind=cont');
    expect(cont.ids).toContain(container);
    expect(cont.ids).not.toContain(truck);
    expect(cont.ids).not.toContain(noSubject);

    const trucks = await list('containerKind=truck');
    expect(trucks.ids).toContain(truck);
    expect(trucks.ids).not.toContain(container);
    expect(trucks.ids).not.toContain(noSubject);

    // `total` считается отдельным запросом с тем же условием: разъедься они, страница показывала
    // бы одно число, а листалась по другому.
    expect(cont.total).toBe(cont.ids.length);
    expect(trucks.total).toBe(trucks.ids.length);
  });

  it('вид и позиция справочника сужают вместе, а не спорят', async () => {
    const day = new Date('2026-03-11T07:00:00.000Z');
    const container = await newRequest({
      requestType: 'container_install',
      containerTypeId: ctx.contTypeId,
      deliveryAt: day,
    });

    const same = await list(`containerKind=cont&containerTypeId=${ctx.contTypeId}`);
    expect(same.ids).toContain(container);

    // Пара из разных видов не бывает ни у одной заявки: пустая выдача здесь честна.
    const crossed = await list(`containerKind=truck&containerTypeId=${ctx.contTypeId}`);
    expect(crossed.ids).not.toContain(container);
    expect(crossed.total).toBe(0);
  });

  it('период отбирает по дате подачи, включая обе границы', async () => {
    const early = await newRequest({
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-04-01T07:00:00.000Z'),
    });
    const inside = await newRequest({
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-04-05T07:00:00.000Z'),
    });
    const late = await newRequest({
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-04-10T07:00:00.000Z'),
    });

    // Границы — моменты, как их считает портал: полночь МСК начального дня и конец последнего.
    const period = await list(
      'deliveryFrom=2026-04-04T21:00:00.000Z&deliveryTo=2026-04-05T20:59:59.999Z',
    );
    expect(period.ids).toContain(inside);
    expect(period.ids).not.toContain(early);
    expect(period.ids).not.toContain(late);

    // Заявка последнего дня входит в период, кончающийся этим днём: конец суток, а не полночь.
    const untilLate = await list('deliveryTo=2026-04-10T20:59:59.999Z');
    expect(untilLate.ids).toContain(late);

    const openEnded = await list('deliveryFrom=2026-04-05T21:00:00.000Z');
    expect(openEnded.ids).toContain(late);
    expect(openEnded.ids).not.toContain(inside);
  });
});
