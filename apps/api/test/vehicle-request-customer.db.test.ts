import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, REQUEST_CUSTOMER_LOCKED_MESSAGE } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Заказчик заявки на технику — объект **или отдел** (ADR 0040) — на живой схеме, через настоящий
 * HTTP-путь (`docs/department-requests-plan.md`, этап 1: Р6, Р7, Р9а, Р10).
 *
 * Почему на базе, а не на правилах. Всё, что здесь проверяется, живёт на стыке трёх слоёв, и ни
 * один из них в одиночку ответа не даёт: виза считается **областью учётки** (её собирает запрос по
 * `user_departments`), заказчик держится CHECK'ами (`vehicle_requests_customer_check`), а порядок
 * «Заказчика» — выражением SQL, у которого две половины пары лежат в разных join'ах. Тест на
 * правилах проверил бы схему тела и промолчал бы ровно там, где ошибка и живёт: заявка отдела с
 * визой чужого объекта, сводка по всем отделам сразу над списком одного и заявки отдела, уехавшие
 * в конец сортировки с `NULL`.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test vehicle-request-customer
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует и требовать
 * не должен — иначе `pnpm test` перестанет работать там, где PostgreSQL не поднят.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/*
 * Адреса свои у файла, а не общий `db-test@`: уборка опознаёт заведённое по автору, и общая учётка
 * означала бы, что файл сносит чужие, ещё живые заказы (та же беда, что и с общим СНИЛС,
 * см. `db-identity`).
 */
const ADMIN_EMAIL = 'db-request-customer-admin@example.invalid';
/** Офис: заводит заявку от лица отдела и правит её. Права визы у менеджера нет — она и проверяется. */
const MANAGER_EMAIL = 'db-request-customer-manager@example.invalid';
/** Визирующий со стороны отдела: право визы плюс отдел в области (ADR 0040, решение 2 плана). */
const HEAD_EMAIL = 'db-request-customer-head@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Метка справочных записей файла: по ней же он за собой и убирает. */
/*
 * Префикс сортируется **после** сидовых кодов (`dept_1`, `DIG-D-…`) намеренно: соседние db-тесты
 * берут заказчика первой строкой справочника (`ORDER BY code LIMIT 1`, `vehicle-request-retype`),
 * и фикстура, вставшая в начало, уезжала бы к ним в заявку — а этот файл её потом удаляет, и чужой
 * тест падал бы «Отдел не найден» через раз, в зависимости от порядка прогона.
 */
const FIXTURE_PREFIX = 'zz-customer-test';

/*
 * Наименования заказчиков заводятся под проверку порядка (Р10): «А» — отдел, «Б» — площадка,
 * «В» — второй отдел. Ряд намеренно чередует оси: сортировка по одной колонке объекта уводит обе
 * отдельские строки в конец с `NULL`, и такой ряд её ловит, а ряд «сначала объекты, потом отделы» —
 * нет.
 */
const HEAD_DEPARTMENT_NAME = 'Заказчик-А отдел (тест)';
const OBJECT_NAME = 'Заказчик-Б площадка (тест)';
const FOREIGN_DEPARTMENT_NAME = 'Заказчик-В отдел (тест)';

/**
 * Метка заявок алфавитного ряда — в комментарии, и её нет ни в наименовании площадки, ни в её коде:
 * поиск списка ищет по всем трём (`searchCondition`), и совпадение с площадкой затянуло бы в ряд
 * заявки соседних случаев.
 */
const SORT_MARK = 'алфавитный-ряд';

/** Верифицированный адрес: у грузоперевозки оба конца маршрута обязаны быть выбраны, а не набраны. */
const RESOLVED_ADDRESS = {
  source: 'resolved',
  fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
  fiasLevel: 8,
  geoLat: 55.75,
  geoLon: 37.61,
};

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  adminAuth: { authorization: string };
  managerAuth: { authorization: string };
  headAuth: { authorization: string };
  /** Грузовая позиция классификатора: отдел заказывает только грузоперевозки (ADR 0040). */
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  objectId: string;
  /** Отдел визирующего — его область. */
  headDepartmentId: string;
  /** Отдел, которого у визирующего в области нет. */
  foreignDepartmentId: string;
  /** Пара отделов под сводку: свои, чтобы цифры не зависели от заявок остальных случаев. */
  summaryDepartmentId: string;
  summaryOtherDepartmentId: string;
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

/** Учётки файла: три роли — офис без визы, офис с визой вне оси и визирующий отдела. */
async function seedUsers(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  for (const [email, role, firstName] of [
    [ADMIN_EMAIL, 'admin', 'Администратор'],
    [MANAGER_EMAIL, 'manager', 'Менеджер'],
    [HEAD_EMAIL, 'department_head', 'Руководитель'],
  ] as const) {
    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${email}`);
    if (existing) continue;
    await db.insert(schema.users).values({
      email,
      lastName: 'Тестовый',
      firstName,
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    });
  }
}

/**
 * Справочные записи файла — заново на каждый прогон: их наименования участвуют в проверке порядка,
 * и остатки упавшего прогона встали бы в тот же ряд вторыми такими же. Заявки убираются первыми —
 * их ключи на площадку и отделы стоят `restrict`; связи учёток с отделом уходят каскадом за самим
 * отделом, поэтому сами учётки уборка не трогает: их `beforeAll` заводит один раз на все прогоны.
 */
async function resetFixtures(): Promise<void> {
  const { db } = await import('../src/db/client');
  const ourUsers = sql`
    SELECT id FROM users WHERE email IN (${ADMIN_EMAIL}, ${MANAGER_EMAIL}, ${HEAD_EMAIL})`;
  await db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN (${ourUsers})`);
  // Журнал — по автору: писали в него только здешние учётки, а видов записей у них несколько.
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
  await db.execute(sql`DELETE FROM departments WHERE code LIKE ${`${FIXTURE_PREFIX}-%`}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`${FIXTURE_PREFIX}-%`}`);
}

async function createDepartment(suffix: string, name: string): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO departments (code, name)
    VALUES (${`${FIXTURE_PREFIX}-${suffix}`}, ${name})
    RETURNING id`);
  return rows.rows[0]!.id;
}

async function createObject(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${`${FIXTURE_PREFIX}-OBJ`}, ${OBJECT_NAME}, ${'г Москва, ул Тестовая, д 1'})
    RETURNING id`);
  return rows.rows[0]!.id;
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

/** Тело грузоперевозки: заказчик — объект либо отдел, остальное заведомо годное. */
function freightPayload(
  customer: { objectId?: string; departmentId?: string },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestType: 'freight_transport',
    ...customer,
    vehicleTypeId: ctx.vehicleTypeId,
    vehicleCategoryId: ctx.vehicleCategoryId,
    scheduledAt: `${ctx.today}T09:00:00+03:00`,
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

interface Created {
  id: string;
  version: number;
  approvedAt: string | null;
  objectId: string | null;
  departmentId: string | null;
}

async function createRequest(
  payload: Record<string, unknown>,
  auth = ctx.managerAuth,
): Promise<Created> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: auth,
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Created;
}

function patchRequest(
  id: string,
  payload: Record<string, unknown>,
  auth = ctx.managerAuth,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: auth,
    payload: { requestType: 'freight_transport', ...payload },
  });
}

function setApproval(
  id: string,
  version: number,
  auth: { authorization: string },
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${id}/approval`,
    headers: auth,
    payload: { approved: true, version },
  });
}

describe.skipIf(!DB_URL)('заказчик заявки: отдел наравне с площадкой (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedUsers();
    await resetFixtures();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const app = await buildApp();

    // Позиция классификатора берётся из справочника, а не пишется руками: состав наполняют
    // миграции, и зафиксированный здесь идентификатор разошёлся бы с ними при первой правке.
    const types = await db.execute<{ type_id: string; category_id: string | null }>(sql`
      SELECT vt.id AS type_id,
             (SELECT c.id FROM vehicle_categories c
               WHERE c.vehicle_type_id = vt.id AND c.is_active
               ORDER BY c.sort_order LIMIT 1) AS category_id
      FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport' AND vt.is_active AND vk.is_active
      ORDER BY vt.sort_order
      LIMIT 1`);
    const type = types.rows[0];
    if (!type)
      throw new Error('В справочнике нет активного грузового типа ТС: миграции не применены');

    const headDepartmentId = await createDepartment('A', HEAD_DEPARTMENT_NAME);
    const [head] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${HEAD_EMAIL}`);
    // Область визирующего — связью с отделом: её и читает принципал (`departmentIdsExpr`).
    // Признак `is_head` здесь намеренно не ставится: доступ считается правом и осью, а не им
    // (ADR 0040, решение 2 плана), и тест обязан проверять ровно то правило, что стоит в коде.
    await db.insert(schema.userDepartments).values({
      userId: head!.id,
      departmentId: headDepartmentId,
      isHead: false,
    });

    ctx = {
      app,
      db,
      closeDb,
      adminAuth: { authorization: '' },
      managerAuth: { authorization: '' },
      headAuth: { authorization: '' },
      vehicleTypeId: type.type_id,
      vehicleCategoryId: type.category_id,
      objectId: await createObject(),
      headDepartmentId,
      foreignDepartmentId: await createDepartment('B', FOREIGN_DEPARTMENT_NAME),
      summaryDepartmentId: await createDepartment('S1', 'Заказчик сводки (тест)'),
      summaryOtherDepartmentId: await createDepartment('S2', 'Заказчик сводки, второй (тест)'),
      // Заявку заводят не раньше чем на сегодня (`minVehicleRequestDateKey`) — от этого дня и пляшем.
      today: moscowDateKeyOf(new Date()),
    };
    ctx.adminAuth = await login(ADMIN_EMAIL);
    ctx.managerAuth = await login(MANAGER_EMAIL);
    ctx.headAuth = await login(HEAD_EMAIL);
  }, 120_000);

  afterAll(async () => {
    // Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь каждый
    // случай заводит заказ — за прогон в ней оседало бы по десятку заказов вместе с деталями,
    // ездками и историей, да ещё и с площадкой и отделами, которые лезут в чужие подборы.
    if (ctx?.db) await resetFixtures();
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('менеджер заводит грузоперевозку от лица отдела — и она ждёт визы', async () => {
    const request = await createRequest(
      freightPayload({ departmentId: ctx.headDepartmentId }, { comment: 'Мебель в офис' }),
    );

    expect(request.departmentId).toBe(ctx.headDepartmentId);
    expect(request.objectId).toBeNull();
    // Право визы у менеджера отсутствует вовсе, но проверяется здесь не оно: заявку от лица отдела
    // визирует отдел, а не тот, кто её оформил (ADR 0032, решение 4 плана).
    expect(request.approvedAt).toBeNull();
  });

  it('руководитель отдела визирует заявку своего отдела, а чужого — нет', async () => {
    const own = await createRequest(freightPayload({ departmentId: ctx.headDepartmentId }));
    const approved = await setApproval(own.id, own.version, ctx.headAuth);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().approvedAt).toBeTruthy();

    // Отдел вне области — не «не видит», а «не решает»: право визы у роли есть, и отказ обязан
    // приходить от области, иначе виза расползлась бы по всем отделам компании.
    const foreign = await createRequest(freightPayload({ departmentId: ctx.foreignDepartmentId }));
    const denied = await setApproval(foreign.id, foreign.version, ctx.headAuth);
    expect(denied.statusCode, denied.body).toBe(403);
  });

  /**
   * Р6 (крит К1). До этой правки `editChangesSubstance` сравнивал один `objectId`: перенос заявки
   * с площадки на отдел проходил мимо неё, и виза руководителя строительства, который об отделе
   * ничего не решал, оставалась на месте.
   */
  it('перенос завизированной «Новой» заявки с площадки на отдел снимает визу', async () => {
    const request = await createRequest(freightPayload({ objectId: ctx.objectId }));
    // Визирует администратор: право визы у него есть, а области нет вовсе — он и ставит визу там,
    // где отвечать за площадку некому (решение 4 плана).
    const approved = await setApproval(request.id, request.version, ctx.adminAuth);
    expect(approved.statusCode, approved.body).toBe(200);

    const moved = await patchRequest(request.id, {
      departmentId: ctx.headDepartmentId,
      version: approved.json().version,
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().departmentId).toBe(ctx.headDepartmentId);
    expect(moved.json().objectId).toBeNull();
    expect(moved.json().approvedAt).toBeNull();
  });

  /**
   * Обратная сторона того же правила (Р6): правка тем, кто эту заявку и визирует, визу не снимает —
   * он подтверждает изменение самим фактом правки. Заодно проверяется, что присланный **тот же**
   * заказчик существенной правкой не считается.
   */
  it('правка самим визирующим визу сохраняет', async () => {
    const request = await createRequest(freightPayload({ departmentId: ctx.headDepartmentId }));
    const approved = await setApproval(request.id, request.version, ctx.headAuth);
    expect(approved.statusCode, approved.body).toBe(200);

    // Час подачи — существенная правка (ADR 0025): не будь исключения для визирующего, виза сошла бы.
    const edited = await patchRequest(
      request.id,
      {
        departmentId: ctx.headDepartmentId,
        scheduledAt: `${ctx.today}T11:00:00+03:00`,
        version: approved.json().version,
      },
      ctx.headAuth,
    );

    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().approvedAt).toBeTruthy();
  });

  /**
   * Р7 (крит К2). Заявка в работе: объект затрат уже ушёл снимком в строки задания путевого листа,
   * а виза правкой не снимается (ADR 0044) — перенос заказчика дал бы заявку отдела с визой чужого
   * объекта. Обе половины правила в одном случае: то же значение проходит, другое — 422.
   */
  it('у заявки в работе заказчика не меняют, а правка с тем же заказчиком проходит', async () => {
    const request = await createRequest(freightPayload({ departmentId: ctx.headDepartmentId }));
    /*
     * Статус ставится строкой, а не переводом через ручку: перевод в работу тянет за собой
     * назначенную машину, водителя и рейс, и отказ пришёл бы из другого места. Проверяется здесь
     * запрет по **статусу**, и всё, что до него, — обвязка.
     */
    await ctx.db.execute(
      sql`UPDATE vehicle_requests SET status = 'confirmed' WHERE id = ${request.id}`,
    );

    const same = await patchRequest(request.id, {
      departmentId: ctx.headDepartmentId,
      comment: 'Уточнили телефон получателя',
      version: request.version,
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().departmentId).toBe(ctx.headDepartmentId);

    const moved = await patchRequest(request.id, {
      objectId: ctx.objectId,
      version: same.json().version,
    });
    expect(moved.statusCode, moved.body).toBe(422);
    expect(moved.json().message).toBe(REQUEST_CUSTOMER_LOCKED_MESSAGE);
    // Отказ садится на то поле формы, которым заказчика и меняли, — иначе человек ищет его сам.
    expect(moved.json().fields).toHaveProperty('objectId');
  });

  /**
   * Р9а (крит К11). Сводка над таблицей обязана считать тот же список, что человек видит под ней:
   * фильтр по отделу сужает строки, и цифры без него остались бы по всем отделам сразу.
   */
  it('сводка при выбранном отделе считает только его заявки', async () => {
    await createRequest(freightPayload({ departmentId: ctx.summaryDepartmentId }));
    await createRequest(freightPayload({ departmentId: ctx.summaryDepartmentId }));
    await createRequest(freightPayload({ departmentId: ctx.summaryOtherDepartmentId }));

    const summary = async (departmentId: string) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-requests/summary?departmentId=${departmentId}`,
        headers: ctx.managerAuth,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Record<string, number>;
    };

    const own = await summary(ctx.summaryDepartmentId);
    expect(own.new).toBe(2);
    // «Ждут визы» — та же цифра под тем же сужением: заявку отдела, заведённую офисом, визирует отдел.
    expect(own.awaitingApproval).toBe(2);

    const other = await summary(ctx.summaryOtherDepartmentId);
    expect(other.new).toBe(1);
  });

  /**
   * Р10 (крит К3). Столбец называется «Заказчик», а сортировался он по одной колонке объекта:
   * заявки отдела уезжали в конец с `NULL`. Выражений два — своё у списка (`sortColumns`) и своё у
   * ленты (`feedSortExprs`), — и разъезжаются они молча, поэтому случая тоже два.
   */
  describe('сортировка «Заказчик» ставит площадки и отделы в один алфавитный ряд', () => {
    /** Заявки ряда: «А» — отдел, «Б» — площадка, «В» — отдел. Порядок ожидается именно такой. */
    let alphabet: string[] = [];

    beforeAll(async () => {
      const first = await createRequest(
        freightPayload({ departmentId: ctx.headDepartmentId }, { comment: `${SORT_MARK} первая` }),
      );
      const second = await createRequest(
        freightPayload({ objectId: ctx.objectId }, { comment: `${SORT_MARK} вторая` }),
      );
      const third = await createRequest(
        freightPayload(
          { departmentId: ctx.foreignDepartmentId },
          { comment: `${SORT_MARK} третья` },
        ),
      );
      alphabet = [first.id, second.id, third.id];
    });

    it('в списке заявок', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-requests?search=${encodeURIComponent(SORT_MARK)}&sortBy=objectName&sortOrder=asc`,
        headers: ctx.managerAuth,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().items.map((r: { id: string }) => r.id)).toEqual(alphabet);
    });

    it('в ленте раздела', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-requests/feed?search=${encodeURIComponent(SORT_MARK)}&sortBy=objectName&sortOrder=asc`,
        headers: ctx.managerAuth,
      });
      expect(res.statusCode, res.body).toBe(200);
      const ids = res
        .json()
        .items.map((row: { kind: string; order?: { id: string } }) => row.order?.id);
      expect(ids).toEqual(alphabet);
    });
  });
});
