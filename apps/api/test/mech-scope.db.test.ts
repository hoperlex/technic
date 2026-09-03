import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * Механизация: область, пара «отдел ↔ площадка», фильтры и барьеры правки (ADR 0152; план
 * `docs/mechanization-module-plan.md`, Р10, Р17, Р19, Р20).
 *
 * **Зачем этому файлу база.** Всё, что здесь проверяется, живёт не в чистых функциях, а в связке
 * «строка справочника → принципал → SQL-предикат → маршрут», и на подменах выглядит правильным:
 *
 * 1. **область** считается по одной колонке `object_id`, но набор площадок роли отдела приходит
 *    подзапросом в `department_construction_objects` (`departmentObjectIdsExpr`). Проверить
 *    «отдел не видит заявку на снятой площадке» без базы нечем: снятие — это удалённая строка
 *    таблицы связи, и ошибка здесь не отказ, а тишина;
 * 2. **пара «отдел A + площадка отдела B»** к области не сводится по построению: область
 *    отвечает объединением площадок ВСЕХ отделов учётки, и её проверка такую пару пропускает.
 *    Утверждение «область пройдена, а связь нет» проверяемо только на сотруднике, состоящем в
 *    обоих отделах, — то есть на настоящих строках `user_departments`;
 * 3. **активность половин пары** ни область, ни связь не фильтруют вовсе: `is_active` спрашивает
 *    сервис отдельным запросом, и без базы отличить «спросил» от «не спросил» нельзя;
 * 4. **барьеры правки и удаления** (Б1–Б3) считаются по ЗАПЕРТОЙ строке внутри транзакции, а
 *    состояние аренды — это четыре колонки факта и договорённости. Подменённая строка отвечала бы
 *    на вопрос теста, а вопрос стоит ровно в том, доходит ли запрос до настоящей;
 * 5. **фильтры заявителя** (Р20) — пара условий в SQL (`object_id = :id AND department_id IS
 *    NULL`), и разъедься она с фильтром площадки, обе заявки одной площадки слились бы в одну
 *    выдачу.
 *
 * **Чего файл не проверяет.** Цикл, переходы и гонки — `mech-cycle.db.test.ts`; вложения и
 * файловый ACL — `mech-files.db.test.ts`; виды событий истории — `mech-history.db.test.ts`;
 * матрицу прав и коридоры без базы — `permissions.test.ts` и `contracts.test.ts`.
 *
 * Запуск — как у остальных db-тестов (общая база, поимённо):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-scope.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: база общая, а коды объектов, отделов и адреса учёток уникальны. */
const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-scope-${RUN}`;
/**
 * Коды с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const CODE_PREFIX = `яя-MECHSCOPE-${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const PLANNED_TO = shiftDateKey(TODAY, 14);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  /** Площадки: место эксплуатации и ось области (Р17). */
  objects: {
    site: string;
    other: string;
    deptA: string;
    deptB: string;
    /** Площадка отдела A, которую с него снимут по ходу файла. */
    dropped: string;
    /** Активная при заведении и погашенная к дублированию. */
    fading: string;
    inactive: string;
    /** Площадка неактивного отдела: сама активна, а отдел — нет. */
    deadDept: string;
  };
  departments: { a: string; b: string; dead: string };
  users: {
    admin: string;
    manager: string;
    site: string;
    siteOther: string;
    /** Сотрудник обоих отделов — на нём и проверяется пара (Р17). */
    deptBoth: string;
    deptOnlyA: string;
  };
  lessorId: string;
}

let ctx: Ctx;
let seq = 0;

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
  process.env.MAIL_ENABLED = 'false';
  // Файл делает сотни запросов с одного адреса, а умолчание лимита — 300 в минуту.
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
 * Уборка своих строк. Порядок задан ссылками: сначала аудит (у него `entity_id` текстовый, ни
 * каскада, ни ключа), потом заявки (за ними каскадом история статусов и связи файлов), потом
 * учётки, отделы (за ними набор площадок) и только в конце объекты — их держит `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const emailLike = `${EMAIL_PREFIX}%`;
  const users = sql`(SELECT id FROM users WHERE email LIKE ${emailLike})`;
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
  await db.execute(sql`DELETE FROM mech_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emailLike}`);
  await db.execute(sql`DELETE FROM departments WHERE code LIKE ${`${CODE_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM counterparties WHERE comment = ${CODE_PREFIX}`);
}

// ── Подопытные ──

async function newObject(tag: string, isActive = true): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.constructionObjects)
    .values({
      code: `${CODE_PREFIX}-O${seq}-${tag}`,
      name: `Площадка ${tag} ${RUN}`,
      address: 'г. Москва, тестовый проезд, 1',
      isActive,
    })
    .returning({ id: ctx.schema.constructionObjects.id });
  return row!.id;
}

async function newDepartment(tag: string, isActive = true): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.departments)
    .values({ code: `${CODE_PREFIX}-D${seq}-${tag}`, name: `Отдел ${tag} ${RUN}`, isActive })
    .returning({ id: ctx.schema.departments.id });
  return row!.id;
}

/** Площадка отдела (ADR 0144) — прямой записью в таблицу связи: предмет файла не карточка отдела. */
async function linkDepartmentObject(departmentId: string, objectId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.departmentConstructionObjects)
    .values({ departmentId, constructionObjectId: objectId });
}

async function unlinkDepartmentObject(departmentId: string, objectId: string): Promise<void> {
  await ctx.db
    .delete(ctx.schema.departmentConstructionObjects)
    .where(
      and(
        eq(ctx.schema.departmentConstructionObjects.departmentId, departmentId),
        eq(ctx.schema.departmentConstructionObjects.constructionObjectId, objectId),
      ),
    );
}

async function newUser(
  tag: string,
  role: 'admin' | 'manager' | 'site' | 'department',
  scope: { objectIds?: string[]; departmentIds?: string[] } = {},
): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      // Входа по паролю в файле нет: access-токен подписывается напрямую — предмет проверки не
      // вход, а область, и argon2 на шести учётках стоил бы секунд на пустом месте.
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
  return row!.id;
}

// ── HTTP ──

type Headers = { authorization: string };

/**
 * Заголовок с access-токеном. Роль и версия доступа читаются из базы в момент выдачи; область
 * (`departmentObjectIds`) в токене не лежит вовсе — её принципал считает на каждом запросе, и
 * именно это позволяет снять площадку с отдела посреди файла.
 */
async function headersOf(userId: string): Promise<Headers> {
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

interface CreateInput {
  objectId: string;
  departmentId?: string;
  kindName?: string;
  plannedFrom?: string;
  plannedTo?: string;
}

function createRequest(headers: Headers, input: CreateInput) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/mech-requests',
    headers,
    payload: {
      objectId: input.objectId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      kindName: input.kindName ?? `Виброплита ${RUN}`,
      plannedFrom: input.plannedFrom ?? TODAY,
      plannedTo: input.plannedTo ?? PLANNED_TO,
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9261234567',
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: механизация, область',
    },
  });
}

/** Заявка, заведённая офисом: у менеджера области нет, и он заводит её на любую площадку. */
async function seedRequest(input: CreateInput): Promise<{ id: string; version: number }> {
  const res = await createRequest(await headersOf(ctx.users.manager), input);
  expect(res.statusCode, res.body).toBe(201);
  const dto = res.json();
  return { id: dto.id, version: dto.version };
}

function patchRequest(headers: Headers, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/mech-requests/${id}`,
    headers,
    payload,
  });
}

function changeStatus(headers: Headers, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/mech-requests/${id}/status`,
    headers,
    payload,
  });
}

function deleteRequest(headers: Headers, id: string, version: number) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/mech-requests/${id}?version=${version}`,
    headers,
  });
}

async function versionOf(id: string): Promise<number> {
  const [row] = await ctx.db
    .select({ version: ctx.schema.mechRequests.version })
    .from(ctx.schema.mechRequests)
    .where(eq(ctx.schema.mechRequests.id, id));
  return row!.version;
}

async function listIds(headers: Headers, query: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/mech-requests?pageSize=200&${query}`,
    headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((r) => r.id);
}

/**
 * Заявка, взятая в работу, но ещё не поданная («ждёт подачи», Р2). Единственное состояние после
 * «Новой», которое архивируется: у действующей аренды и у коррекции завершения удаления нет вовсе
 * (Б1), и подменить её ими значило бы проверять не тот барьер.
 */
async function seedAwaitingIssue(objectId: string): Promise<string> {
  const office = await headersOf(ctx.users.manager);
  const created = await seedRequest({ objectId });
  const res = await changeStatus(office, created.id, {
    status: 'confirmed',
    version: created.version,
    deal: { lessorId: ctx.lessorId, rate: 1200, rateUnit: 'hour' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return created.id;
}

/**
 * Заявка, взятая в работу и выданная сегодня, — то есть ДЕЙСТВУЮЩАЯ АРЕНДА (Р2). Ставится одним
 * переходом: договорённость приезжает вместе с «В работе», а дата выдачи — вместе с ней, если
 * техника уже на объекте.
 */
async function seedRunningRental(objectId: string): Promise<string> {
  const office = await headersOf(ctx.users.manager);
  const created = await seedRequest({ objectId });
  const res = await changeStatus(office, created.id, {
    status: 'confirmed',
    version: created.version,
    deal: { lessorId: ctx.lessorId, rate: 1200, rateUnit: 'hour' },
    actualFrom: TODAY,
  });
  expect(res.statusCode, res.body).toBe(200);
  return created.id;
}

/** Завершённая аренда: выдана и возвращена, факт предъявлен целиком (`done_check`). */
async function seedCompletedRental(objectId: string): Promise<string> {
  const office = await headersOf(ctx.users.manager);
  const id = await seedRunningRental(objectId);
  const res = await changeStatus(office, id, {
    status: 'done',
    version: await versionOf(id),
    completion: { actualFrom: TODAY, actualTo: TODAY, actualUnits: 8, finalCost: 9600 },
  });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

describe.skipIf(!DB_URL)('механизация: область, пара, фильтры и барьеры (ADR 0152)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    const app = await buildApp();
    ctx = {
      app,
      db,
      schema,
      tokens,
      closeDb,
      objects: {} as Ctx['objects'],
      departments: {} as Ctx['departments'],
      users: {} as Ctx['users'],
      lessorId: '',
    };
    // Упавший прогон обязан убираться следующим, а не копить площадки в общей базе.
    await cleanup(db);

    ctx.objects = {
      site: await newObject('site'),
      other: await newObject('other'),
      deptA: await newObject('deptA'),
      deptB: await newObject('deptB'),
      dropped: await newObject('dropped'),
      fading: await newObject('fading'),
      inactive: await newObject('inactive', false),
      deadDept: await newObject('deadDept'),
    };
    ctx.departments = {
      a: await newDepartment('A'),
      b: await newDepartment('B'),
      dead: await newDepartment('dead', false),
    };
    await linkDepartmentObject(ctx.departments.a, ctx.objects.deptA);
    await linkDepartmentObject(ctx.departments.a, ctx.objects.dropped);
    await linkDepartmentObject(ctx.departments.b, ctx.objects.deptB);
    await linkDepartmentObject(ctx.departments.dead, ctx.objects.deadDept);

    ctx.users = {
      admin: await newUser('admin', 'admin'),
      manager: await newUser('manager', 'manager'),
      site: await newUser('site', 'site', { objectIds: [ctx.objects.site] }),
      siteOther: await newUser('siteOther', 'site', { objectIds: [ctx.objects.other] }),
      deptBoth: await newUser('deptBoth', 'department', {
        departmentIds: [ctx.departments.a, ctx.departments.b],
      }),
      deptOnlyA: await newUser('deptOnlyA', 'department', {
        departmentIds: [ctx.departments.a],
      }),
    };

    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: `Арендодатель механизации ${RUN}`,
        // ИНН уникален среди живых: своя десятизначная серия на прогон.
        inn: String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10),
        comment: CODE_PREFIX,
        isActive: true,
      })
      .returning({ id: schema.counterparties.id });
    ctx.lessorId = lessor!.id;
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Область (Р10) ──

  it('объектная роль видит заявки своих площадок и не видит чужие', async () => {
    const mine = await seedRequest({ objectId: ctx.objects.site });
    const foreign = await seedRequest({ objectId: ctx.objects.other });
    const site = await headersOf(ctx.users.site);

    const ids = await listIds(site, '');
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(foreign.id);

    // Список чужую заявку прячет, а карточка обязана отказать: без проверки по строке её отдал бы
    // любой, кто угадал id.
    const card = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/mech-requests/${foreign.id}`,
      headers: site,
    });
    expect(card.statusCode, card.body).toBe(403);

    // Та же заявка у своей площадки открыта: отказ выше был про область, а не про роль вообще.
    const neighbour = await headersOf(ctx.users.siteOther);
    expect(await listIds(neighbour, '')).toContain(foreign.id);
  });

  it('роль отдела теряет заявку вместе со снятой с отдела площадкой', async () => {
    const onDropped = await seedRequest({
      objectId: ctx.objects.dropped,
      departmentId: ctx.departments.a,
    });
    const dept = await headersOf(ctx.users.deptOnlyA);
    expect(await listIds(dept, '')).toContain(onDropped.id);

    // Площадку сняли с отдела: область считается по ТЕКУЩЕМУ составу, а не по снимку на момент
    // заведения (Р17, следствие первое). Заявка остаётся, отдел её больше не видит.
    await unlinkDepartmentObject(ctx.departments.a, ctx.objects.dropped);

    expect(await listIds(dept, '')).not.toContain(onDropped.id);
    const card = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/mech-requests/${onDropped.id}`,
      headers: dept,
    });
    expect(card.statusCode, card.body).toBe(403);

    // А офису она по-прежнему видна и правима: пара не менялась, и перепроверять её незачем.
    const office = await headersOf(ctx.users.manager);
    const edited = await patchRequest(office, onDropped.id, {
      comment: 'Разбор постфактум',
      version: await versionOf(onDropped.id),
    });
    expect(edited.statusCode, edited.body).toBe(200);
  });

  // ── Пара «отдел ↔ площадка» (Р17) ──

  it('пара «отдел A + площадка отдела B» не проходит ни у сотрудника обоих отделов, ни у офиса', async () => {
    // Сотрудник только отдела A: площадка отдела B вне его области — отказ ещё до вопроса о паре.
    const onlyA = await createRequest(await headersOf(ctx.users.deptOnlyA), {
      objectId: ctx.objects.deptB,
      departmentId: ctx.departments.a,
    });
    expect(onlyA.statusCode, onlyA.body).toBe(403);

    // Сотрудник ОБОИХ отделов: площадка в объединении его площадок, то есть область пройдена, —
    // и ровно здесь пара обязана ответить сама. Иначе заявку оплатил бы не тот отдел.
    const both = await createRequest(await headersOf(ctx.users.deptBoth), {
      objectId: ctx.objects.deptB,
      departmentId: ctx.departments.a,
    });
    expect(both.statusCode, both.body).toBe(403);
    expect(both.json().message).toContain('не закреплена за этим отделом');

    // У офиса области нет вовсе — и правило про пару к ней не сводится: тот же отказ.
    const office = await createRequest(await headersOf(ctx.users.manager), {
      objectId: ctx.objects.deptB,
      departmentId: ctx.departments.a,
    });
    expect(office.statusCode, office.body).toBe(403);
    expect(office.json().message).toContain('не закреплена за этим отделом');

    // Своя пара проходит: отказ выше был про связь, а не про то, что отделу вообще нельзя.
    const own = await createRequest(await headersOf(ctx.users.deptBoth), {
      objectId: ctx.objects.deptA,
      departmentId: ctx.departments.a,
    });
    expect(own.statusCode, own.body).toBe(201);
  });

  it('пара сверяется при смене любой её половины у «Новой», а при правке соседнего поля — нет', async () => {
    const office = await headersOf(ctx.users.manager);
    const request = await seedRequest({
      objectId: ctx.objects.deptA,
      departmentId: ctx.departments.a,
    });

    const movedPlace = await patchRequest(office, request.id, {
      objectId: ctx.objects.deptB,
      version: await versionOf(request.id),
    });
    expect(movedPlace.statusCode, movedPlace.body).toBe(403);

    const movedDepartment = await patchRequest(office, request.id, {
      departmentId: ctx.departments.b,
      version: await versionOf(request.id),
    });
    expect(movedDepartment.statusCode, movedDepartment.body).toBe(403);

    // Соседнее поле — без вопросов к паре: правило стережёт момент НАЗНАЧЕНИЯ пары.
    const comment = await patchRequest(office, request.id, {
      comment: 'Уточнили место разгрузки',
      version: await versionOf(request.id),
    });
    expect(comment.statusCode, comment.body).toBe(200);
  });

  it('дублирование проверяет пару заново — это заведение новой заявки, а не копия строки', async () => {
    const office = await headersOf(ctx.users.manager);
    const source = await seedRequest({
      objectId: ctx.objects.deptA,
      departmentId: ctx.departments.a,
    });
    const good = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${source.id}/duplicate`,
      headers: office,
      payload: {},
    });
    expect(good.statusCode, good.body).toBe(201);

    // Площадку сняли с отдела уже после того, как исходную завели: копия — это новое заведение, и
    // пара у неё спрашивается заново.
    await unlinkDepartmentObject(ctx.departments.a, ctx.objects.deptA);
    const afterUnlink = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${source.id}/duplicate`,
      headers: office,
      payload: {},
    });
    expect(afterUnlink.statusCode, afterUnlink.body).toBe(403);
    expect(afterUnlink.json().message).toContain('не закреплена за этим отделом');
    // Связь возвращается: следующие тесты работают с этой парой как с рабочей.
    await linkDepartmentObject(ctx.departments.a, ctx.objects.deptA);
  });

  it('активность обеих половин пары спрашивается на каждом пути её назначения', async () => {
    const office = await headersOf(ctx.users.manager);

    // Заведение, неактивная площадка-заявитель: ни область, ни связь `is_active` не фильтруют, и
    // прямым запросом заявка ушла бы на погашенную площадку — портал бы этого не заметил.
    const onInactive = await createRequest(office, { objectId: ctx.objects.inactive });
    expect(onInactive.statusCode, onInactive.body).toBe(400);
    expect(onInactive.json().message).toContain('Площадка неактивна');

    // Заведение, площадка НЕАКТИВНОГО отдела: сама площадка жива, а отдел — нет.
    const deadDept = await createRequest(office, {
      objectId: ctx.objects.deadDept,
      departmentId: ctx.departments.dead,
    });
    expect(deadDept.statusCode, deadDept.body).toBe(400);
    expect(deadDept.json().message).toContain('Отдел неактивен');

    // Смена половины пары у «Новой» — тот же вопрос об активности.
    const request = await seedRequest({ objectId: ctx.objects.deptA });
    const moved = await patchRequest(office, request.id, {
      objectId: ctx.objects.inactive,
      version: await versionOf(request.id),
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.json().message).toContain('Площадка неактивна');

    // Дублирование: исходная заведена на живой площадке, а к моменту копии её погасили.
    const source = await seedRequest({ objectId: ctx.objects.fading });
    await ctx.db
      .update(ctx.schema.constructionObjects)
      .set({ isActive: false })
      .where(eq(ctx.schema.constructionObjects.id, ctx.objects.fading));
    const copy = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${source.id}/duplicate`,
      headers: office,
      payload: {},
    });
    expect(copy.statusCode, copy.body).toBe(400);
    expect(copy.json().message).toContain('Площадка неактивна');
  });

  it('подсказка видов не показывает виды из чужой области', async () => {
    const mineKind = `Виброплита-своя-${RUN}`;
    const foreignKind = `Компрессор-чужой-${RUN}`;
    await seedRequest({ objectId: ctx.objects.site, kindName: mineKind });
    await seedRequest({ objectId: ctx.objects.other, kindName: foreignKind });

    const kinds = async (headers: Headers, search: string): Promise<string[]> => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/mech-requests/kinds?search=${encodeURIComponent(search)}`,
        headers,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items as string[];
    };

    const site = await headersOf(ctx.users.site);
    expect(await kinds(site, mineKind)).toContain(mineKind);
    // Подсказка строится по той же области, что и список: иначе площадка читала бы по ней, что
    // арендуют соседние объекты.
    expect(await kinds(site, foreignKind)).toEqual([]);

    const office = await headersOf(ctx.users.manager);
    expect(await kinds(office, foreignKind)).toContain(foreignKind);
  });

  // ── Архив (Р15) ──

  it('без права на архив «archive=only» отдаёт список без архива, а прямая ссылка на архивную — 404', async () => {
    const office = await headersOf(ctx.users.manager);
    const live = await seedRequest({ objectId: ctx.objects.site });
    const archived = await seedAwaitingIssue(ctx.objects.site);
    const removed = await deleteRequest(office, archived, await versionOf(archived));
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().mode).toBe('soft');

    // Подобранный в адресной строке параметр не должен ни отдавать чужое, ни отвечать «такое
    // бывает»: 200 со списком живых заявок, а не 403.
    const ids = await listIds(office, `archive=only&placeObjectId=${ctx.objects.site}`);
    expect(ids).not.toContain(archived);
    expect(ids).toContain(live.id);
    // «Любое значение» — это и `include`: без права архива параметр не расширяет выдачу ничем.
    const included = await listIds(office, `archive=include&placeObjectId=${ctx.objects.site}`);
    expect(included).not.toContain(archived);
    expect(included).toContain(live.id);

    const card = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/mech-requests/${archived}`,
      headers: office,
    });
    expect(card.statusCode, card.body).toBe(404);

    // Архив на месте — выдача выше была про право, а не про пустой архив.
    const admin = await headersOf(ctx.users.admin);
    expect(await listIds(admin, `archive=only&placeObjectId=${ctx.objects.site}`)).toContain(
      archived,
    );
  });

  // ── Барьеры правки и удаления (Р19), тесты на офис ──

  it('менеджер не двигает срок работающей заявки обычной правкой', async () => {
    const office = await headersOf(ctx.users.manager);
    const id = await seedRunningRental(ctx.objects.site);
    const res = await patchRequest(office, id, {
      plannedTo: shiftDateKey(PLANNED_TO, 7),
      version: await versionOf(id),
    });
    expect(res.statusCode, res.body).toBe(422);
    // Отказ обязан назвать законный путь: срок двигают каждый день, и без подсказки человек ищет
    // его в этой же форме.
    expect(res.json().message).toContain('продление');
  });

  it('менеджер не меняет вид, площадку и заявителя после «Новой»', async () => {
    const office = await headersOf(ctx.users.manager);
    const id = await seedRunningRental(ctx.objects.deptA);

    for (const payload of [
      { kindName: 'Компрессор' },
      { objectId: ctx.objects.deptB },
      { departmentId: ctx.departments.a },
    ]) {
      const res = await patchRequest(office, id, { ...payload, version: await versionOf(id) });
      expect(res.statusCode, `${JSON.stringify(payload)}: ${res.body}`).toBe(422);
      expect(res.json().message).toContain('после «Новой» не меняют');
    }
  });

  it('менеджер не удаляет ни действующую аренду, ни коррекцию завершения', async () => {
    const office = await headersOf(ctx.users.manager);
    const running = await seedRunningRental(ctx.objects.site);
    const first = await deleteRequest(office, running, await versionOf(running));
    expect(first.statusCode, first.body).toBe(422);
    expect(first.json().message).toContain('Аренда идёт');

    // Коррекция завершения — «В работе» с заполненным возвратом, то есть строка после отката
    // «Выполнена» → «В работе». Арендой она уже не является, но вместе с ней исчезла бы
    // стоимость состоявшейся аренды.
    const corrected = await seedCompletedRental(ctx.objects.site);
    const rollback = await changeStatus(await headersOf(ctx.users.admin), corrected, {
      status: 'confirmed',
      version: await versionOf(corrected),
      comment: 'Пересчёт суммы',
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    const second = await deleteRequest(office, corrected, await versionOf(corrected));
    expect(second.statusCode, second.body).toBe(422);
  });

  it('ответственный и телефон правятся, пока заявка не закрыта, и не правятся у закрытой', async () => {
    const office = await headersOf(ctx.users.manager);
    const running = await seedRunningRental(ctx.objects.site);
    const open = await patchRequest(office, running, {
      responsibleName: 'Петров Пётр',
      responsiblePhone: '9269876543',
      version: await versionOf(running),
    });
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().responsibleName).toBe('Петров Пётр');

    const closed = await seedCompletedRental(ctx.objects.site);
    const late = await patchRequest(office, closed, {
      responsibleName: 'Сидоров Сидор',
      version: await versionOf(closed),
    });
    expect(late.statusCode, late.body).toBe(422);
    expect(late.json().message).toContain('Заявка закрыта');

    // Комментарий и вложения у закрытой открыты: акт приходит позже, а разбор пишут в комментарий.
    const note = await patchRequest(office, closed, {
      comment: 'Акт подписан',
      version: await versionOf(closed),
    });
    expect(note.statusCode, note.body).toBe(200);
  });

  it('договорённость правится, пока техника не выдана, и не правится после', async () => {
    const office = await headersOf(ctx.users.manager);
    const created = await seedRequest({ objectId: ctx.objects.site });
    const inWork = await changeStatus(office, created.id, {
      status: 'confirmed',
      version: created.version,
      deal: { lessorId: ctx.lessorId, rate: 1000, rateUnit: 'hour' },
    });
    expect(inWork.statusCode, inWork.body).toBe(200);

    const fixed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/mech-requests/${created.id}/deal`,
      headers: office,
      payload: {
        lessorId: ctx.lessorId,
        rate: 1500,
        rateUnit: 'shift',
        version: await versionOf(created.id),
      },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json().rate).toBe(1500);

    const issued = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${created.id}/issue`,
      headers: office,
      payload: { actualFrom: TODAY, version: await versionOf(created.id) },
    });
    expect(issued.statusCode, issued.body).toBe(200);

    const late = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/mech-requests/${created.id}/deal`,
      headers: office,
      payload: {
        lessorId: ctx.lessorId,
        rate: 1700,
        rateUnit: 'shift',
        version: await versionOf(created.id),
      },
    });
    expect(late.statusCode, late.body).toBe(422);
    expect(late.json().message).toContain('снимите отметку выдачи');
  });

  it('площадка не архивирует завершённую аренду — барьер роли остаётся в силе', async () => {
    const closed = await seedCompletedRental(ctx.objects.site);
    const site = await headersOf(ctx.users.site);
    const res = await deleteRequest(site, closed, await versionOf(closed));
    // 403, а не 422: дело не в состоянии записи (офис её архивирует), а в том, что этой роли
    // такое движение не положено — иначе стоимость аренды ушла бы из журнала.
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toContain('только в статусе «Новая»');

    const office = await headersOf(ctx.users.manager);
    const byOffice = await deleteRequest(office, closed, await versionOf(closed));
    expect(byOffice.statusCode, byOffice.body).toBe(200);
    expect(byOffice.json().mode).toBe('soft');
  });

  it('удалённая заявка не принимает ни правку, ни повторного удаления', async () => {
    const admin = await headersOf(ctx.users.admin);
    const id = await seedAwaitingIssue(ctx.objects.site);
    const archived = await deleteRequest(admin, id, await versionOf(id));
    expect(archived.statusCode, archived.body).toBe(200);

    const edited = await patchRequest(admin, id, {
      comment: 'Правка в архиве',
      version: await versionOf(id),
    });
    expect(edited.statusCode, edited.body).toBe(422);
    expect(edited.json().message).toContain('в архиве');

    const again = await deleteRequest(admin, id, await versionOf(id));
    expect(again.statusCode, again.body).toBe(422);
    expect(again.json().message).toContain('в архиве');
  });

  it('«Новая» в архиве тоже неприкосновенна: удаление не заменяет статус', async () => {
    const admin = await headersOf(ctx.users.admin);
    // Через портал «Новая» стирается физически, поэтому архивная «Новая» заводится прямой
    // пометкой: она приходит из старых данных и из прямого SQL, а Б3 обязан отвечать и на неё.
    const created = await seedRequest({ objectId: ctx.objects.site });
    await ctx.db
      .update(ctx.schema.mechRequests)
      .set({ deletedAt: new Date(), deletedBy: ctx.users.admin })
      .where(eq(ctx.schema.mechRequests.id, created.id));

    const edited = await patchRequest(admin, created.id, {
      comment: 'Правка архивной «Новой»',
      version: await versionOf(created.id),
    });
    expect(edited.statusCode, edited.body).toBe(422);
    expect(edited.json().message).toContain('в архиве');
  });

  // ── Фильтры площадки и заявителя (Р20) ──

  it('на одной площадке фильтр места возвращает обе заявки, а фильтры заявителя — по одной', async () => {
    const office = await headersOf(ctx.users.manager);
    const bySite = await seedRequest({ objectId: ctx.objects.deptA });
    const byDepartment = await seedRequest({
      objectId: ctx.objects.deptA,
      departmentId: ctx.departments.a,
    });

    const place = await listIds(office, `placeObjectId=${ctx.objects.deptA}`);
    expect(place).toEqual(expect.arrayContaining([bySite.id, byDepartment.id]));

    // Условие заявителя-площадки это ПАРА: без `department_id IS NULL` фильтр вернул бы и заявку
    // отдела, заведённую на той же площадке, — то есть отнёс бы её расходы не на того.
    const asPlace = await listIds(office, `requester=object:${ctx.objects.deptA}`);
    expect(asPlace).toContain(bySite.id);
    expect(asPlace).not.toContain(byDepartment.id);

    const asDepartment = await listIds(office, `requester=department:${ctx.departments.a}`);
    expect(asDepartment).toContain(byDepartment.id);
    expect(asDepartment).not.toContain(bySite.id);
  });

  it('роль отдела не заводит заявку мимо своего отдела — ни чужим, ни пустым заявителем', async () => {
    const dept = await headersOf(ctx.users.deptOnlyA);

    // Чужой отдел на общей площадке: и область, и связь отвечают про ПЛОЩАДКУ, а не про то, на
    // кого лягут расходы.
    const alien = await createRequest(dept, {
      objectId: ctx.objects.deptA,
      departmentId: ctx.departments.b,
    });
    expect(alien.statusCode, alien.body).toBe(403);

    // Отдел вовсе не назван: заявитель выводится (отдел, если заполнен, иначе площадка), и молча
    // опущенная половина пары относит аренду на объект. Портал такого не предлагает — группы
    // «Объекты» у отдельской роли в подборе заявителя нет, — но держит правило сервер: прямой
    // запрос обходит форму так же, как и в случае с чужим отделом.
    const headless = await createRequest(dept, { objectId: ctx.objects.deptA });
    expect(headless.statusCode, headless.body).toBe(403);
    expect(headless.json().message).toContain('только от своего отдела');

    // Своя пара по-прежнему проходит: отказы выше были про заявителя, а не про то, что отделу
    // вообще нельзя заводить заявки.
    const own = await createRequest(dept, {
      objectId: ctx.objects.deptA,
      departmentId: ctx.departments.a,
    });
    expect(own.statusCode, own.body).toBe(201);
  });

  it('активность отдела спрашивается и при смене половины пары у «Новой»', async () => {
    const office = await headersOf(ctx.users.manager);
    const request = await seedRequest({ objectId: ctx.objects.deptA });
    // Пара меняется целиком: площадка неактивного отдела за ним закреплена, то есть связь есть, —
    // и отказать обязана именно активность второй половины.
    const res = await patchRequest(office, request.id, {
      objectId: ctx.objects.deadDept,
      departmentId: ctx.departments.dead,
      version: await versionOf(request.id),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toContain('Отдел неактивен');
  });
});
