import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { readWorkbook } from '../src/lib/xlsx';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * Механизация: журнал закрытых аренд, его итог и выгрузка (ADR 0152; план
 * `docs/mechanization-module-plan.md`, §7 п. 3, Э3).
 *
 * **Зачем этому файлу база.** Всё, что здесь проверяется, — это то, как СЧИТАЕТСЯ выдача, а не как
 * она выглядит:
 *
 * 1. **состав журнала** держится тремя условиями сразу (закрытые статусы, живая строка, область), и
 *    каждое из них — предикат в SQL. Подменённый набор строк ответил бы на вопрос теста вместо
 *    базы, а вопрос стоит ровно в том, доходит ли отбор до настоящих заявок;
 * 2. **итог** собирается агрегатами с `FILTER` по `rate_unit` и `actual_from`. «Часы не
 *    складываются со сменами» — это два разных `FILTER` в одном запросе, и разница между «два
 *    числа» и «одно» видна только на строках с разными единицами;
 * 3. **дни** считает `dateKeySpan` по СГРУППИРОВАННЫМ строкам: включительность («с 1-го по 1-е —
 *    один день») и умножение на число заявок в группе проверяются только на настоящей выборке;
 * 4. **область** журнала обязана совпасть с областью списка, а она у роли отдела приходит
 *    подзапросом в `department_construction_objects`;
 * 5. **выгрузка** собирается той же выборкой, что экран, — и «файл не показывает чужую площадку»
 *    проверяется разбором самой книги, а не намерением кода.
 *
 * **Чего файл не проверяет.** Область во всех её видах и пару «отдел ↔ площадка» —
 * `mech-scope.db.test.ts`; цикл и переходы — `mech-cycle.db.test.ts`; вложения —
 * `mech-files.db.test.ts`; виды событий истории заявки — `mech-history.db.test.ts` (тот про ленту
 * ОДНОЙ заявки, этот — про журнал закрытых, и совпадение слова «история» в их именах ничего не
 * значит).
 *
 * Запуск — как у остальных db-тестов (общая база, поимённо):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-history-journal.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: база общая, а коды объектов, отделов и адреса учёток уникальны. */
const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-journal-${RUN}`;
/**
 * Коды с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const CODE_PREFIX = `яя-MECHJOURNAL-${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const FOUR_DAYS_AGO = shiftDateKey(TODAY, -4);
const PLANNED_TO = shiftDateKey(TODAY, 14);

/** Вид техники у каждой заявки свой: по нему проверяется, что итог считает по фильтру. */
const HOUR_KIND = `Виброплита ${RUN}`;
const SHIFT_KIND = `Компрессор ${RUN}`;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  objects: { site: string; other: string; deptA: string };
  departmentId: string;
  users: {
    admin: string;
    manager: string;
    site: string;
    siteOther: string;
    dept: string;
  };
  lessorId: string;
  /** Заявки, заведённые один раз на весь файл: журнал читают, а не правят. */
  requests: {
    /** Аренда с почасовой ставкой, выданная и возвращённая одним днём. */
    hourDone: string;
    /** Аренда со сменной ставкой, пять календарных дней. */
    shiftDone: string;
    /** Отменена до подачи: закрыта, но арендой не была. */
    cancelled: string;
    /** «Новая» — журналом не закрыта. */
    open: string;
    /** Действующая аренда — тоже не закрыта. */
    running: string;
    /** Закрытая и отправленная в архив: в журнале её нет вовсе. */
    archived: string;
    /** Закрытая на чужой площадке. */
    foreign: string;
    /** Закрытая на площадке отдела. */
    dept: string;
  };
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
 * каскада, ни ключа), потом заявки (за ними каскадом история статусов), потом учётки, отдел (за ним
 * набор площадок) и только в конце объекты — их держит `RESTRICT`.
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
      // вход, а выдача журнала.
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

async function versionOf(id: string): Promise<number> {
  const [row] = await ctx.db
    .select({ version: ctx.schema.mechRequests.version })
    .from(ctx.schema.mechRequests)
    .where(eq(ctx.schema.mechRequests.id, id));
  return row!.version;
}

interface SeedInput {
  objectId: string;
  departmentId?: string;
  kindName?: string;
}

/** Заявка, заведённая офисом: у менеджера области нет, и он заводит её на любую площадку. */
async function seedNew(input: SeedInput): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/mech-requests',
    headers: await headersOf(ctx.users.manager),
    payload: {
      objectId: input.objectId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      kindName: input.kindName ?? HOUR_KIND,
      plannedFrom: TODAY,
      plannedTo: PLANNED_TO,
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9261234567',
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: механизация, журнал закрытых',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function changeStatus(id: string, payload: Record<string, unknown>): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/mech-requests/${id}/status`,
    headers: await headersOf(ctx.users.manager),
    payload: { ...payload, version: await versionOf(id) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Действующая аренда: договорённость и выдача приезжают вместе с переходом в «В работе» (Р2). */
async function seedRunning(
  input: SeedInput & { rateUnit?: 'hour' | 'shift'; actualFrom?: string },
): Promise<string> {
  const id = await seedNew(input);
  await changeStatus(id, {
    status: 'confirmed',
    deal: {
      lessorId: ctx.lessorId,
      rate: input.rateUnit === 'shift' ? 18_000 : 1200,
      rateUnit: input.rateUnit ?? 'hour',
    },
    actualFrom: input.actualFrom ?? TODAY,
  });
  return id;
}

/** Закрытая аренда: факт предъявлен целиком (`done_check`). */
async function seedDone(
  input: SeedInput & {
    rateUnit?: 'hour' | 'shift';
    actualFrom?: string;
    actualUnits: number;
    finalCost: number;
  },
): Promise<string> {
  const id = await seedRunning(input);
  await changeStatus(id, {
    status: 'done',
    completion: {
      actualFrom: input.actualFrom ?? TODAY,
      actualTo: TODAY,
      actualUnits: input.actualUnits,
      finalCost: input.finalCost,
    },
  });
  return id;
}

/** Отменена до подачи: закрыта, но арендой не была — выдачи у неё нет и быть не могло. */
async function seedCancelled(input: SeedInput): Promise<string> {
  const id = await seedNew(input);
  await changeStatus(id, { status: 'cancelled', comment: 'Площадка отказалась' });
  return id;
}

async function journal(headers: Headers, query = ''): Promise<Record<string, unknown>[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/mech-requests/history?pageSize=200&${query}`,
    headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as Record<string, unknown>[];
}

async function journalIds(headers: Headers, query = ''): Promise<string[]> {
  return (await journal(headers, query)).map((row) => row.id as string);
}

interface Summary {
  closed: number;
  rentals: number;
  cancelled: number;
  days: number;
  hours: number;
  shifts: number;
  cost: string;
}

async function summaryOf(headers: Headers, query = ''): Promise<Summary> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/mech-requests/history/summary?${query}`,
    headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Summary;
}

describe.skipIf(!DB_URL)('механизация: журнал закрытых, итог и выгрузка (ADR 0152, Э3)', () => {
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
      departmentId: '',
      users: {} as Ctx['users'],
      lessorId: '',
      requests: {} as Ctx['requests'],
    };
    // Упавший прогон обязан убираться следующим, а не копить площадки в общей базе.
    await cleanup(db);

    ctx.objects = {
      site: await newObject('site'),
      other: await newObject('other'),
      deptA: await newObject('deptA'),
    };
    seq += 1;
    const [department] = await db
      .insert(schema.departments)
      .values({ code: `${CODE_PREFIX}-D${seq}`, name: `Отдел ${RUN}`, isActive: true })
      .returning({ id: schema.departments.id });
    ctx.departmentId = department!.id;
    await db
      .insert(schema.departmentConstructionObjects)
      .values({ departmentId: ctx.departmentId, constructionObjectId: ctx.objects.deptA });

    ctx.users = {
      admin: await newUser('admin', 'admin'),
      manager: await newUser('manager', 'manager'),
      site: await newUser('site', 'site', { objectIds: [ctx.objects.site] }),
      siteOther: await newUser('siteOther', 'site', { objectIds: [ctx.objects.other] }),
      dept: await newUser('dept', 'department', { departmentIds: [ctx.departmentId] }),
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

    // Подопытные заводятся один раз: журнал читают, а не правят, и каждый тест спрашивает один и
    // тот же набор строк с разных сторон.
    const archived = await seedDone({
      objectId: ctx.objects.site,
      actualUnits: 4,
      finalCost: 4800,
    });
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${archived}?version=${await versionOf(archived)}`,
      headers: await headersOf(ctx.users.manager),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    // Закрытая заявка уходит в архив обратимо, а не стирается физически (Б1): именно такую строку
    // журнал и обязан не показать.
    expect(deleted.json().mode).toBe('soft');

    ctx.requests = {
      // «С 1-го по 1-е» — один календарный день, а не ноль (Э3).
      hourDone: await seedDone({
        objectId: ctx.objects.site,
        kindName: HOUR_KIND,
        actualUnits: 8,
        finalCost: 9600,
      }),
      // Пять календарных дней включительно: с 4-х суток назад по сегодня.
      shiftDone: await seedDone({
        objectId: ctx.objects.site,
        kindName: SHIFT_KIND,
        rateUnit: 'shift',
        actualFrom: FOUR_DAYS_AGO,
        actualUnits: 3,
        finalCost: 54_000,
      }),
      cancelled: await seedCancelled({ objectId: ctx.objects.site }),
      open: await seedNew({ objectId: ctx.objects.site }),
      running: await seedRunning({ objectId: ctx.objects.site }),
      archived,
      foreign: await seedDone({
        objectId: ctx.objects.other,
        actualUnits: 2,
        finalCost: 1000,
      }),
      dept: await seedDone({
        objectId: ctx.objects.deptA,
        departmentId: ctx.departmentId,
        actualUnits: 1,
        finalCost: 500,
      }),
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Состав журнала ──

  it('в журнал попадают только закрытые заявки и только живые', async () => {
    const site = await headersOf(ctx.users.site);
    const ids = await journalIds(site);

    expect(ids).toEqual(
      expect.arrayContaining([
        ctx.requests.hourDone,
        ctx.requests.shiftDone,
        ctx.requests.cancelled,
      ]),
    );
    // «Новая» и действующая аренда журналом не закрыты: по ним ещё есть что решать.
    expect(ids).not.toContain(ctx.requests.open);
    expect(ids).not.toContain(ctx.requests.running);
    // Удалённой в журнале нет вовсе — она живёт вкладкой «Архив» (ADR 0070).
    expect(ids).not.toContain(ctx.requests.archived);
    // Область — та же, что у списка: чужая площадка не показывается и здесь.
    expect(ids).not.toContain(ctx.requests.foreign);
  });

  it('архивная заявка не приходит в журнал даже тому, кому открыт архив', async () => {
    const admin = await headersOf(ctx.users.admin);
    const place = `placeObjectId=${ctx.objects.site}`;

    // Параметра `archive` у журнала нет вовсе: подобранный в адресной строке, он молча
    // игнорируется схемой, а не открывает удалённые.
    expect(await journalIds(admin, `${place}&archive=only`)).not.toContain(ctx.requests.archived);
    expect(await journalIds(admin, place)).not.toContain(ctx.requests.archived);

    // А в списке та же строка администратору видна — значит, дело не в правах и не в самой строке.
    const archiveTab = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/mech-requests?pageSize=200&archive=only&${place}`,
      headers: admin,
    });
    expect(archiveTab.statusCode, archiveTab.body).toBe(200);
    expect((archiveTab.json().items as { id: string }[]).map((r) => r.id)).toContain(
      ctx.requests.archived,
    );
  });

  it('`status` сужает журнал до одного закрытого, а открытый статус отклоняет', async () => {
    const site = await headersOf(ctx.users.site);

    expect(await journalIds(site, 'status=done')).toEqual(
      expect.arrayContaining([ctx.requests.hourDone, ctx.requests.shiftDone]),
    );
    expect(await journalIds(site, 'status=done')).not.toContain(ctx.requests.cancelled);
    expect(await journalIds(site, 'status=cancelled')).toEqual([ctx.requests.cancelled]);

    // Открытый статус — отказ, а не молчаливое расширение до обоих закрытых: выдача, в которой
    // отбор не сработал, отличается от правильной только числом строк.
    for (const status of ['new', 'confirmed']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/mech-requests/history?status=${status}`,
        headers: site,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('журналом не закрыты');
    }

    // «Завершена» отвечает по-своему: у механизации такого статуса нет вовсе (Р8), и отправлять за
    // ней во вкладку «Заявки» было бы ложью — там её тоже нет.
    const completed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/mech-requests/history?status=completed',
      headers: site,
    });
    expect(completed.statusCode, completed.body).toBe(400);
    expect(completed.json().message).toContain('нет статуса «Завершена»');
  });

  it('область журнала та же, что у списка: роль отдела видит свои площадки', async () => {
    const dept = await headersOf(ctx.users.dept);
    const ids = await journalIds(dept);

    expect(ids).toContain(ctx.requests.dept);
    expect(ids).not.toContain(ctx.requests.hourDone);
    expect(ids).not.toContain(ctx.requests.foreign);

    // Тот же ответ у итога: разойдись область журнала и его сводки, число над таблицей считалось
    // бы по строкам, которых в ней нет.
    const summary = await summaryOf(dept);
    expect(summary.closed).toBe(1);
    expect(summary.cost).toBe('500.00');
  });

  // ── Итог (Э3) ──

  it('итог считается по фильтру, а не по всей таблице', async () => {
    const office = await headersOf(ctx.users.manager);

    // У менеджера области нет вовсе — он видит и свою площадку, и чужую, — поэтому вопрос сужает
    // фильтр. Итог обязан ответить про него, а не про весь реестр.
    const site = await summaryOf(office, `placeObjectId=${ctx.objects.site}`);
    expect(site).toEqual({
      closed: 3,
      rentals: 2,
      cancelled: 1,
      days: 6,
      hours: 8,
      shifts: 3,
      cost: '63600.00',
    });

    const other = await summaryOf(office, `placeObjectId=${ctx.objects.other}`);
    expect(other.closed).toBe(1);
    expect(other.cost).toBe('1000.00');

    // Вид техники сужает тот же итог дальше: остаётся одна аренда со сменной ставкой.
    const kind = await summaryOf(
      office,
      `placeObjectId=${ctx.objects.site}&kind=${encodeURIComponent(SHIFT_KIND)}`,
    );
    expect(kind).toEqual({
      closed: 1,
      rentals: 1,
      cancelled: 0,
      days: 5,
      hours: 0,
      shifts: 3,
      cost: '54000.00',
    });
  });

  it('часы и смены не складываются: две единицы дают два числа, а не одно', async () => {
    const site = await headersOf(ctx.users.site);
    const summary = await summaryOf(site);

    // 8 часов на виброплите и 3 смены на компрессоре. Сложи их — получилось бы «11», которое не
    // значит ничего: ставка задаётся за час либо за смену (Р7).
    expect(summary.hours).toBe(8);
    expect(summary.shifts).toBe(3);
    // Ни одно из двух чисел не является общей суммой отработанного: «11» в ответе означало бы, что
    // единицы всё-таки сложили.
    expect(summary.hours).not.toBe(11);
    expect(summary.shifts).not.toBe(11);

    // Каждая единица считается только по своим строкам: отбор по часовому виду обнуляет смены.
    const hourOnly = await summaryOf(site, `kind=${encodeURIComponent(HOUR_KIND)}`);
    expect(hourOnly.hours).toBe(8);
    expect(hourOnly.shifts).toBe(0);
  });

  it('отменённая до выдачи закрыта, но арендой не была', async () => {
    const site = await headersOf(ctx.users.site);
    const summary = await summaryOf(site, 'status=cancelled');

    expect(summary.closed).toBe(1);
    expect(summary.cancelled).toBe(1);
    // Выдачи у отменённой нет и быть не могло (`cancelled_check`), а значит и арендой она не была.
    expect(summary.rentals).toBe(0);
    expect(summary.days).toBe(0);
    expect(summary.cost).toBe('0.00');
  });

  it('дни считаются включительно: аренда «с 1-го по 1-е» — один день', async () => {
    const site = await headersOf(ctx.users.site);

    // Выдана и возвращена одним днём: разность дат ответила бы «ноль», а техника стояла сутки.
    const oneDay = await summaryOf(site, `kind=${encodeURIComponent(HOUR_KIND)}`);
    expect(oneDay.days).toBe(1);

    // Пять суток с обоими концами: 4 дня разницы плюс сам день возврата.
    const fiveDays = await summaryOf(site, `kind=${encodeURIComponent(SHIFT_KIND)}`);
    expect(fiveDays.days).toBe(5);
  });

  // ── Выгрузка ──

  it('выгрузка отдаёт книгу теми же строками и не показывает чужую площадку', async () => {
    const site = await headersOf(ctx.users.site);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/mech-requests/history/export',
      headers: site,
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    const [sheet] = readWorkbook(new Uint8Array(res.rawPayload));
    expect(sheet).toBeDefined();
    const numbers = sheet!.rows.slice(1).map((row) => row[0]);

    const numberOf = async (id: string): Promise<string> => {
      const [row] = await ctx.db
        .select({ num: ctx.schema.mechRequests.num })
        .from(ctx.schema.mechRequests)
        .where(eq(ctx.schema.mechRequests.id, id));
      return `МХ-${row!.num}`;
    };

    expect(numbers).toContain(await numberOf(ctx.requests.hourDone));
    expect(numbers).toContain(await numberOf(ctx.requests.shiftDone));
    expect(numbers).toContain(await numberOf(ctx.requests.cancelled));
    // Файл собирается той же выборкой и той же областью, что экран: расхождение означало бы файл,
    // показывающий больше, чем портал.
    expect(numbers).not.toContain(await numberOf(ctx.requests.foreign));
    expect(numbers).not.toContain(await numberOf(ctx.requests.archived));
    expect(numbers).not.toContain(await numberOf(ctx.requests.open));

    // Итоговая строка повторяет сводку — с раздельными часами и сменами.
    const totals = sheet!.rows.find((row) => row[0] === 'Итого');
    expect(totals, 'книга обязана нести итог').toBeDefined();
    expect(totals!).toEqual(
      expect.arrayContaining([
        'закрытых: 3',
        'аренд: 2',
        'отменено: 1',
        // Дни, часы, смены и сумма — каждое своим числом в своей колонке.
        '6',
        '8',
        '3',
        '63600.00',
      ]),
    );
  });
});
