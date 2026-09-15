import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * Журнал путевых листов площадке и отделу: область, её производный характер и все двери к бумаге
 * (ADR 0192).
 *
 * **Зачем этому файлу база.** Область листа — единственная в портале, которая не выражена колонкой:
 * своего заказчика у бланка нет вовсе, и считается она подзапросами — по талонам
 * (`waybill_requests` → `vehicle_requests`) и по заявке-основанию ЭСМ-2 (`source_request_id`).
 * Проверить такое на подменах нечем:
 *
 * 1. **смешанный лист** (талоны двух площадок) — это строки двух таблиц, и утверждение «виден тому,
 *    чей в нём хотя бы один талон» проверяемо только на настоящем `EXISTS`;
 * 2. **лист без заявок** (пустой бланк, рейс-перегон) отличается от чужого ничем, кроме отсутствия
 *    строк связи, — а отвечать на него портал обязан одинаково: «не найден»;
 * 3. **отдел** сравнивается сразу с двумя осями — своим отделом и площадками своих отделов
 *    (ADR 0062, ADR 0144), и вторая приходит подзапросом в `department_construction_objects`;
 * 4. **двери** к одному и тому же листу разные — список, карточка, печать, выгрузка, пачка и
 *    скачивание вложения, — и каждая ходит в базу своим запросом. Пропущенный предикат в любой из
 *    них не ошибка, а тишина: бумага чужой площадки просто отдаётся.
 *
 * **Чего файл не проверяет.** Матрицу выдачи и барьеры наборов без базы — `grants-contracts.test.ts`;
 * отбор, сортировку и отметки печати — `waybill-journal.db.test.ts`; состав каталога — страж
 * `grants-catalog.db.test.ts`.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_scope_test \
 *     npx vitest run test/waybill-scope.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: база общая, а коды объектов и адреса учёток обязаны быть своими. */
const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-waybill-scope-${RUN}`;
/**
 * Коды с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const CODE_PREFIX = `яя-WBSCOPE-${RUN}`;
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: область листов ${RUN}`;
/** Номера бланков — из заведомо свободного диапазона: серия общая с остальной базой. */
const WAYBILL_NUMBER_BASE = 920_000_000;

const TODAY = moscowDateKeyOf(new Date());

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  adminId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  vehicleId: string;
  personId: string;
}

let ctx: Ctx;
let seq = 0;
let waybillNo = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом файле не участвует: скачивание вложения проверяется до обращения к хранилищу —
  // решение о доступе принимается раньше, и чужой файл до него не доходит.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
  process.env.RATE_LIMIT_MAX ??= '100000';
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
 * Уборка своих строк. Порядок задан ссылками: листы и рейсы держат машину `RESTRICT`'ом, заявки
 * держат объект, объект держит связь с отделом.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const users = sql`(SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
  const marked = sql`(SELECT id FROM vehicles WHERE note = ${MARK})`;
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
  await db.execute(sql`DELETE FROM waybills WHERE vehicle_id IN ${marked}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE vehicle_id IN ${marked}`);
  await db.execute(
    sql`DELETE FROM vehicle_requests WHERE comment = ${MARK} OR created_by IN ${users}`,
  );
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${MARK}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM departments WHERE code LIKE ${`${CODE_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`);
}

// ── Подопытные ──

async function newObject(tag: string): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.constructionObjects)
    .values({
      code: `${CODE_PREFIX}-O${seq}-${tag}`,
      name: `Площадка ${tag} ${RUN}`,
      address: 'г. Москва, тестовый проезд, 1',
      isActive: true,
    })
    .returning({ id: ctx.schema.constructionObjects.id });
  return row!.id;
}

async function newDepartment(tag: string): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.departments)
    .values({ code: `${CODE_PREFIX}-D${seq}-${tag}`, name: `Отдел ${tag} ${RUN}`, isActive: true })
    .returning({ id: ctx.schema.departments.id });
  return row!.id;
}

/** Площадка отдела (ADR 0144) — прямой записью в таблицу связи. */
async function linkDepartmentObject(departmentId: string, objectId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.departmentConstructionObjects)
    .values({ departmentId, constructionObjectId: objectId });
}

/**
 * Набор «Путевые листы: просмотр и печать» держателю — тем же способом, каким его ставит галочкой
 * администратор в окне учётки (ADR 0119). Отсутствие набора в каталоге означает ненакатанную
 * миграцию, и сказать об этом лучше здесь, чем отказом 403 в середине проверки области.
 */
async function grantWaybillsView(userId: string): Promise<void> {
  const [grant] = await ctx.db
    .select({ id: ctx.schema.grants.id })
    .from(ctx.schema.grants)
    .where(eq(ctx.schema.grants.code, 'waybills_view'));
  if (!grant) {
    throw new Error(
      'В каталоге нет набора «Путевые листы: просмотр и печать»: миграция 0311 не накатана',
    );
  }
  await ctx.db.insert(ctx.schema.userGrants).values({ userId, grantId: grant.id });
}

async function newUser(
  tag: string,
  role: 'admin' | 'dispatcher' | 'site' | 'department',
  scope: { objectIds?: string[]; departmentIds?: string[]; grant?: boolean } = {},
): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      // Входа по паролю здесь нет: access-токен подписывается напрямую — предмет файла область, а
      // не вход, и argon2 на пяти учётках стоил бы секунд на пустом месте.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  for (const objectId of scope.objectIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userConstructionObjects)
      .values({ userId: row!.id, constructionObjectId: objectId });
  }
  for (const departmentId of scope.departmentIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userDepartments)
      .values({ userId: row!.id, departmentId, isHead: false });
  }
  if (scope.grant) await grantWaybillsView(row!.id);
  return row!.id;
}

/**
 * Заявка на технику: заказчиком либо объект, либо отдел — ровно одно из двух (ADR 0040).
 *
 * Тип заявки зависит от заказчика не по прихоти теста, а по схеме: у отдела бывают только
 * грузоперевозки (`vehicle_requests_department_freight_check`) — спецтехника выходит на площадку, а
 * площадки у отдела в этой оси нет.
 */
async function newRequest(customer: { objectId?: string; departmentId?: string }): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: customer.departmentId ? 'freight_transport' : 'special_equipment',
      objectId: customer.objectId ?? null,
      departmentId: customer.departmentId ?? null,
      vehicleTypeId: ctx.typeId,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  return row!.id;
}

/**
 * Рейс: у листа формы 4-П он обязателен (`waybills_form_source_check`). Грузовой (`freight`) —
 * именно у него заявки лежат СОСТАВОМ, а не колонкой основания (`vehicle_routes_source_request_check`),
 * и область такого листа считается ровно по талонам, ради чего файл и заведён.
 */
async function newRoute(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: ctx.vehicleId,
      routeDate: TODAY,
      purpose: 'freight',
      driverPersonId: ctx.personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  return row!.id;
}

/**
 * Лист 4-П с талонами перечисленных заявок. Пустой список — тот самый лист, у которого области нет
 * вовсе: рейс-перегон и пустой бланк выглядят в журнале так же.
 */
async function newWaybill(requestIds: string[]): Promise<string> {
  waybillNo += 1;
  const routeId = await newRoute();
  const [row] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.personId,
      issuedForDate: TODAY,
      routeId,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  let slot = 0;
  for (const requestId of requestIds) {
    slot += 1;
    await ctx.db.insert(ctx.schema.waybillRequests).values({ waybillId: row!.id, requestId, slot });
  }
  return row!.id;
}

/*
 * ЭСМ2-РАЗРЕЗ. Лист выписывается **отрезком внутри недели** — вторник плюс два дня, — а не неделей
 * от понедельника: после переключения чтения `period_from` это любой день срока, и фикстура
 * «понедельник плюс шесть» описывала бы форму листа, которой не бывает. На предмет файла границы не
 * влияют вовсе: область ЭСМ-2 считается по `source_request_id`, то есть по заявке-основанию, а не по
 * датам. Неделя остаётся только рамкой `waybills_period_check` — обе границы внутри одной
 * календарной недели.
 */
/** Недельный лист ЭСМ-2: рейса у него нет, а заявка-основание есть (миграция 0087). */
async function newEsm2(requestId: string): Promise<string> {
  waybillNo += 1;
  const from = shiftDateKey(weekStartKey(TODAY), 1);
  const [row] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.personId,
      issuedForDate: from,
      sourceRequestId: requestId,
      periodFrom: from,
      periodTo: shiftDateKey(from, 2),
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return row!.id;
}

/** Скан, подшитый к листу: предмет проверки — дверь `GET /files/:id/download`. */
async function attachFile(waybillId: string): Promise<string> {
  seq += 1;
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${EMAIL_PREFIX}/скан-${seq}.pdf`,
      filename: `скан-${seq}.pdf`,
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  await ctx.db.insert(ctx.schema.waybillFiles).values({ waybillId, fileId: file!.id });
  return file!.id;
}

// ── HTTP ──

async function headersOf(userId: string): Promise<{ authorization: string }> {
  const [row] = await ctx.db
    .select({ role: ctx.schema.users.role, authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  const token = await ctx.tokens.signAccessToken({
    sub: userId,
    role: row!.role,
    av: row!.authVersion,
  });
  return { authorization: `Bearer ${token}` };
}

/** Идентификаторы листов, которые журнал показал учётке. */
async function journalIds(userId: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/waybills?pageSize=100',
    headers: await headersOf(userId),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: { id: string }[] }).items.map((item) => item.id);
}

describe.skipIf(!DB_URL)('область журнала путевых листов (ADR 0192)', () => {
  /** Листы и учётки файла — заводятся один раз: ни одна проверка их не меняет. */
  let sitePerson = '';
  let siteWithoutGrant = '';
  let deptPerson = '';
  let dispatcher = '';
  let wbMine = '';
  let wbOther = '';
  let wbMixed = '';
  let wbEsm2Mine = '';
  let wbNoRequests = '';
  let wbDeptOwn = '';
  let wbDeptPlace = '';
  let fileOfMine = '';
  let fileOfOther = '';

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    const { buildApp: build } = await import('../src/app');
    await cleanup(db);

    const types = await db.execute<{ id: string }>(
      sql`SELECT vt.id FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' ORDER BY vt.code LIMIT 1`,
    );
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const series = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    if (!types.rows[0] || !organizations.rows[0] || !series.rows[0]) {
      throw new Error('В базе нет типа ТС, организации или серии бланков');
    }

    ctx = {
      app: await build(),
      db,
      schema,
      tokens,
      closeDb,
      adminId: '',
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series.rows[0].id,
      vehicleId: '',
      personId: '',
    };

    ctx.adminId = await newUser('admin', 'admin');
    const [person] = await db
      .insert(schema.persons)
      .values({ lastName: 'Листов', firstName: 'Водитель', middleName: 'Тестович', comment: MARK })
      .returning({ id: schema.persons.id });
    ctx.personId = person!.id;
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
      .returning({ id: schema.vehicles.id });
    ctx.vehicleId = vehicle!.id;

    const mine = await newObject('mine');
    const other = await newObject('other');
    const deptPlace = await newObject('deptplace');
    const department = await newDepartment('own');
    await linkDepartmentObject(department, deptPlace);

    sitePerson = await newUser('site', 'site', { objectIds: [mine], grant: true });
    siteWithoutGrant = await newUser('nogrant', 'site', { objectIds: [mine] });
    deptPerson = await newUser('dept', 'department', {
      departmentIds: [department],
      grant: true,
    });
    dispatcher = await newUser('disp', 'dispatcher');

    const reqMine = await newRequest({ objectId: mine });
    const reqOther = await newRequest({ objectId: other });
    const reqDeptOwn = await newRequest({ departmentId: department });
    const reqDeptPlace = await newRequest({ objectId: deptPlace });

    wbMine = await newWaybill([reqMine]);
    wbOther = await newWaybill([reqOther]);
    wbMixed = await newWaybill([reqMine, reqOther]);
    wbEsm2Mine = await newEsm2(reqMine);
    wbNoRequests = await newWaybill([]);
    wbDeptOwn = await newWaybill([reqDeptOwn]);
    wbDeptPlace = await newWaybill([reqDeptPlace]);
    fileOfMine = await attachFile(wbMine);
    fileOfOther = await attachFile(wbOther);
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await cleanup(ctx.db);
    await ctx.closeDb();
  });

  /**
   * Главное утверждение области: площадка видит бумагу своих заявок и не видит чужую. Смешанный
   * лист — здесь же, потому что он и есть решение Р2: рейс один, бумага одна, и режется она только
   * по живому.
   */
  it('площадка видит листы своих заявок, смешанный — целиком, чужой — никак', async () => {
    const seen = await journalIds(sitePerson);
    expect(seen).toEqual(expect.arrayContaining([wbMine, wbMixed, wbEsm2Mine]));
    expect(seen).not.toContain(wbOther);
    expect(seen).not.toContain(wbDeptOwn);
  });

  /**
   * Лист без единой заявки. Отдельной проверкой, а не строкой в предыдущей: это не «чужой лист», а
   * лист, у которого области нет ВООБЩЕ, — пустой бланк (ADR 0071) и рейс-перегон выглядят так же.
   * Площадке он не виден, диспетчерской виден: у роли без оси журнал не сужается ничем.
   */
  it('лист без заявок площадке не виден, а диспетчеру виден', async () => {
    expect(await journalIds(sitePerson)).not.toContain(wbNoRequests);
    const all = await journalIds(dispatcher);
    expect(all).toEqual(expect.arrayContaining([wbNoRequests, wbMine, wbOther, wbDeptOwn]));
  });

  /**
   * Отдел считается двумя осями сразу (решение Р3): свой отдел — заказчик заявки, и площадки своего
   * отдела — объект заявки. Ни одна из них не покрывает другую: у заявки отдела объекта нет вовсе,
   * у заявки площадки нет отдела.
   */
  it('отдел видит бумагу своего отдела и своих площадок, но не чужую', async () => {
    const seen = await journalIds(deptPerson);
    expect(seen).toEqual(expect.arrayContaining([wbDeptOwn, wbDeptPlace]));
    expect(seen).not.toContain(wbOther);
    expect(seen).not.toContain(wbMine);
  });

  /**
   * Двери к одиночному листу. Все отвечают 404, а не 403: «нет такого листа» и «этот лист не ваш»
   * обязаны звучать одинаково — иначе отказ подтверждает существование бумаги под известным
   * идентификатором.
   */
  it('карточка, выгрузка и печать чужого листа отвечают «не найден»', async () => {
    const headers = await headersOf(sitePerson);
    for (const url of [
      `/api/v1/waybills/${wbOther}`,
      `/api/v1/waybills/${wbOther}/export`,
      `/api/v1/waybills/${wbOther}/print`,
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
    }
    // Свой лист до области доходит: карточка отдаётся, а бланк собирается настоящим конвертером —
    // его в среде может не быть, поэтому здесь проверяется только карточка.
    const own = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${wbMine}`,
      headers,
    });
    expect(own.statusCode, own.body).toBe(200);
  });

  /**
   * Пачка печати. Чужой лист выпадает из сторожевой выборки и попадает в «не найдено» — то есть
   * ведёт себя как лист, удалённый из журнала между показом и печатью. Проверяется именно отказ
   * ВСЕЙ пачки: тихо напечатать остальное значило бы отдать неполный комплект, о чём узнали бы уже
   * у принтера.
   */
  it('пачка с чужим листом не печатается целиком', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/waybills/print-batch',
      headers: await headersOf(sitePerson),
      payload: { ids: [wbMine, wbOther] },
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  /**
   * Вложение листа — отдельная дверь в файловом слое, и до ADR 0192 она была открыта одним лишь
   * правом: скан чужого листа отдавался любому, кто знает идентификатор файла. Проверяется пара —
   * свой файл открывается, чужой нет, — потому что «закрыть всё» здесь так же неверно, как «открыть
   * всё»: держателю набора сканы своей бумаги обещаны решением Р4.
   */
  it('скан своего листа открывается, чужого — нет', async () => {
    const headers = await headersOf(sitePerson);
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/files/${fileOfOther}/download`,
      headers,
    });
    expect([403, 404]).toContain(foreign.statusCode);
    const own = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/files/${fileOfMine}/download`,
      headers,
    });
    // Своя бумага до запрета не доходит: дальше файл ищут в S3, которого у теста нет, — но это уже
    // не решение о доступе, и отказом «не ваш файл» оно быть не может.
    expect([403, 404]).not.toContain(own.statusCode);
  });

  /**
   * Право приходит НАБОРОМ, а не ролью: та же учётка без галочки в окне учётки журнала не видит
   * вовсе. Без этой проверки файл доказывал бы область, но не то, чем она включается.
   */
  it('без набора площадка не открывает журнал вовсе', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waybills',
      headers: await headersOf(siteWithoutGrant),
    });
    expect(res.statusCode, res.body).toBe(403);
  });
});
