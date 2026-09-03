import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type MechRequestDto,
  moscowDateKeyOf,
  type RequestHistoryEntryDto,
  shiftDateKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * Продление срока аренды малой механизации (ADR 0152; план `docs/mechanization-module-plan.md`,
 * этап Э2, Р2, Р9, Р11, Р12, Р21).
 *
 * **Зачем этому файлу база.** Ни одно утверждение здесь не выражается чистой функцией контрактов:
 *
 * - **продлевать можно только действующую аренду** (Р2), а это не статус, а тройка «`confirmed` +
 *   выдача есть + возврата нет». Отличить её от «ждёт подачи» и от коррекции завершения можно
 *   только на настоящей строке: у всех трёх статус один и тот же, и разводит их содержимое
 *   `actual_from`/`actual_to`, которое ставят переходы и отметка выдачи;
 * - **строгий рост даты** проверяется по ЗАПЕРТОЙ строке: прежней даты у схемы тела нет вовсе, и
 *   сравнивать её сервер обязан с тем `planned_to`, который лежит в базе на момент продления;
 * - **право `.extend` разведено со `.status`** (Р9) — менеджер ведёт аренду целиком, но продлить
 *   не может. Проверяемо только настоящим принципалом на настоящем маршруте: матрица прав без
 *   маршрута говорит лишь, что право у роли есть или нет, а не что ручка его спрашивает;
 * - **порядок шагов протокола Р21** (замок → область → версия → предметные правила) наблюдаем
 *   ровно одним способом — двумя встречными запросами с пересекающимися окнами транзакций.
 *   Продление, разошедшееся с завершением, обязано ответить 409 «данные изменились», а не 422
 *   «аренда не идёт»: правило к тому моменту действительно нарушено, но человек столкнулся с
 *   гонкой, и предметный отказ он повторил бы слово в слово.
 *
 * Соседи: цикл, откаты и прочие гонки — `mech-cycle.db.test.ts`; область и барьеры правки —
 * `mech-scope.db.test.ts`; виды событий истории целиком — `mech-history.db.test.ts`.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-extend.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: база общая, а коды объектов и адреса учёток уникальны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const EMAIL_PREFIX = `db-mech-extend-${RUN}`;
/**
 * Код площадки с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-mech-extend-${RUN}`;
/** Метка своих контрагентов: уборка идёт по ней, а не «по последним строкам». */
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: продление механизации ${RUN}`;

/** Сколько ждать, пока встречный запрос встанет в очередь за строкой держателя. */
const BLOCK_TIMEOUT_MS = 15_000;

/** Календарь модуля — московский (Р12): фактические даты сравниваются с ним, а не с UTC. */
const TODAY = moscowDateKeyOf(new Date());
const YESTERDAY = shiftDateKey(TODAY, -1);
const WEEK_AGO = shiftDateKey(TODAY, -7);
const IN_TEN_DAYS = shiftDateKey(TODAY, 10);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  objectId: string;
  lessorId: string;
  /** Модель из справочника: с Э2 предмет аренды выбирается строго из него (ADR 0156). */
  modelId: string;
  users: {
    admin: string;
    /** Ведёт аренду целиком (`.status`), но продлевать её не вправе (Р9). */
    manager: string;
    /** Тот, кто звонит арендодателю и соглашается платить дальше, — у него `.extend`. */
    dispatcher: string;
  };
  auth: { authorization: string };
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

// ── Ручки модуля ──

type Headers = { authorization: string };
type Injected = Awaited<ReturnType<Ctx['app']['inject']>>;

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Headers = ctx.auth,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/mech-requests${url}`,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}

function ok(res: Injected, code = 200): Record<string, unknown> {
  expect(res.statusCode, res.body).toBe(code);
  return res.json();
}

async function card(id: string): Promise<MechRequestDto> {
  return ok(await call('GET', `/${id}`)) as unknown as MechRequestDto;
}

async function version(id: string): Promise<number> {
  return (await card(id)).version;
}

/**
 * Заголовок с access-токеном. Входа по паролю в файле нет: предмет проверки — право на маршруте,
 * а не вход, и argon2 на трёх учётках стоил бы секунд на пустом месте.
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

/** Новая заявка на своей площадке; срок по умолчанию — с прошлой недели по «сегодня + 10». */
async function newRequest(
  over: { plannedFrom?: string; plannedTo?: string } = {},
): Promise<MechRequestDto> {
  const res = await call('POST', '/', {
    objectId: ctx.objectId,
    mechModelId: ctx.modelId,
    plannedFrom: over.plannedFrom ?? WEEK_AGO,
    plannedTo: over.plannedTo ?? IN_TEN_DAYS,
    responsibleName: 'Иванов Иван',
    responsiblePhone: '9990000000',
    comment: MARK,
  });
  return ok(res, 201) as unknown as MechRequestDto;
}

async function changeStatus(
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<Injected> {
  return call('PATCH', `/${id}/status`, { status, version: await version(id), ...extra });
}

/** Взять в работу: договорённость обязательна, выдача — по желанию (техника уже на объекте). */
async function takeInWork(id: string, actualFrom?: string): Promise<Injected> {
  return changeStatus(id, 'confirmed', {
    deal: { lessorId: ctx.lessorId, rate: 1200, rateUnit: 'hour' },
    ...(actualFrom ? { actualFrom } : {}),
  });
}

/** Полный факт возврата: четыре значения, без любого из которых закрывать нечего. */
const COMPLETION = { actualFrom: WEEK_AGO, actualTo: TODAY, actualUnits: 26, finalCost: 31200 };

/** Действующая аренда: взяли в работу и выдали — все три условия предиката Р2 сразу. */
async function runningRental(over: { plannedTo?: string } = {}): Promise<MechRequestDto> {
  const request = await newRequest(over);
  ok(await takeInWork(request.id, WEEK_AGO));
  return card(request.id);
}

async function extend(
  id: string,
  plannedTo: string,
  over: { reason?: string; version?: number; headers?: Headers } = {},
): Promise<Injected> {
  return call(
    'PATCH',
    `/${id}/extend`,
    {
      plannedTo,
      reason: over.reason ?? 'Арендодатель согласился, работы на площадке не закончены',
      version: over.version ?? (await version(id)),
    },
    over.headers ?? ctx.auth,
  );
}

async function history(id: string): Promise<RequestHistoryEntryDto[]> {
  const res = await call('GET', `/${id}/history`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestHistoryEntryDto[];
}

/** Значение изменённого поля в событии: технический ключ ищется в `changes`, а не подпись. */
function changeOf(
  entry: RequestHistoryEntryDto | undefined,
  field: string,
): { from: string | null; to: string | null } {
  const change = entry?.changes.find((c) => c.field === field);
  expect(change, `${field} в событии ${entry?.kind}`).toBeDefined();
  return { from: change!.from, to: change!.to };
}

/** Календарный день человеку — тем же видом, что его пишет дифф модуля. */
function day(dateKey: string): string {
  const [yyyy, mm, dd] = dateKey.split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/** Номера заявок, отобранных списком: отбор всегда сужается своим номером — база общая. */
async function listNums(query: string): Promise<number[]> {
  const res = await call('GET', `/?pageSize=50&${query}`);
  return ((ok(res) as { items: MechRequestDto[] }).items ?? []).map((r) => r.num);
}

// ── Инструмент гонок: держатель строки и барьер очереди (тот же, что в `mech-cycle`) ──

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Третья сессия, которая держит спорную строку, пока обе двери встают в очередь. Своим
 * соединением, а не транзакцией пула: пул отдаёт соединения приложению, и держатель, занявший одно
 * из них, спорил бы сам с собой.
 */
async function openHolder(): Promise<{
  pid: number;
  hold: (query: string, params?: unknown[]) => Promise<void>;
  release: () => Promise<void>;
}> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const pid = Number(
    (await client.query<{ pid: string }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
  );
  await client.query('BEGIN');
  let closed = false;
  return {
    pid,
    hold: async (query, params = []) => {
      await client.query(query, params);
    },
    release: async () => {
      if (closed) return;
      closed = true;
      await client.query('COMMIT');
      await client.end();
    },
  };
}

/**
 * Ждёт, пока за строкой держателя выстроится ровно столько сессий, сколько ожидается.
 * `pg_blocking_pids` вместо `wait_event_type = 'Lock'` намеренно: считаются только те, кого держит
 * ЭТОТ держатель, — иначе барьер снимала бы блокировка соседнего db-теста. Обход рекурсивный:
 * второй ждущий за той же строкой ждёт не держателя, а первого ждущего.
 */
async function waitBlockedBy(pid: number, expected: number): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  for (;;) {
    const rows = await ctx.db.execute<{ n: number }>(sql`
      WITH RECURSIVE waiters AS (
        SELECT a.pid
        FROM pg_stat_activity a
        WHERE a.datname = current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid
        FROM pg_stat_activity a
        JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
        WHERE a.datname = current_database()
      )
      SELECT count(*)::int AS n FROM waiters`);
    if (Number(rows.rows[0]!.n) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `дверь не встала в очередь за строкой держателя (ждали ${expected}, дождались ${rows.rows[0]!.n}): ` +
          'либо путь берёт не ту строку, либо ответил раньше, чем дошёл до захвата',
      );
    }
    await wait(25);
  }
}

/**
 * Две двери с пересекающимися окнами транзакций и заданным порядком: первая занимает очередь за
 * строкой раньше второй, поэтому и получит строку первой. Тела дверей строятся ЗАРАНЕЕ (версия
 * читается до захвата): обе обязаны выйти из одного и того же состояния карточки.
 */
async function race(
  requestId: string,
  first: () => Promise<Injected>,
  second: () => Promise<Injected>,
): Promise<[Injected, Injected]> {
  const holder = await openHolder();
  try {
    await holder.hold('SELECT id FROM mech_requests WHERE id = $1 FOR UPDATE', [requestId]);
    const a = first();
    await waitBlockedBy(holder.pid, 1);
    const b = second();
    await waitBlockedBy(holder.pid, 2);
    await holder.release();
    return await Promise.all([a, b]);
  } finally {
    await holder.release();
  }
}

describe.skipIf(!DB_URL)('механизация: продление срока аренды (ADR 0152, Э2)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');

    const newUser = async (role: 'admin' | 'manager' | 'dispatcher'): Promise<string> => {
      const [row] = await db
        .insert(schema.users)
        .values({
          email: `${EMAIL_PREFIX}-${role}@example.invalid`,
          lastName: 'Тестовый',
          firstName: 'Сотрудник',
          middleName: role,
          // Входа по паролю здесь нет: токен подписывается напрямую.
          passwordHash: 'db-test-not-a-hash',
          role,
          isActive: true,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      return row!.id;
    };

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: OBJECT_CODE,
        name: `Площадка продления ${RUN}`,
        address: 'г. Москва, тестовый проезд, 1',
      })
      .returning({ id: schema.constructionObjects.id });
    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: `Арендодатель механизации ${RUN}`,
        inn: `9${String(Date.now() % 100_000_000).padStart(8, '0')}1`,
        isActive: true,
        comment: MARK,
      })
      .returning({ id: schema.counterparties.id });
    // Своя строка справочника на прогон, а не позиция сида: база общая, и заявка, сославшаяся на
    // общую модель, помешала бы соседнему файлу её гасить и сносить.
    const [model] = await db
      .insert(schema.mechModels)
      .values({ code: `mech-extend-${RUN}`, name: `Виброплита продления ${RUN}` })
      .returning({ id: schema.mechModels.id });

    const app = await buildApp();
    ctx = {
      app,
      db,
      schema,
      tokens,
      closeDb,
      objectId: object!.id,
      lessorId: lessor!.id,
      modelId: model!.id,
      users: {
        admin: await newUser('admin'),
        manager: await newUser('manager'),
        dispatcher: await newUser('dispatcher'),
      },
      // Заполняется ниже: заголовок администратора нужен уже готовому `ctx`.
      auth: { authorization: '' },
    };
    ctx.auth = await headersOf(ctx.users.admin);
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    // Порядок обратный ссылкам: сначала аудит (у него `entity_id` текстовый, ни каскада, ни
    // ключа), потом заявки, потом учётки и только в конце площадка — её держит `RESTRICT`.
    const users = sql`(SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
    await ctx.db.execute(
      sql`DELETE FROM mech_requests WHERE object_id IN
            (SELECT id FROM construction_objects WHERE code = ${OBJECT_CODE})`,
    );
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
    // Модели — после заявок: ссылка стоит с `ON DELETE RESTRICT`.
    await ctx.db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-extend-${RUN}`}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${OBJECT_CODE}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Что продление делает со строкой (Р11) ──

  it('продление двигает только плановый возврат и не трогает ни подачу, ни выдачу', async () => {
    const rental = await runningRental();
    const later = shiftDateKey(rental.plannedTo, 7);

    const extended = ok(await extend(rental.id, later)) as unknown as MechRequestDto;
    expect(extended.plannedTo).toBe(later);
    // Начало плана и факт выдачи не двигаются вовсе: аренда уже идёт, и подвинутое начало
    // переписало бы то, что случилось, а не то, о чём договорились дальше.
    expect(extended.plannedFrom).toBe(rental.plannedFrom);
    expect(extended.actualFrom).toBe(WEEK_AGO);
    expect(extended.actualTo).toBeNull();
    // Статус продление не двигает: заявка остаётся там же, где была, — меняется только обещание
    // платить дальше (Р9).
    expect(extended.status).toBe('confirmed');
    expect(extended.version).toBe(rental.version + 1);
    // Договорённость продление не касается: ставку правит своё действие своим событием.
    expect(extended.rate).toBe(1200);

    // Аренда осталась действующей — тем же предикатом, которым её отбирает вкладка «В аренде».
    expect(await listNums(`num=${rental.num}&rental=true`)).toEqual([rental.num]);
  }, 60_000);

  it('просрочка производна: продление убирает заявку из «просрочен возврат» без правки строки', async () => {
    // Возврат был вчера, техника не возвращена — по московскому календарю это просрочка (Р12).
    const overdue = await runningRental({ plannedTo: YESTERDAY });
    expect(await listNums(`num=${overdue.num}&overdue=true`)).toEqual([overdue.num]);

    const summaryBefore = ok(await call('GET', `/summary?placeObjectId=${ctx.objectId}`)) as {
      overdue: number;
      rental: number;
    };

    ok(await extend(overdue.id, shiftDateKey(TODAY, 3)));

    // Хранимого признака просрочки нет: сдвинулась дата — и заявка ушла из отбора сама, без
    // второго поля, которое кому-то пришлось бы переводить.
    expect(await listNums(`num=${overdue.num}&overdue=true`)).toEqual([]);
    expect(await listNums(`num=${overdue.num}&overdue=false`)).toEqual([overdue.num]);
    // Из действующих аренд она при этом никуда не делась — просрочка их подмножество, а не смена
    // состояния.
    expect(await listNums(`num=${overdue.num}&rental=true`)).toEqual([overdue.num]);

    // Сводка считает теми же предикатами: разойдись они — вкладка показывала бы одно, а число над
    // ней другое.
    const summaryAfter = ok(await call('GET', `/summary?placeObjectId=${ctx.objectId}`)) as {
      overdue: number;
      rental: number;
    };
    expect(summaryAfter.overdue).toBe(summaryBefore.overdue - 1);
    expect(summaryAfter.rental).toBe(summaryBefore.rental);
  }, 60_000);

  it('просрочка считается только по выданному и не возвращённому', async () => {
    // Срок вышел, но техники на площадке нет: «ждёт подачи» просрочкой возврата не является —
    // возвращать нечего, и звонить надо не про возврат, а про подачу.
    const awaiting = await newRequest({ plannedTo: YESTERDAY });
    ok(await takeInWork(awaiting.id));
    expect(await listNums(`num=${awaiting.num}&overdue=true`)).toEqual([]);

    // Возвращённая техника с просроченным планом — тоже не просрочка: аренда закончена, и
    // расхождение плана с фактом разбирают деньгами, а не звонком.
    const returned = await newRequest({ plannedTo: YESTERDAY });
    ok(await takeInWork(returned.id, WEEK_AGO));
    ok(await changeStatus(returned.id, 'done', { completion: COMPLETION }));
    expect(await listNums(`num=${returned.num}&overdue=true`)).toEqual([]);

    // И «Новая» с вышедшим сроком: аренды не было вовсе.
    const fresh = await newRequest({ plannedTo: YESTERDAY });
    expect(await listNums(`num=${fresh.num}&overdue=true`)).toEqual([]);
  }, 60_000);

  // ── Дата строго растёт (Р11) ──

  it('та же дата и более ранняя — отказ, и строка от него не двигается', async () => {
    const rental = await runningRental();

    // Та же дата — не продление: нажатие «продлить» без выбора новой даты не должно выглядеть
    // состоявшимся действием, иначе в истории появилось бы событие ни о чём.
    const same = await extend(rental.id, rental.plannedTo);
    expect(same.statusCode, same.body).toBe(422);
    expect(same.json().message).toContain('позже прежней');

    // Меньшая — сокращение срока, и выражается оно завершением с фактической датой возврата, а не
    // задним числом передвинутым планом.
    const earlier = await extend(rental.id, shiftDateKey(rental.plannedTo, -3));
    expect(earlier.statusCode, earlier.body).toBe(422);

    const untouched = await card(rental.id);
    expect(untouched.plannedTo).toBe(rental.plannedTo);
    expect(untouched.version).toBe(rental.version);
    // Событий не появилось: неудавшееся продление не пишет в историю ничего.
    expect((await history(rental.id)).filter((e) => e.kind === 'mechExtended')).toHaveLength(0);
  }, 60_000);

  it('причина обязательна: без неё и из одних пробелов — отказ', async () => {
    const rental = await runningRental();
    const later = shiftDateKey(rental.plannedTo, 5);

    const bare = await call('PATCH', `/${rental.id}/extend`, {
      plannedTo: later,
      version: rental.version,
    });
    expect(bare.statusCode, bare.body).toBe(400);

    // Пробелы — не причина: схема подрезает строку перед проверкой длины, иначе форму обходил бы
    // любой пробел, а в истории оставалось бы пустое «почему».
    const blank = await extend(rental.id, later, { reason: '   ' });
    expect(blank.statusCode, blank.body).toBe(400);

    expect((await card(rental.id)).plannedTo).toBe(rental.plannedTo);
  }, 60_000);

  // ── Продлевают только действующую аренду (Р2) ──

  it('продлевать нечего у «Новой», у ждущей подачи, у коррекции завершения и у закрытой', async () => {
    const fresh = await newRequest();
    const refusedNew = await extend(fresh.id, shiftDateKey(fresh.plannedTo, 5));
    expect(refusedNew.statusCode, refusedNew.body).toBe(422);
    expect(refusedNew.json().message).toContain('действующую аренду');

    // Ждёт подачи: договорились, но техники на площадке нет — платить дальше не за что, а срок
    // такой заявке правят обычной формой, пока она «Новая», либо переоформляют договорённость.
    const awaiting = await newRequest();
    ok(await takeInWork(awaiting.id));
    const refusedAwaiting = await extend(awaiting.id, shiftDateKey(awaiting.plannedTo, 5));
    expect(refusedAwaiting.statusCode, refusedAwaiting.body).toBe(422);

    // Коррекция завершения — «В работе» с целым фактом после отката «Выполнена → В работе».
    // Статус у неё тот же `confirmed`, что и у действующей аренды, и разводит их только факт
    // возврата: продлевать здесь нечего — техника уже вернулась, ждут повторного завершения.
    const correction = await newRequest();
    ok(await takeInWork(correction.id, WEEK_AGO));
    ok(await changeStatus(correction.id, 'done', { completion: COMPLETION }));
    ok(await changeStatus(correction.id, 'confirmed'));
    const rolled = await card(correction.id);
    expect(rolled.status).toBe('confirmed');
    expect(rolled.actualTo).toBe(TODAY);
    const refusedCorrection = await extend(correction.id, shiftDateKey(rolled.plannedTo, 5));
    expect(refusedCorrection.statusCode, refusedCorrection.body).toBe(422);

    // Закрытая заявка: и завершённая, и отменённая. Ни у той, ни у другой аренда не идёт.
    const closed = await newRequest();
    ok(await takeInWork(closed.id, WEEK_AGO));
    ok(await changeStatus(closed.id, 'done', { completion: COMPLETION }));
    const refusedDone = await extend(closed.id, shiftDateKey(closed.plannedTo, 5));
    expect(refusedDone.statusCode, refusedDone.body).toBe(422);

    const cancelled = await newRequest();
    ok(await changeStatus(cancelled.id, 'cancelled', { comment: 'Передумали' }));
    const refusedCancelled = await extend(cancelled.id, shiftDateKey(cancelled.plannedTo, 5));
    expect(refusedCancelled.statusCode, refusedCancelled.body).toBe(422);

    // Ни одна из пяти строк не сдвинулась: отказ обязан быть бездейственным.
    for (const id of [fresh.id, awaiting.id, correction.id, closed.id, cancelled.id]) {
      expect((await history(id)).filter((e) => e.kind === 'mechExtended')).toHaveLength(0);
    }
  }, 90_000);

  it('снятая отметка выдачи закрывает продление обратно', async () => {
    const rental = await runningRental();
    ok(await extend(rental.id, shiftDateKey(rental.plannedTo, 4)));

    const revoked = await call('POST', `/${rental.id}/issue-revoke`, {
      reason: 'Отметили выдачу по ошибке',
      version: await version(rental.id),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    // После снятия строка снова «ждёт подачи»: аренда не идёт, и продление закрыто — тем же
    // предикатом, что и открывало.
    const refused = await extend(rental.id, shiftDateKey(rental.plannedTo, 9));
    expect(refused.statusCode, refused.body).toBe(422);
    // Уже случившееся продление при этом цело: срок остался продлённым, а событие — в истории.
    expect((await card(rental.id)).plannedTo).toBe(shiftDateKey(rental.plannedTo, 4));
    expect((await history(rental.id)).filter((e) => e.kind === 'mechExtended')).toHaveLength(1);
  }, 60_000);

  // ── История карточки (Р11) ──

  it('событие приезжает в историю видом mechExtended с обеими датами и причиной', async () => {
    const rental = await runningRental();
    const later = shiftDateKey(rental.plannedTo, 7);
    const reason = 'Бетон не набрал прочность, площадка просит ещё неделю';
    ok(await extend(rental.id, later, { reason }));

    const entries = await history(rental.id);
    const extended = entries.filter((e) => e.kind === 'mechExtended');
    // Свой вид, а не «изменено»: без него продление читалось бы правкой формы, и тег в карточке
    // сказал бы «Правка» там, где речь о деньгах.
    expect(extended).toHaveLength(1);
    // Обе даты обычной парой: прежний срок строка не хранит — она помнит одно «сейчас», — и
    // именно его спрашивают, разбирая счёт.
    expect(changeOf(extended[0], 'plannedTo')).toEqual({
      from: day(rental.plannedTo),
      to: day(later),
    });
    // Причина — строкой вида «список» (`from === null`): у неё нет «было», и пара «— → текст»
    // читалась бы как потеря значения.
    expect(changeOf(extended[0], 'extendReason')).toEqual({ from: null, to: reason });
    // Правкой формы продление не притворяется: событие `updated` не появилось.
    expect(entries.filter((e) => e.kind === 'updated')).toHaveLength(0);

    // Второе продление — второе событие со своей парой дат: цепочка «продлевали трижды» обязана
    // читаться по истории целиком.
    const evenLater = shiftDateKey(later, 3);
    ok(await extend(rental.id, evenLater, { reason: 'Ещё три дня' }));
    const both = (await history(rental.id)).filter((e) => e.kind === 'mechExtended');
    expect(both).toHaveLength(2);
    expect(both.map((e) => changeOf(e, 'plannedTo').to)).toEqual(
      expect.arrayContaining([day(later), day(evenLater)]),
    );
  }, 60_000);

  // ── Право `.extend` разведено со `.status` (Р9) ──

  it('менеджер аренду ведёт, но не продлевает; диспетчер продлевает', async () => {
    const rental = await runningRental();
    const manager = await headersOf(ctx.users.manager);
    const dispatcher = await headersOf(ctx.users.dispatcher);
    const later = shiftDateKey(rental.plannedTo, 6);

    // Менеджер — полноправный ведущий аренды: карточку читает, статусы двигает. Ровно поэтому
    // отказ обязан прийти именно от продления, а не от отсутствия доступа к модулю.
    const readable = await call('GET', `/${rental.id}`, undefined, manager);
    expect(readable.statusCode, readable.body).toBe(200);

    const refused = await extend(rental.id, later, { headers: manager });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await card(rental.id)).plannedTo).toBe(rental.plannedTo);

    // Диспетчер: срок аренды двигает тот, кто звонит арендодателю и соглашается платить дальше.
    const allowed = await extend(rental.id, later, { headers: dispatcher });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect((await card(rental.id)).plannedTo).toBe(later);
  }, 60_000);

  // ── Гонка протокола мутаций (Р21) ──

  it('продление, разошедшееся с завершением, отклоняется по версии, а не по правилу', async () => {
    const rental = await runningRental();
    const at = rental.version;
    const later = shiftDateKey(rental.plannedTo, 8);

    // Обе двери выходят из действующей аренды, где продление законно. Пока продление ждало
    // строку, технику вернули и заявку закрыли — и предметный барьер («продлевают действующую
    // аренду») стал бы формально верным ответом на вопрос, которого человек не задавал.
    const [completed, extended] = await race(
      rental.id,
      () =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/mech-requests/${rental.id}/status`,
          headers: ctx.auth,
          payload: { status: 'done', completion: COMPLETION, version: at },
        }),
      () =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/mech-requests/${rental.id}/extend`,
          headers: ctx.auth,
          payload: { plannedTo: later, reason: 'Договорились ещё на неделю', version: at },
        }),
    );
    expect(completed.statusCode, completed.body).toBe(200);
    // 409, а не 422: правило к этому моменту действительно нарушено — аренда уже не идёт, — но
    // версия сверяется РАНЬШЕ предметных проверок, и человеку сказано «данные изменились».
    expect(extended.statusCode, extended.body).toBe(409);
    expect(extended.json().message).not.toContain('действующую аренду');

    // Тот же запрос с актуальной версией отвечает уже по делу. Эти два ответа и есть проверка
    // порядка шагов протокола — совпади они, порядок был бы не виден.
    const again = await extend(rental.id, later);
    expect(again.statusCode, again.body).toBe(422);
    expect(again.json().message).toContain('действующую аренду');

    // Срок не сдвинулся ни на одном из двух отказов, а события продления не появилось вовсе.
    const closed = await card(rental.id);
    expect(closed.plannedTo).toBe(rental.plannedTo);
    expect(closed.status).toBe('done');
    expect((await history(rental.id)).filter((e) => e.kind === 'mechExtended')).toHaveLength(0);
  }, 90_000);
});
