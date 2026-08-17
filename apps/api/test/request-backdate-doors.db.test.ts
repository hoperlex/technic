import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { issueRequestEsm2 } from './waybill-issue-helper';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Три двери к прошлому со стороны заявки (ADR 0101 п. 4, §1 плана — дыры 1 и 3).
 *
 * Соседний файл (`request-backdate.db.test.ts`) стережёт даты самой заявки; здесь — входы, которые
 * правило заднего числа обошло стороной, потому что двигают они не заявку, а работу по ней:
 *
 * - **выписка ЭСМ-2 по требованию** (`POST /:id/esm2`, ADR 0100 §6). Самая тяжёлая из трёх: она
 *   жжёт номер строгой отчётности. Сверка прошедшую неделю не выписывает без проверенного
 *   контекста, а ручная выдача шла мимо сверки вовсе — и бланк за неделю месячной давности
 *   рождался без права, без причины и без метки, то есть не попадал даже в фильтр «только
 *   коррекции». Эффективная дата у него по таблице §4 плана — `periodTo` недели;
 * - **перегон** (`POST /:id/relocations`) и **день линейного заказа** (`POST /:id/days/:date/route`)
 *   — рейсы на прошедшую дату. Номера они не расходуют, поэтому строки в журнале коррекций не
 *   заводят (§1 плана, уточнение этапа 7): спрашиваются право и причина, объяснение уходит в
 *   аудит события. Проверяется здесь ровно это — что право и причина спрошены, а операция не
 *   заведена.
 *
 * Зачем база. Предмет проверки — не предикат (его стерегут контрактные тесты), а сцепка правила с
 * правами субъекта: у менеджера `waybills.correct` нет вовсе, у диспетчера есть. Плюс то, чего на
 * правилах не увидеть: метка листа в живой схеме (`correction_reason` при пустом
 * `corrects_waybill_id`), строка `waybill_corrections` с видом `esm2`, её связь с заявкой и отбор
 * журнала по ссылке на операцию.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-doors-admin@example.invalid';
const DISPATCHER_EMAIL = 'db-doors-dispatcher@example.invalid';
const MANAGER_EMAIL = 'db-doors-manager@example.invalid';

/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды и наименования — с «яя», и это не шутка, а требование соседства: половина db-тестов берёт
 * объект и тип из справочника выражением `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча
 * увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-doors-${RUN}`;
const TYPE_PREFIX = `doors_${RUN}`;
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: двери заднего числа';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Три субъекта: администратор готовит, диспетчер правит прошлое, менеджеру оно закрыто. */
  admin: { authorization: string };
  dispatcher: { authorization: string };
  manager: { authorization: string };
  dispatcherId: string;
  objectId: string;
  vehicleId: string;
  driverId: string;
  linearTypeId: string;
  plainTypeId: string;
  today: string;
  /** Прошлая календарная неделя целиком: её конец — вчерашнее воскресенье при любом дне прогона. */
  pastFrom: string;
  pastTo: string;
  /** Конец срока заказов файла: неделя вперёд, чтобы в срок попали и прошлое, и сегодня. */
  dateTo: string;
}

let ctx: Ctx;

/** Что завёл этот файл: по этим спискам он за собой и убирает. */
const createdRequests: string[] = [];
const createdRoutes: string[] = [];

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

/** Учётка с ролью: права у трёх субъектов разные, и в этом весь смысл файла. */
async function seedUser(email: string, role: 'admin' | 'dispatcher' | 'manager'): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${email}`);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: role,
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Водитель рейсов и машинист листов: человек со специализацией «водитель». */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');

  const [person] = await db
    .insert(schema.persons)
    .values({
      lastName: 'Дверев',
      firstName: 'Тест',
      middleName: 'Задним',
      comment: PERSON_MARK,
    })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
  });
  return person!.id;
}

/** Своя площадка: чужую запись справочника тест не трогает, а свою убирает за собой. */
async function createObject(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка дверей заднего числа ${RUN}`}, 'г Москва, ул Задняя, д 1')
    RETURNING id`);
  return rows.rows[0]!.id;
}

/** Тип ТС: линейный ведётся днями и просит ЭСМ-2 руками, обычный — неделями и перегонами. */
async function createType(kindId: string, isLinear: boolean): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.admin,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
      name: `Ямобуры тестовые (двери, ${isLinear ? 'линейный' : 'обычный'} ${RUN})`,
      isLinear,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Заказ техники на объект, доведённый до работы. Срок начинается в прошлой неделе — иначе ни
 * прошедшей недели ЭСМ-2, ни прошедшего дня у заказа не будет вовсе, — и потому само заведение
 * идёт задним числом, с причиной и ключом (Р15).
 */
async function requestInProgress(
  typeId: string,
  options: { dateFrom?: string; machinist?: boolean } = {},
): Promise<{ id: string; version: number }> {
  const dateFrom = options.dateFrom ?? ctx.pastFrom;
  const backdated = dateFrom < ctx.today;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom,
      dateTo: ctx.dateTo,
      responsibleName: 'Дверев Пётр Сергеевич',
      responsiblePhone: '9007770801',
      ...(backdated
        ? { backdateReason: 'Техника вышла раньше, чем оформили заявку', operationId: uuid() }
        : {}),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();
  createdRequests.push(request.id as string);

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.admin,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.admin,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        // Машинист нужен обычному заказу — ему листы выписывает сама сверка; линейному он не
        // нужен вовсе: недели у него называет человек (ADR 0100 §5).
        ...(options.machinist ? { driverPersonId: ctx.driverId } : {}),
      },
      schedule: { requestType: 'special_equipment', dateFrom, dateTo: ctx.dateTo },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id as string, version: confirmed.json().version as number };
}

const linearInProgress = () => requestInProgress(ctx.linearTypeId);

interface Esm2Body {
  weekOf: string;
  version: number;
  reason?: string;
  operationId?: string;
}

/**
 * Выписка ЭСМ-2 — через общее рукопожатие (Р21а): у машиниста бывают пробелы в документах, и
 * сервер спрашивает подтверждение. Ответ отдаётся как есть — эта дверь проверяется отказами
 * (право, глубина, ключ операции), и помощник нужен ей лишь затем, чтобы снять рукопожатие.
 */
async function issueEsm2(
  auth: { authorization: string },
  requestId: string,
  body: Esm2Body,
): Promise<Awaited<ReturnType<typeof ctx.app.inject>>> {
  const { res } = await issueRequestEsm2({
    app: ctx.app,
    headers: auth,
    requestId,
    expectIssued: false,
    payload: {
      weekOf: body.weekOf,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.driverId,
      version: body.version,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.operationId ? { operationId: body.operationId } : {}),
    },
  });
  return res;
}

interface SheetRow {
  id: string;
  status: string;
  period_to: string;
  correction_id: string | null;
  corrects_waybill_id: string | null;
  correction_reason: string;
}

/** Листы заявки как они лежат в журнале: действующие и сгоревшие, по неделям. */
async function sheetsOf(requestId: string): Promise<SheetRow[]> {
  const res = await ctx.db.execute<SheetRow>(sql`
    SELECT id, status, period_to::text, correction_id, corrects_waybill_id, correction_reason
    FROM waybills WHERE source_request_id = ${requestId}
    ORDER BY period_from, issued_at`);
  return res.rows;
}

/**
 * Операции, которых коснулась заявка (Р16): ими проверяется и след, и его отсутствие.
 *
 * Заведение самой заявки здесь не в счёт — оно тоже идёт задним числом (иначе прошедшей недели у
 * заказа не будет вовсе) и оставляет свою строку `request_date`. Предмет файла — двери, которые
 * открываются **после** заведения, и подмешивать к ним подготовку значило бы проверять соседний
 * тест вместо своего.
 */
async function correctionsOfRequest(requestId: string) {
  const res = await ctx.db.execute<{
    id: string;
    kind: string;
    reason: string;
    actor_user_id: string;
  }>(sql`
    SELECT c.id, c.kind, c.reason, c.actor_user_id
    FROM waybill_corrections c
    JOIN vehicle_request_corrections l ON l.correction_id = c.id
    WHERE l.request_id = ${requestId} AND c.kind <> 'request_date'
    ORDER BY c.created_at`);
  return res.rows;
}

function relocation(
  auth: { authorization: string },
  requestId: string,
  body: { routeDate: string; reason?: string },
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/relocations`,
    headers: auth,
    payload: {
      purpose: 'pickup',
      routeDate: body.routeDate,
      moveFrom: 'Объект, ул Задняя, д 1',
      moveTo: 'База, ул Автомобильная, д 3',
      ...(body.reason ? { reason: body.reason } : {}),
    },
  });
}

function planDay(
  auth: { authorization: string },
  requestId: string,
  date: string,
  body: { reason?: string } = {},
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: auth,
    payload: {
      newRoute: { vehicleId: ctx.vehicleId, driverPersonId: ctx.driverId },
      ...(body.reason ? { reason: body.reason } : {}),
    },
  });
}

/** Рейсы, заведённые заявкой: ими проверяется, что отказ ничего не завёл, — и ими же убираются. */
async function routesOf(requestId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    SELECT DISTINCT r.id FROM vehicle_routes r
    LEFT JOIN vehicle_route_requests rr ON rr.route_id = r.id
    WHERE r.source_request_id = ${requestId} OR rr.request_id = ${requestId}`);
  const ids = res.rows.map((row) => row.id);
  createdRoutes.push(...ids);
  return ids;
}

describe.skipIf(!DB_URL)('двери заднего числа со стороны заявки (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    await seedUser(ADMIN_EMAIL, 'admin');
    const dispatcherId = await seedUser(DISPATCHER_EMAIL, 'dispatcher');
    await seedUser(MANAGER_EMAIL, 'manager');

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

    // Своя машина из справочника: её наполняют миграции, и зафиксированный здесь идентификатор
    // разошёлся бы с ними при первой правке. Порядок по `id` — чтобы не бороться за одну и ту же
    // единицу с соседним файлом, берущим «первую попавшуюся».
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
      ORDER BY v.id
      LIMIT 1`);
    const vehicle = vehicles.rows[0];
    if (!vehicle) throw new Error('в базе нет своей активной техники: миграции не применены');

    const today = moscowDateKeyOf(new Date());
    const monday = weekStartKey(today);
    ctx = {
      app,
      db,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      dispatcher: await login(DISPATCHER_EMAIL),
      manager: await login(MANAGER_EMAIL),
      dispatcherId,
      objectId: await createObject(),
      vehicleId: vehicle.id,
      driverId: await seedDriver(),
      linearTypeId: '',
      plainTypeId: '',
      today,
      pastFrom: shiftDateKey(monday, -7),
      pastTo: shiftDateKey(monday, -1),
      dateTo: shiftDateKey(today, 7),
    };
    ctx.linearTypeId = await createType(vehicle.kind_id, true);
    ctx.plainTypeId = await createType(vehicle.kind_id, false);
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с бланками и рейсами
     * иначе видны соседним файлам. Порядок обратный ссылкам: сначала листы (они держат и рейс, и
     * заявку ключами `restrict`), потом операции коррекции, потом рейсы (состав уходит каскадом),
     * потом заявки, площадка, типы и люди. Учётки остаются намеренно — на них ссылается журнал
     * аудита, а `seedUser` переиспользует их при следующем прогоне.
     */
    if (ctx?.db) {
      const requests = sql.param(createdRequests);
      const routes = sql.param([...new Set(createdRoutes)]);
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE route_id = ANY(${routes}::uuid[]) OR source_request_id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM waybill_corrections
        WHERE id IN (
          SELECT correction_id FROM vehicle_request_corrections
          WHERE request_id = ANY(${requests}::uuid[]))`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM construction_objects
        WHERE code = ${OBJECT_CODE}
          AND id NOT IN (SELECT object_id FROM vehicle_requests WHERE object_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${PERSON_MARK}
          AND id NOT IN (SELECT driver_person_id FROM waybills)
          AND id NOT IN (
            SELECT driver_person_id FROM vehicle_routes WHERE driver_person_id IS NOT NULL)`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  describe('ЭСМ-2 по требованию за прошедшую неделю (дыра 3)', () => {
    it('без права — 403, без причины — 422, без ключа — 422, и ни один номер не сгорел', async () => {
      const request = await linearInProgress();
      const weekOf = ctx.pastFrom;

      // У менеджера `waybills.correct` нет вовсе: прошлое ему закрыто, сколько бы он ни объяснял.
      const forbidden = await issueEsm2(ctx.manager, request.id, {
        weekOf,
        version: request.version,
        reason: 'Машина отработала неделю',
        operationId: uuid(),
      });
      expect(forbidden.statusCode, forbidden.body).toBe(403);

      // У диспетчера право есть, но бланк за прошедшую неделю без объяснения не выписывается:
      // разрыв нумерации в журнале строгой отчётности обязан быть объяснён (Р35).
      const noReason = await issueEsm2(ctx.dispatcher, request.id, {
        weekOf,
        version: request.version,
        operationId: uuid(),
      });
      expect(noReason.statusCode, noReason.body).toBe(422);
      expect(noReason.json().message).toContain('причину');

      // Причина есть, ключа нет: повтор после обрыва связи сжёг бы второй номер (Р31).
      const noKey = await issueEsm2(ctx.dispatcher, request.id, {
        weekOf,
        version: request.version,
        reason: 'Машина отработала неделю',
      });
      expect(noKey.statusCode, noKey.body).toBe(422);
      expect(noKey.json().message).toContain('ключ');

      // Ни один отказ бумаги не завёл: номер серии цел, заявка без листов.
      expect(await sheetsOf(request.id)).toEqual([]);
      expect(await correctionsOfRequest(request.id)).toEqual([]);
    });

    it('с правом, причиной и ключом лист выписан, помечен коррекцией и оставил операцию', async () => {
      const request = await linearInProgress();
      const operationId = uuid();
      const reason = 'Машина отработала неделю, бланк выписываем по факту';

      const res = await issueEsm2(ctx.dispatcher, request.id, {
        weekOf: ctx.pastFrom,
        version: request.version,
        reason,
        operationId,
      });
      expect(res.statusCode, res.body).toBe(200);

      const [sheet, ...rest] = await sheetsOf(request.id);
      expect(rest).toEqual([]);
      expect(sheet!.status).toBe('issued');
      // Эффективная дата операции — конец недели (таблица §4 плана), и лист выписан именно за неё.
      expect(sheet!.period_to).toBe(ctx.pastTo);
      /*
       * Форма, которую Р35 и предусматривает: причина при **пустом** `corrects_waybill_id` —
       * заменять было нечего, лист рождён не взамен другого. Признак коррекции для фильтра (Р28)
       * считается по ссылке на операцию, а не по заменённому номеру.
       */
      expect(sheet!.correction_reason).toBe(reason);
      expect(sheet!.corrects_waybill_id).toBeNull();
      expect(sheet!.correction_id).not.toBeNull();

      const [correction, ...others] = await correctionsOfRequest(request.id);
      expect(others).toEqual([]);
      expect(correction!.kind).toBe('esm2');
      expect(correction!.reason).toBe(reason);
      expect(correction!.actor_user_id).toBe(ctx.dispatcherId);
      expect(sheet!.correction_id).toBe(correction!.id);
    });

    it('лист прошедшей недели виден в фильтре «только коррекции» и не виден в «без коррекций»', async () => {
      const request = await linearInProgress();
      const res = await issueEsm2(ctx.dispatcher, request.id, {
        weekOf: ctx.pastFrom,
        version: request.version,
        reason: 'Бланк за отработанную неделю',
        operationId: uuid(),
      });
      expect(res.statusCode, res.body).toBe(200);
      const sheet = (await sheetsOf(request.id))[0]!;

      // Отбор двусторонний: «что правилось задним числом» и «что шло обычным порядком» — два
      // разных вопроса, и один флаг на оба не отвечает (Р28). Журнал сужен днём листа и машиной:
      // база у db-тестов общая, и страница журнала целиком сюда не поместится.
      const journal = async (correction: 'true' | 'false') => {
        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/waybills?correction=${correction}&vehicleId=${ctx.vehicleId}&dateFrom=${ctx.pastFrom}&dateTo=${ctx.pastFrom}&pageSize=100`,
          headers: ctx.admin,
        });
        expect(list.statusCode, list.body).toBe(200);
        return (list.json().items as { id: string; isCorrection: boolean }[]).map((w) => w.id);
      };
      expect(await journal('true')).toContain(sheet.id);
      expect(await journal('false')).not.toContain(sheet.id);
    });

    it('повтор с тем же ключом возвращает тот же лист, а не жжёт второй номер', async () => {
      const request = await linearInProgress();
      const body: Esm2Body = {
        weekOf: ctx.pastFrom,
        version: request.version,
        reason: 'Бланк за отработанную неделю',
        operationId: uuid(),
      };

      // Ключ идемпотентности считается по **всему** телу, а рукопожатие его меняет (Р21а). Поэтому
      // повторять надо ровно то тело, которое сервер принял, — помощник его для этого и отдаёт.
      const { res: first, payload: accepted } = await issueRequestEsm2({
        app: ctx.app,
        headers: ctx.dispatcher,
        requestId: request.id,
        expectIssued: false,
        payload: {
          weekOf: body.weekOf,
          vehicleId: ctx.vehicleId,
          driverPersonId: ctx.driverId,
          version: body.version,
          reason: body.reason,
          operationId: body.operationId,
        },
      });
      expect(first.statusCode, first.body).toBe(200);
      const sheets = await sheetsOf(request.id);
      expect(sheets).toHaveLength(1);

      // Тело то же целиком, включая устаревшую версию: до проверки версии повтор не доходит —
      // ради этого ключ и заводили (Р31).
      const repeat = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-requests/${request.id}/esm2`,
        headers: ctx.dispatcher,
        payload: accepted,
      });
      expect(repeat.statusCode, repeat.body).toBe(200);
      expect(await sheetsOf(request.id)).toHaveLength(1);
      expect(await correctionsOfRequest(request.id)).toHaveLength(1);

      // Тот же ключ с другой командой — не повтор, а другая команда под чужим ключом.
      const другое = await issueEsm2(ctx.dispatcher, request.id, {
        ...body,
        weekOf: ctx.pastTo,
        version: repeat.json().version,
      });
      expect(другое.statusCode, другое.body).toBe(409);
    });

    it('лист текущей недели операцией не является: ни причины, ни ключа, ни метки', async () => {
      const request = await linearInProgress();

      // Неделя ещё идёт: `periodTo` у неё не раньше сегодня, и guard отвечает «обычная работа».
      const res = await issueEsm2(ctx.dispatcher, request.id, {
        weekOf: ctx.today,
        version: request.version,
      });
      expect(res.statusCode, res.body).toBe(200);

      const [sheet] = await sheetsOf(request.id);
      expect(sheet!.correction_id).toBeNull();
      expect(sheet!.correction_reason).toBe('');
      expect(await correctionsOfRequest(request.id)).toEqual([]);
    });
  });

  describe('перегон прошедшим днём (дыра 1)', () => {
    it('без права — 403, без причины — 422, с причиной — рейс без строки операции', async () => {
      const request = await requestInProgress(ctx.plainTypeId, {
        dateFrom: ctx.today,
        machinist: true,
      });
      const yesterday = shiftDateKey(ctx.today, -1);

      const forbidden = await relocation(ctx.manager, request.id, {
        routeDate: yesterday,
        reason: 'Технику увезли в пятницу',
      });
      expect(forbidden.statusCode, forbidden.body).toBe(403);

      const noReason = await relocation(ctx.dispatcher, request.id, { routeDate: yesterday });
      expect(noReason.statusCode, noReason.body).toBe(422);
      expect(noReason.json().message).toContain('причину');

      // Ни один отказ рейса не завёл.
      expect(await routesOf(request.id)).toHaveLength(0);

      const ok = await relocation(ctx.dispatcher, request.id, {
        routeDate: yesterday,
        reason: 'Технику увезли в пятницу, в портал вносим в понедельник',
      });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().routeDate).toBe(yesterday);
      expect(await routesOf(request.id)).toHaveLength(1);

      /*
       * Строки операции у перегона нет намеренно (§1 плана, уточнение этапа 7): номера строгой
       * отчётности рейс не расходует, и операция без единого листа засоряла бы журнал коррекций.
       * Объяснение живёт в аудите заведения — там же, где у обычного рейса.
       */
      expect(await correctionsOfRequest(request.id)).toEqual([]);
      const audit = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
        SELECT metadata FROM audit_log
        WHERE action = 'vehicle_route.create' AND metadata->>'requestId' = ${request.id}
        ORDER BY created_at DESC LIMIT 1`);
      expect(audit.rows[0]!.metadata).toMatchObject({ backdated: true });
      expect(String(audit.rows[0]!.metadata.reason)).toContain('пятницу');
    });

    it('сегодняшний перегон причины не требует', async () => {
      const request = await requestInProgress(ctx.plainTypeId, {
        dateFrom: ctx.today,
        machinist: true,
      });
      const res = await relocation(ctx.manager, request.id, { routeDate: ctx.today });
      expect(res.statusCode, res.body).toBe(201);
      await routesOf(request.id);
    });
  });

  describe('день линейного заказа прошедшим числом (дыра 1)', () => {
    it('без права — 403, без причины — 422, с причиной — день в рейсе и след в аудите', async () => {
      const request = await linearInProgress();

      const forbidden = await planDay(ctx.manager, request.id, ctx.pastTo, {
        reason: 'Машина отработала день',
      });
      expect(forbidden.statusCode, forbidden.body).toBe(403);

      const noReason = await planDay(ctx.dispatcher, request.id, ctx.pastTo);
      expect(noReason.statusCode, noReason.body).toBe(422);
      expect(noReason.json().message).toContain('причину');

      // Ни один отказ рейса не завёл: номер «Р-» не сгорел.
      expect(await routesOf(request.id)).toHaveLength(0);

      const ok = await planDay(ctx.dispatcher, request.id, ctx.pastTo, {
        reason: 'Машина отработала день, в портал вносим по факту',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const day = (ok.json().items as { date: string; route: unknown }[]).find(
        (d) => d.date === ctx.pastTo,
      );
      expect(day!.route).not.toBeNull();
      expect(await routesOf(request.id)).toHaveLength(1);

      // Строки операции у планирования нет — по тому же правилу, что у перегона; объяснение
      // уходит в аудит события укладки в рейс.
      expect(await correctionsOfRequest(request.id)).toEqual([]);
      const audit = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
        SELECT metadata FROM audit_log
        WHERE action = 'vehicle_route.attach' AND metadata->>'requestId' = ${request.id}
        ORDER BY created_at DESC LIMIT 1`);
      expect(audit.rows[0]!.metadata).toMatchObject({ backdated: true, workDate: ctx.pastTo });
    });

    it('сегодняшний день планируется как прежде — без права и без причины', async () => {
      const request = await linearInProgress();
      const res = await planDay(ctx.manager, request.id, ctx.today);
      expect(res.statusCode, res.body).toBe(200);
      await routesOf(request.id);
    });
  });

  /**
   * Пятая дверь: доставка внутри перевода в работу (ADR 0101, Р29).
   *
   * Отдельная ручка перегона уже под правилом, но тот же рейс заводится полем `assignment.delivery`
   * при смене статуса — и без проверки правило обходилось бы одним движением. Причина спрашивается
   * ровно про дату перегона: сам перевод в работу происходит сегодня, и объяснять его нечем.
   */
  describe('доставка задним числом внутри перевода в работу', () => {
    /** Заявка, ждущая перевода в работу: та же подготовка, но без самого перехода. */
    async function approvedRequest(): Promise<{ id: string; version: number }> {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/vehicle-requests',
        headers: ctx.admin,
        payload: {
          requestType: 'special_equipment',
          objectId: ctx.objectId,
          vehicleTypeId: ctx.plainTypeId,
          dateFrom: ctx.today,
          dateTo: ctx.dateTo,
          responsibleName: 'Дверев Пётр Сергеевич',
          responsiblePhone: '9007770801',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const request = created.json();
      createdRequests.push(request.id as string);
      const approved = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${request.id}/approval`,
        headers: ctx.admin,
        payload: { approved: true, version: request.version },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      return { id: request.id as string, version: approved.json().version as number };
    }

    function confirmWithDelivery(
      auth: { authorization: string },
      request: { id: string; version: number },
      delivery: { routeDate: string; reason?: string },
    ): ReturnType<typeof ctx.app.inject> {
      return ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${request.id}/status`,
        headers: auth,
        payload: {
          status: 'confirmed',
          comment: '',
          version: request.version,
          assignment: {
            vehicleId: ctx.vehicleId,
            pricePerHour: null,
            pricePerShift: null,
            shiftHours: null,
            driverPersonId: ctx.driverId,
            delivery: {
              routeDate: delivery.routeDate,
              moveFrom: 'База, ул Автомобильная, д 3',
              moveTo: 'Объект, ул Задняя, д 1',
              ...(delivery.reason ? { reason: delivery.reason } : {}),
            },
          },
          schedule: {
            requestType: 'special_equipment',
            dateFrom: ctx.today,
            dateTo: ctx.dateTo,
          },
        },
      });
    }

    it('без права — 403, без причины — 422, с причиной — рейс заведён и объяснён', async () => {
      const noRight = await approvedRequest();
      const denied = await confirmWithDelivery(ctx.manager, noRight, { routeDate: ctx.pastFrom });
      expect(denied.statusCode, denied.body).toBe(403);
      // Отказ ничего не завёл: ни рейса, ни перехода — заявка осталась ждать.
      expect(await routesOf(noRight.id)).toEqual([]);

      const noReason = await confirmWithDelivery(ctx.dispatcher, noRight, {
        routeDate: ctx.pastFrom,
      });
      expect(noReason.statusCode, noReason.body).toBe(422);

      const ok = await confirmWithDelivery(ctx.dispatcher, noRight, {
        routeDate: ctx.pastFrom,
        reason: 'Технику привезли на площадку раньше, чем оформили заявку',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await routesOf(noRight.id)).length).toBe(1);

      // Строки операции у рейсовой двери нет (§1 плана, этап 7) — объяснение живёт в аудите
      // самого перехода: своего события у доставки нет, она родилась внутри него.
      expect(await correctionsOfRequest(noRight.id)).toEqual([]);
      const audit = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
        SELECT metadata FROM audit_log
        WHERE entity_id = ${noRight.id} AND action = 'vehicle_request.status'
        ORDER BY created_at DESC LIMIT 1`);
      expect(audit.rows[0]!.metadata).toMatchObject({ deliveryBackdated: true });
    });

    it('сегодняшняя доставка переводит в работу как прежде — без права и без причины', async () => {
      const request = await approvedRequest();
      const res = await confirmWithDelivery(ctx.manager, request, { routeDate: ctx.today });
      expect(res.statusCode, res.body).toBe(200);
      await routesOf(request.id);
    });
  });
});
