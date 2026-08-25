import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Клиентский гейт cutover (И5 плана `docs/assignment-periods-plan.md`): вызовы **старого** широкого
 * маршрута с датами срока.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. Переключение чтения разрешено только там, где живых клиентов старого пути не
 * осталось, и «не осталось» — измеримое утверждение. Меряет его журнал, а не счётчик процесса:
 * аттестация деплоя снимается через минуту после перезапуска контейнеров, и процессный счётчик
 * доказывал бы свежесть процесса, а не отсутствие клиентов. Значит проверять надо две вещи, и обе
 * на живой ручке: что запись появляется там, где срок **изменили**, и не появляется там, где
 * прислали те же даты, — иначе гейт не дошёл бы до нуля никогда, его держала бы всякая правка
 * комментария.
 *
 * Зачем база. Предмет — HTTP-обработчик и запись в `audit_log` в его транзакции. На правилах это не
 * проверить: условие живёт в маршруте, между двумя `UPDATE`, и ошибка здесь молчаливая — гейт
 * просто никогда не покажет ноль либо покажет его зря.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test assignment-legacy-gate
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const ADMIN_EMAIL = `legacy-gate-${randomUUID().slice(0, 8)}@test.local`;
const ADMIN_PASSWORD = 'Test-Password-1';

const TODAY = moscowDateKeyOf(new Date());

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: Record<string, string>;
  objectId: string;
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
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

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/** Заказ спецтехники на неделю вперёд: срок у него есть, и правят здесь именно его. */
async function createRequest(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      ...(ctx.vehicleCategoryId ? { vehicleCategoryId: ctx.vehicleCategoryId } : {}),
      dateFrom: shiftDateKey(TODAY, 1),
      dateTo: shiftDateKey(TODAY, 7),
      responsibleName: 'Прораб Тестовый',
      responsiblePhone: '9001234567',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const body = created.json();
  return { id: body.id as string, version: body.version as number };
}

const patch = (request: { id: string; version: number }, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}`,
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      version: request.version,
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      ...(ctx.vehicleCategoryId ? { vehicleCategoryId: ctx.vehicleCategoryId } : {}),
      dateFrom: shiftDateKey(TODAY, 1),
      dateTo: shiftDateKey(TODAY, 7),
      responsibleName: 'Прораб Тестовый',
      responsiblePhone: '9001234567',
      ...payload,
    },
  });

/** Записи гейта по конкретной заявке: адрес у них один — `entity_id`. */
async function gateRowsOf(requestId: string) {
  const { rows } = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE action = 'assignment.legacy_period_call' AND entity_id = ${requestId}
     ORDER BY created_at`);
  return rows;
}

describe.skipIf(!DB_URL)('клиентский гейт cutover: правки срока старым маршрутом (И5)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    const types = await db.execute<{ type_id: string; category_id: string | null }>(sql`
      SELECT vt.id AS type_id,
             (SELECT vc.id FROM vehicle_categories vc
               WHERE vc.vehicle_type_id = vt.id AND vc.is_active LIMIT 1) AS category_id
        FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE vk.code = 'special_equipment' AND vt.is_active
       LIMIT 1`);
    const type = types.rows[0];
    if (!type) throw new Error('В базе нет типа спецтехники: миграции наполнения не применены');

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY created_at LIMIT 1`,
    );
    const objectId = objects.rows[0]?.id;
    if (!objectId) throw new Error('В базе нет площадки: миграции наполнения не применены');

    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId,
      vehicleTypeId: type.type_id,
      vehicleCategoryId: type.category_id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    const ours = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN (${ours})`);
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ours})`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('правка, сдвинувшая срок, оставляет след — с обеими границами до и после', async () => {
    const request = await createRequest();
    const moved = await patch(request, { dateTo: shiftDateKey(TODAY, 9) });
    expect(moved.statusCode, moved.body).toBe(200);

    const rows = await gateRowsOf(request.id);
    expect(rows).toHaveLength(1);
    // Обе границы, и до, и после: по записи должно читаться, что именно двигали, — иначе гейт
    // говорит «кто-то ходил», а разобраться с этим клиентом нечем.
    expect(rows[0]!.metadata).toMatchObject({
      door: 'vehicle-requests/patch',
      before: { dateFrom: shiftDateKey(TODAY, 1), dateTo: shiftDateKey(TODAY, 7) },
      after: { dateFrom: shiftDateKey(TODAY, 1), dateTo: shiftDateKey(TODAY, 9) },
    });
  });

  it('правка с теми же датами следа не оставляет: форма присылает заявку целиком', async () => {
    const request = await createRequest();
    // Комментарий — и весь остальной набор полей ровно тот же, что был заведён.
    const edited = await patch(request, { comment: 'уточнение по телефону' });
    expect(edited.statusCode, edited.body).toBe(200);

    /*
     * Ноль записей — предмет этого случая, а не мелочь. Считай гейт «поле пришло», он никогда не
     * дошёл бы до нуля: портал присылает заявку целиком на каждой правке, и всякое уточнение
     * комментария читалось бы как живой клиент старой двери.
     */
    expect(await gateRowsOf(request.id)).toEqual([]);
  });

  it('счётчик гейта видит запись и держит окно в неделю', async () => {
    const { countLegacyPeriodCalls } = await import('../src/services/assignment-legacy-calls');
    const request = await createRequest();
    const before = await countLegacyPeriodCalls(ctx.db);

    const moved = await patch(request, { dateFrom: shiftDateKey(TODAY, 2) });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await countLegacyPeriodCalls(ctx.db)).toBe(before + 1);

    // Запись, состарившаяся за окно, гейта уже не держит: вопрос здесь «есть ли они сейчас», и
    // ответ обязан со временем возвращаться к нулю сам.
    await ctx.db.execute(sql`
      UPDATE audit_log SET created_at = now() - interval '8 days'
       WHERE action = 'assignment.legacy_period_call' AND entity_id = ${request.id}`);
    expect(await countLegacyPeriodCalls(ctx.db)).toBe(before);
  });

  it('пока гейт держат, сводка готовности не пускает к переключению', async () => {
    const { assignmentCutoverReadiness } = await import('../src/services/assignment-readiness');
    const request = await createRequest();
    const moved = await patch(request, { dateTo: shiftDateKey(TODAY, 10) });
    expect(moved.statusCode, moved.body).toBe(200);

    const readiness = await assignmentCutoverReadiness(ctx.db, {});
    const gate = readiness.obstacles.find((o) => o.kind === 'legacy_period_calls');
    expect(gate).toBeDefined();
    // Ярус окна, а не данных: снимается это препятствие выкатом клиента, а не прогоном бэкфилла.
    expect(gate!.tier).toBe('window');
    expect(gate!.count).toBeGreaterThan(0);
    expect(readiness.switchable).toBe(false);
  });
});
