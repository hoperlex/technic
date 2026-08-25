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
 * Завершение заявки на вывоз и журнал закрытых заявок — вкладка «История» (ADR 0135).
 *
 * Зачем база. Оба утверждения теста — про поведение НАСТОЯЩИХ маршрутов, а не про чистые функции
 * коридора (те проверяются в `contracts.test.ts` без базы):
 *
 * - завершение считает разбор бумаги по живым талонам заявки и отказывает, пока среди них есть
 *   неподтверждённый. Подменить сверку значило бы проверить подмену: вопрос стоит ровно в том,
 *   видит ли маршрут строки, лежащие в базе;
 * - рабочий список и журнал делят одни и те же строки по статусу, и делят их в SQL. Разъедься эти
 *   два отбора — заявка пропала бы из обоих списков разом либо стояла бы в обоих сразу, и увидеть
 *   это можно только на настоящей выдаче.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-history
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `db-waste-history-admin-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
/**
 * Код объекта с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-waste-history-${RUN}`;
const KEY_PREFIX = `db-waste-history-${RUN}/`;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
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

/** Заявка на вывоз в нужном статусе: заводится прямой вставкой — проверяем не форму, а цикл. */
async function newRequest(status: 'done' | 'confirmed' = 'done'): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date(),
      volumeM3: 8,
      status,
      createdBy: ctx.adminId,
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: журнал вывоза',
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

/**
 * Номер талона своей серией на каждый вызов: подтверждённый номер уникален в пределах перевозчика
 * (ADR 0114, Р17), а исполнителя тестовым заявкам не назначают — область у них общая, и второй
 * талон с тем же номером упёрся бы в `waste_tickets_number_unique`.
 */
let ticketNo = 0;

/** Талон в разборе: строка распознанного, которую человек ещё не подтверждал (ADR 0114, Р15). */
async function seedUnconfirmedTicket(requestId: string): Promise<void> {
  ticketNo += 1;
  const number = `${RUN}-${ticketNo}`;
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${KEY_PREFIX}${randomUUID()}`,
      filename: 'талон.pdf',
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  await ctx.db
    .insert(ctx.schema.requestFiles)
    .values({ requestId, fileId: file!.id, kind: 'ticket' });
  await ctx.db.insert(ctx.schema.wasteTicketFiles).values({
    fileId: file!.id,
    requestId,
    status: 'done',
    totalPages: 1,
    processedPages: 1,
  });
  await ctx.db.insert(ctx.schema.wasteTickets).values({
    requestId,
    seq: 1,
    numberRaw: `№ ${number}`,
    numberKey: number,
    numberFuzzy: number,
    volumeM3: '8.000',
    origin: 'ocr',
    status: 'unconfirmed',
  });
}

async function version(requestId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ version: ctx.schema.wasteRequests.version })
    .from(ctx.schema.wasteRequests)
    .where(sql`${ctx.schema.wasteRequests.id} = ${requestId}`);
  return row!.version;
}

async function changeStatus(
  requestId: string,
  status: string,
  extra: Record<string, unknown> = {},
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/waste-requests/${requestId}/status`,
    headers: ctx.auth,
    payload: { status, version: await version(requestId), ...extra },
  });
}

async function listIds(url: string): Promise<string[]> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: ctx.auth });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((r) => r.id);
}

describe.skipIf(!DB_URL)('вывоз: завершение заявки и журнал закрытых (ADR 0135)', () => {
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
        middleName: 'Журнальный',
        passwordHash: await hashPassword(PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: OBJECT_CODE,
        name: `Площадка журнала ${RUN}`,
        address: 'г. Москва, тестовый проезд, 1',
      })
      .returning({ id: schema.constructionObjects.id });

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
    };
  }, 60_000);

  afterAll(async () => {
    if (!ctx) return;
    const admin = sql`(SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
    await ctx.db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${admin}`);
    await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${OBJECT_CODE}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('выполненная заявка без бумаги в разборе завершается, и переход виден в истории', async () => {
    const id = await newRequest();
    const res = await changeStatus(id, 'completed');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('completed');

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/${id}/history`,
      headers: ctx.auth,
    });
    expect(history.statusCode, history.body).toBe(200);
    const entry = (history.json() as { toStatus: string | null; actorName: string | null }[]).find(
      (e) => e.toStatus === 'completed',
    );
    // Переход записан обычным порядком и с автором: завершал человек, а не выкат.
    expect(entry?.actorName).toContain('Тестовый');
  });

  it('неподтверждённый талон завершение не пускает и говорит, чего ждёт', async () => {
    const id = await newRequest();
    await seedUnconfirmedTicket(id);
    const res = await changeStatus(id, 'completed');
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toContain('не подтверждено талонов: 1');

    // Подтвердили — и тот же запрос проходит: отказ был про состояние бумаги, а не про права.
    await ctx.db.execute(sql`
      UPDATE waste_tickets SET status = 'confirmed', confirmed_by = ${ctx.adminId},
             confirmed_at = now()
       WHERE request_id = ${id}`);
    const second = await changeStatus(id, 'completed');
    expect(second.statusCode, second.body).toBe(200);
  });

  it('у завершённой заявки талоны больше не правятся — только после отката', async () => {
    const id = await newRequest();
    await seedUnconfirmedTicket(id);
    // Факт предъявлен: возврат в «Выполнена» идёт общим порядком закрытия, а закрытие без
    // вывезенного объёма портал не принимает (ADR 0035). У живой заявки он к этому моменту есть
    // всегда — «Выполнена» без факта не бывает.
    await ctx.db.insert(ctx.schema.wasteRequestCompletions).values({
      requestId: id,
      volumeM3: '8.000',
      completedBy: ctx.adminId,
    });
    await ctx.db.execute(sql`
      UPDATE waste_tickets SET status = 'confirmed', confirmed_by = ${ctx.adminId},
             confirmed_at = now()
       WHERE request_id = ${id}`);
    expect((await changeStatus(id, 'completed')).statusCode).toBe(200);

    const [ticket] = await ctx.db
      .select({ id: ctx.schema.wasteTickets.id })
      .from(ctx.schema.wasteTickets)
      .where(sql`${ctx.schema.wasteTickets.requestId} = ${id}`);
    const dismissed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${id}/tickets/${ticket!.id}/dismiss`,
      headers: ctx.auth,
      payload: {},
    });
    expect(dismissed.statusCode, dismissed.body).toBe(400);
    expect(dismissed.json().message).toContain('Заявка завершена');

    // Откат администратора открывает разбор заново — ровно тем же переходом, что и всюду.
    expect((await changeStatus(id, 'done')).statusCode).toBe(200);
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${id}/tickets/${ticket!.id}/dismiss`,
      headers: ctx.auth,
      payload: {},
    });
    expect(second.statusCode, second.body).toBe(200);
  });

  it('закрытые заявки уходят из рабочего списка в журнал', async () => {
    const working = await newRequest();
    const completed = await newRequest();
    const cancelled = await newRequest('confirmed');
    expect((await changeStatus(completed, 'completed')).statusCode).toBe(200);
    expect(
      (await changeStatus(cancelled, 'cancelled', { comment: 'Площадка отказалась' })).statusCode,
    ).toBe(200);

    const list = await listIds(`/api/v1/waste-requests?pageSize=200&objectId=${ctx.objectId}`);
    expect(list).toContain(working);
    expect(list).not.toContain(completed);
    expect(list).not.toContain(cancelled);

    const journal = await listIds(
      `/api/v1/waste-requests/history?pageSize=200&objectId=${ctx.objectId}`,
    );
    expect(journal).toEqual(expect.arrayContaining([completed, cancelled]));
    // «Выполнена» журналом не закрыта: по ней ещё разбирают талоны.
    expect(journal).not.toContain(working);

    const onlyCancelled = await listIds(
      `/api/v1/waste-requests/history?pageSize=200&status=cancelled&objectId=${ctx.objectId}`,
    );
    expect(onlyCancelled).toContain(cancelled);
    expect(onlyCancelled).not.toContain(completed);
  });

  it('статус чужой вкладки отклоняется обеими выдачами, а не отдаётся пустым списком', async () => {
    const closedInList = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests?status=completed',
      headers: ctx.auth,
    });
    expect(closedInList.statusCode, closedInList.body).toBe(400);
    expect(closedInList.json().message).toContain('История');

    const openInJournal = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/history?status=new',
      headers: ctx.auth,
    });
    expect(openInJournal.statusCode, openInJournal.body).toBe(400);
    expect(openInJournal.json().message).toContain('Заявки');
  });

  it('итог журнала считает закрытые заявки и вывезенное', async () => {
    const id = await newRequest();
    await ctx.db.insert(ctx.schema.wasteRequestCompletions).values({
      requestId: id,
      volumeM3: '12.000',
      pricePerM3: '100.00',
      totalCost: '1200.00',
      completedBy: ctx.adminId,
    });
    expect((await changeStatus(id, 'completed')).statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/history/summary?objectId=${ctx.objectId}`,
      headers: ctx.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const summary = res.json();
    expect(summary.total).toBe(summary.completed + summary.cancelled);
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    // Сумма и объём считаются по завершённым: отменённой заявке предъявлять нечего.
    expect(summary.totalCost).toBeGreaterThanOrEqual(1200);
    expect(summary.volumeM3).toBeGreaterThanOrEqual(12);
  });
});
