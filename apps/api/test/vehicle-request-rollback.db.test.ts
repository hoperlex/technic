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
 * Возврат заказа техники из «В работе» в «Новую»: что он стирает и что **бережёт** (ADR 0172).
 *
 * Живой схемой и настоящим HTTP-путём, потому что предмет проверки — не функция перехода
 * (`transitionResetsWork` проверен контрактными тестами), а последствие в самой строке заявки и
 * следующий за ним ход. Без базы обе главные проверки выродились бы в проверку заглушки:
 *
 * 1. **Виза остаётся в строке.** Прежде откат снимал `approved_by`/`approved_at` тем же UPDATE,
 *    что и статус, — и заявка возвращалась к состоянию «ждёт визы». Это и была та цена, ради
 *    которой правило переписано: заявку, откаченную вечером из-за поломки машины, до подписи
 *    руководителя строительства нельзя было отдать другой машине.
 * 2. **Ход за откатом открыт сразу.** Одного поля в ответе мало: в работу заявку пускает
 *    `transitionRequiresApproval`, и проверка «виза на месте» была бы лишь косвенной. Поэтому
 *    заявка тут же переводится обратно в работу — тем же диспетчером, без единого запроса к
 *    визирующему, и это и есть предъявляемая польза.
 * 3. **Предохранитель на месте.** Виза не вечная: правка откаченной заявки по существу тем, кто
 *    визировать не вправе, снимает её (`dropApproval`) — переписанный заказ согласовывают заново.
 *    Без этого случая первое обещание превратилось бы в «визу больше ничем не снять».
 *
 * Что здесь НЕ проверяется: стирание техники, факта и рейса. Оно не менялось, и у него свои
 * стражи; дублировать их значило бы платить за это временем каждого прогона.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test vehicle-request-rollback
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/*
 * Свои учётки у файла: база db-тестов общая и живёт между прогонами, а уборка опознаёт заведённое
 * по автору — общая учётка означала бы, что файл сносит чужие, ещё живые заказы.
 */
const ADMIN_EMAIL = 'db-rollback-admin@example.invalid';
/** Диспетчер: откат — его право (`requests.rollbackStatus`), а визы у него нет вовсе. */
const DISPATCHER_EMAIL = 'db-rollback-dispatcher@example.invalid';
const PASSWORD = 'db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { authorization: string };
  dispatcher: { authorization: string };
  objectId: string;
  vehicle: { id: string; typeId: string; categoryId: string | null };
  /** Машинист: на него перевод в работу выписывает недельные листы ЭСМ-2 (ADR 0060). */
  personId: string;
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

async function seedUser(email: string, role: 'admin' | 'dispatcher'): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${email}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email,
    lastName: 'Тестовый',
    firstName: role,
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role,
    isActive: true,
  });
}

type Request = {
  id: string;
  version: number;
  status: string;
  approvedAt: string | null;
  approvedByName: string | null;
  assignment: unknown;
  comment: string;
};

/** Заказ спецтехники на завтра: сегодняшний день не нужен, а завтрашний не спорит с бумагой. */
async function createRequest(comment: string): Promise<Request> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicle.typeId,
      vehicleCategoryId: ctx.vehicle.categoryId,
      dateFrom: shiftDateKey(ctx.today, 1),
      dateTo: shiftDateKey(ctx.today, 2),
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Request;
}

/** Виза руководителя строительства. Ставит её администратор: области у него нет, право есть. */
async function approve(r: Request): Promise<Request> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${r.id}/approval`,
    headers: ctx.admin,
    payload: { approved: true, version: r.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Request;
}

async function changeStatus(
  auth: { authorization: string },
  r: Request,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${r.id}/status`,
    headers: auth,
    payload: { version: r.version, ...payload },
  });
}

/** Взять заявку в работу назначенной машиной — ход, который открывает именно виза. */
async function takeToWork(auth: { authorization: string }, r: Request) {
  return changeStatus(auth, r, {
    status: 'confirmed',
    comment: '',
    assignment: {
      vehicleId: ctx.vehicle.id,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      driverPersonId: ctx.personId,
    },
  });
}

/** Виза в самой строке, а не только в ответе ручки: ответ собирает DTO, строку — транзакция. */
async function approvalRow(id: string): Promise<{ by: string | null; at: string | null }> {
  const rows = await ctx.db.execute<{ approved_by: string | null; approved_at: string | null }>(
    sql`SELECT approved_by, approved_at FROM vehicle_requests WHERE id = ${id}`,
  );
  const row = rows.rows[0]!;
  return { by: row.approved_by, at: row.approved_at };
}

/** Событий отзыва визы по заявке: возврат в «Новую» их больше не пишет. */
async function revokeEvents(id: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM audit_log
        WHERE entity_id = ${id} AND action = 'vehicle_request.approval_revoke'`,
  );
  return Number(rows.rows[0]!.n);
}

describe.skipIf(!DB_URL)('возврат заказа техники в «Новую» (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedUser(ADMIN_EMAIL, 'admin');
    await seedUser(DISPATCHER_EMAIL, 'dispatcher');

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };

    // Своя техника нелинейного типа: у линейного заказа своя механика дней и бумаги, и она к
    // визе отношения не имеет. Порядок по `id` — чтобы не бороться за одну машину с соседним
    // файлом, берущим «первую попавшуюся»: база у db-тестов общая.
    const vehicles = await db.execute<{ id: string; type_id: string; category_id: string | null }>(
      sql`
        SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
          AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
          AND vt.is_linear = false
        ORDER BY v.id ASC
        LIMIT 1`,
    );
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id DESC LIMIT 1`,
    );
    /*
     * Машинист берётся из справочника, а не заводится: своего человека файлу держать незачем — он
     * его не правит, а только называет в назначении, и заведённый оседал бы в общей базе. Имени и
     * специализации проверка не спрашивает вовсе (`assertRouteDriver`): ей довольно живой строки.
     */
    const persons = await db.execute<{ id: string }>(
      sql`SELECT id FROM persons WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
    );
    const vehicle = vehicles.rows[0];
    const object = objects.rows[0];
    const person = persons.rows[0];
    if (!vehicle || !object || !person) {
      throw new Error(
        'В базе нет своей спецтехники, объекта или человека: наполнение не применено',
      );
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      dispatcher: await login(DISPATCHER_EMAIL),
      objectId: object.id,
      vehicle: { id: vehicle.id, typeId: vehicle.type_id, categoryId: vehicle.category_id },
      personId: person.id,
      today: moscowDateKeyOf(new Date()),
    };
  }, 120_000);

  afterAll(async () => {
    try {
      if (!ctx?.db) return;
      /*
       * Уборка по автору заявок: всё здешнее заведено этими двумя учётками, а чужого под ними не
       * бывает. Списком заведённого не пользуемся намеренно — прибирать надо и за упавшим
       * прогоном, который до записи в список мог не дойти. Порядок обратен ссылкам: рейсы и их
       * состав держат заказ, детали и история уходят каскадом со своей головной строкой.
       */
      const ourUsers = sql`
        SELECT id FROM users WHERE email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL})`;
      const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE source_request_id IN (${ourRequests})
           OR id IN (SELECT waybill_id FROM waybill_requests WHERE request_id IN (${ourRequests}))
           OR route_id IN (SELECT id FROM vehicle_routes
                            WHERE source_request_id IN (${ourRequests}))`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_routes WHERE source_request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    } finally {
      await ctx?.app.close();
      await ctx?.closeDb();
    }
  }, 60_000);

  it('возврат в «Новую» бережёт визу — и заявка сразу годится обратно в работу', async () => {
    const request = await createRequest('ТЕСТ: откат бережёт визу');
    const approved = await approve(request);
    expect(approved.approvedAt).toBeTruthy();

    const confirmed = await takeToWork(ctx.dispatcher, approved);
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const rolled = await changeStatus(ctx.dispatcher, confirmed.json() as Request, {
      status: 'new',
      comment: 'Машина сломалась на выезде',
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
    const back = rolled.json() as Request;

    // Работа стёрта — и в этом откат не изменился.
    expect(back.status).toBe('new');
    expect(back.assignment).toBeNull();
    // А виза на месте: и в ответе, и в самой строке.
    expect(back.approvedAt).toBe(approved.approvedAt);
    const row = await approvalRow(request.id);
    expect(row.by).toBeTruthy();
    expect(row.at).toBeTruthy();
    // Отзыва визы не случилось — значит и события о нём быть не должно: журнал не место для
    // того, чего не было.
    expect(await revokeEvents(request.id)).toBe(0);

    // Главное следствие: диспетчер возвращает заявку в работу сам, ничего ни у кого не спрашивая.
    const again = await takeToWork(ctx.dispatcher, back);
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as Request).status).toBe('confirmed');
  }, 60_000);

  it('правка откаченной заявки по существу визу снимает — как и всякой другой', async () => {
    const request = await createRequest('ТЕСТ: предохранитель визы после отката');
    const approved = await approve(request);
    const confirmed = await takeToWork(ctx.dispatcher, approved);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const rolled = await changeStatus(ctx.dispatcher, confirmed.json() as Request, {
      status: 'new',
      comment: 'Ошиблись объектом',
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
    const back = rolled.json() as Request;
    expect(back.approvedAt).toBeTruthy();

    // Уточнение комментария сутью заказа не является: подписывают технику, срок и место.
    const commented = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}`,
      headers: ctx.dispatcher,
      payload: {
        requestType: 'special_equipment',
        version: back.version,
        comment: 'ТЕСТ: предохранитель визы после отката (уточнение)',
      },
    });
    expect(commented.statusCode, commented.body).toBe(200);
    expect((commented.json() as Request).approvedAt).toBe(back.approvedAt);

    // А срок — является: его и подписывали. Правит диспетчер, визировать он не вправе — виза
    // уходит, и заявка снова ждёт решения площадки.
    const moved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}`,
      headers: ctx.dispatcher,
      payload: {
        requestType: 'special_equipment',
        version: (commented.json() as Request).version,
        dateFrom: shiftDateKey(ctx.today, 3),
        dateTo: shiftDateKey(ctx.today, 4),
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((moved.json() as Request).approvedAt).toBeNull();
    // Отзыв визы правкой — событие: по журналу должно быть видно, почему заявка снова ждёт визы.
    expect(await revokeEvents(request.id)).toBe(1);
  }, 60_000);
});
