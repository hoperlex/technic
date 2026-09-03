import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MECH_FUTURE_DATE_MESSAGE,
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

/**
 * Цикл аренды малой механизации: договорённость, выдача и её снятие, откаты, завершение и гонки
 * протокола мутаций (ADR 0152; план `docs/mechanization-module-plan.md`, §9 «Цикл», «Полнота
 * факта», «Гонки», Р2, Р8, Р21).
 *
 * **Зачем база.** Ни одно утверждение этого файла не выражается чистой функцией контрактов — те
 * проверяются без базы, и дублировать их здесь было бы враньём про стоимость прогона:
 *
 * - **состояния аренды разведены полями, а не статусом** (Р2). «Взяли в работу», «техника стоит на
 *   площадке» и «коррекция завершения» — это один и тот же `confirmed` с разным содержимым
 *   `actual_from`/`actual_to`. Проверить, что откат «Выполнена → В работе» бережёт факт и при этом
 *   **не возвращает заявку в действующие аренды**, можно только на настоящей выдаче: предикат живёт
 *   в пяти местах сразу — во вкладке, в сводке, в просрочке, в частичном индексе и в праве на
 *   продление, — и вопрос стоит ровно в том, одинаково ли их читает SQL;
 * - **договорённость приезжает и стирается той же транзакцией, что и статус.** Отдельными запросами
 *   заявка на секунду оказывалась бы в состоянии, которого `CHECK`-и не допускают, — и увидеть это
 *   можно только там, где эти `CHECK`-и стоят;
 * - **порядок шагов протокола Р21** (замок → область → версия → предметные правила) наблюдаем ровно
 *   одним способом: два встречных запроса с пересекающимися окнами транзакций. Поставь барьеры
 *   раньше версии — и обещанный 409 не наступил бы никогда, а человек, столкнувшийся с гонкой,
 *   получал бы 422 про правило и повторял бы то же действие. Последовательными вызовами это не
 *   ловится вовсе: в них никакого расхождения нет.
 *
 * Физические инварианты самой таблицы (`deal_parts_check`, `status_check`, лестница факта) живут в
 * соседнем `mech-invariants.db.test.ts`: там они предъявляются прямым запросом.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-cycle.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = `db-mech-cycle-admin-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
/**
 * Код площадки с «яя» в начале — требование соседства: половина db-тестов берёт объект выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-mech-cycle-${RUN}`;
/** Метка своих контрагентов: уборка идёт по ней, а не «по последним строкам». */
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: цикл механизации ${RUN}`;

/** Сколько ждать, пока встречный запрос встанет в очередь за строкой держателя. */
const BLOCK_TIMEOUT_MS = 15_000;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
  /** Арендодатель механизации, активен: с ним проходит всё. */
  mechLessorId: string;
  /** Арендодатель ТС: другой тип, но законный арендодатель механизации (Р6). */
  vehicleLessorId: string;
  /** Перевозчик: контрагент есть, арендодателем не бывает. */
  operatorId: string;
  /** Арендодатель механизации, погашенный: существует, но выбрать его сегодня нельзя. */
  inactiveLessorId: string;
}

let ctx: Ctx;

/** Календарь модуля — московский (Р12): фактические даты сравниваются с ним, а не с UTC. */
const today = moscowDateKeyOf(new Date());
const yesterday = shiftDateKey(today, -1);
const tomorrow = shiftDateKey(today, 1);

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

/** Уникальный ИНН: `counterparties_inn_unique` смотрит на всю базу, а она общая. */
let innSeq = 0;
function nextInn(): string {
  innSeq += 1;
  return `9${String(Date.now() % 100_000_000).padStart(8, '0')}${innSeq % 10}`;
}

// ── Ручки модуля ──

type Injected = Awaited<ReturnType<Ctx['app']['inject']>>;

/** Вход в модуль: обычный вызов ручки под администратором. */
function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url: `/api/v1/mech-requests${url}`,
    headers: ctx.auth,
    ...(payload === undefined ? {} : { payload }),
  });
}

function ok(res: Injected, code = 200): Record<string, unknown> {
  expect(res.statusCode, res.body).toBe(code);
  return res.json();
}

async function version(id: string): Promise<number> {
  const res = await call('GET', `/${id}`);
  return (ok(res) as unknown as MechRequestDto).version;
}

async function card(id: string): Promise<MechRequestDto> {
  return ok(await call('GET', `/${id}`)) as unknown as MechRequestDto;
}

/** Новая заявка на своей площадке; срок — от вчера, чтобы фактические даты не были будущими. */
async function newRequest(): Promise<MechRequestDto> {
  const res = await call('POST', '/', {
    objectId: ctx.objectId,
    kindName: `Виброплита ${RUN}`,
    plannedFrom: yesterday,
    plannedTo: shiftDateKey(today, 10),
    responsibleName: 'Иванов Иван',
    responsiblePhone: '9990000000',
    comment: MARK,
  });
  return ok(res, 201) as unknown as MechRequestDto;
}

interface StatusBody {
  comment?: string;
  deal?: { lessorId: string; rate: number; rateUnit: string } | Record<string, unknown>;
  actualFrom?: string;
  completion?: Record<string, unknown>;
}

async function changeStatus(id: string, status: string, extra: StatusBody = {}) {
  return call('PATCH', `/${id}/status`, { status, version: await version(id), ...extra });
}

/** Взять в работу: договорённость обязательна, выдача — по желанию (техника уже на объекте). */
async function takeInWork(
  id: string,
  over: { lessorId?: string; actualFrom?: string } = {},
): Promise<Injected> {
  return changeStatus(id, 'confirmed', {
    deal: { lessorId: over.lessorId ?? ctx.mechLessorId, rate: 1200, rateUnit: 'hour' },
    ...(over.actualFrom ? { actualFrom: over.actualFrom } : {}),
  });
}

/** Полный факт возврата: четыре значения, без любого из которых закрывать нечего. */
const COMPLETION = {
  actualFrom: yesterday,
  actualTo: today,
  actualUnits: 26,
  finalCost: 31200,
};

async function issue(id: string, actualFrom = today): Promise<Injected> {
  return call('POST', `/${id}/issue`, { actualFrom, version: await version(id) });
}

async function revokeIssue(id: string, reason = 'Отметили выдачу по ошибке'): Promise<Injected> {
  return call('POST', `/${id}/issue-revoke`, { reason, version: await version(id) });
}

async function history(id: string): Promise<RequestHistoryEntryDto[]> {
  const res = await call('GET', `/${id}/history`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestHistoryEntryDto[];
}

/** Номера заявок, отобранных списком: отбор всегда сужается своим номером — база общая. */
async function listNums(query: string): Promise<number[]> {
  const res = await call('GET', `/?pageSize=50&${query}`);
  return ((ok(res) as { items: MechRequestDto[] }).items ?? []).map((r) => r.num);
}

// ── Инструмент гонок: держатель строки и барьер очереди ──

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Третья сессия, которая держит спорную строку, пока обе двери встают в очередь.
 *
 * Своим соединением, а не транзакцией пула: пул отдаёт соединения приложению, и держатель,
 * занявший одно из них, спорил бы сам с собой. `pid` нужен барьеру — по нему видно, кого именно
 * ждут двери, и соседний файл, работающий с той же базой параллельно, барьер не обманет.
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
 *
 * `pg_blocking_pids` вместо `wait_event_type = 'Lock'` намеренно: считаются только те, кого держит
 * **этот** держатель. Иначе барьер снимала бы блокировка соседнего db-теста, и двери стартовали бы
 * вразнобой — то есть тест мерил бы удачу.
 *
 * Обход рекурсивный, и это не украшение: второй ждущий за той же строкой ждёт не держателя, а
 * **первого ждущего** — блокировку кортежа отдают по очереди, и `pg_blocking_pids` называет ему
 * только соседа. Очередь из двух — ровно то, ради чего барьер и заведён: она задаёт ПОРЯДОК, в
 * котором двери получат строку, и без неё «кто победил» решал бы планировщик.
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
 * строкой раньше второй, поэтому и получит строку первой.
 *
 * Тела дверей строятся ЗАРАНЕЕ (версия и тело запроса читаются до захвата): обе обязаны выйти из
 * одного и того же состояния карточки — иначе вторая читала бы уже изменённую строку, то есть
 * никакой гонки не было бы вовсе.
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

describe.skipIf(!DB_URL)('механизация: цикл, барьеры и гонки (ADR 0152)', () => {
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
        middleName: 'Механизационный',
        passwordHash: await hashPassword(PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: OBJECT_CODE,
        name: `Площадка механизации ${RUN}`,
        address: 'г. Москва, тестовый проезд, 1',
      })
      .returning({ id: schema.constructionObjects.id });
    const counterparty = async (
      type: 'mech_lessor' | 'vehicle_lessor' | 'operator',
      name: string,
      isActive = true,
    ): Promise<string> => {
      const [row] = await db
        .insert(schema.counterparties)
        .values({ type, name: `${name} ${RUN}`, inn: nextInn(), isActive, comment: MARK })
        .returning({ id: schema.counterparties.id });
      return row!.id;
    };

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
      mechLessorId: await counterparty('mech_lessor', 'Арендодатель механизации'),
      vehicleLessorId: await counterparty('vehicle_lessor', 'Арендодатель ТС'),
      operatorId: await counterparty('operator', 'Перевозчик'),
      inactiveLessorId: await counterparty('mech_lessor', 'Погашенный арендодатель', false),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    // Порядок обратный ссылкам: заявка держит и площадку, и автора, и контрагента.
    await ctx.db.execute(
      sql`DELETE FROM mech_requests WHERE object_id IN
            (SELECT id FROM construction_objects WHERE code = ${OBJECT_CODE})`,
    );
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${OBJECT_CODE}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Договорённость на входе в работу (Р7, Р8) ──

  it('в работу не берут без арендодателя и без ставки', async () => {
    const request = await newRequest();

    // Без договорённости вовсе: отказ приходит от сервера, а не пятисотым от CHECK'а базы.
    const bare = await changeStatus(request.id, 'confirmed');
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json().message).toContain('Укажите арендодателя');

    // Половина договорённости — не договорённость: арендодатель без цены не отвечает на «почём».
    const priceless = await changeStatus(request.id, 'confirmed', {
      deal: { lessorId: ctx.mechLessorId, rateUnit: 'hour' },
    });
    expect(priceless.statusCode, priceless.body).toBe(400);

    // Заявка не сдвинулась ни на одном отказе: неудавшийся переход не тронул ни статус, ни версию.
    const untouched = await card(request.id);
    expect(untouched.status).toBe('new');
    expect(untouched.version).toBe(request.version);

    const taken = ok(await takeInWork(request.id)) as unknown as MechRequestDto;
    expect(taken.status).toBe('confirmed');
    expect(taken.lessorId).toBe(ctx.mechLessorId);
    expect(taken.rate).toBe(1200);
  }, 60_000);

  it('арендодателем бывает только арендодатель, и только не погашенный', async () => {
    const foreign = await newRequest();
    const wrongType = await takeInWork(foreign.id, { lessorId: ctx.operatorId });
    expect(wrongType.statusCode, wrongType.body).toBe(400);
    expect(wrongType.json().message).toContain('Арендодателем может быть контрагент типа');

    // Погашенный контрагент существует и ключом бы прошёл: «его можно выбрать сегодня» — вопрос
    // сервиса, а не составного ключа, и отвечает на него он.
    const dead = await takeInWork(foreign.id, { lessorId: ctx.inactiveLessorId });
    expect(dead.statusCode, dead.body).toBe(400);
    expect(dead.json().message).toContain('неактивен');

    // Арендодатель ТС механизации не сдаёт (решение заказчика 02.09.2026, разворот Р6). Здесь стоял
    // обратный случай: тип принимался, потому что одна компания сдаёт и то, и другое. Заказчик
    // увидел таких контрагентов в списке выбора и это отверг — и проверка ловит теперь именно
    // отказ, потому что сервер обязан спрашивать ровно то же, что предлагает форма.
    //
    // Ограничение базы к обоим типам по-прежнему терпимо: за строгость отвечает сервис, и цена
    // ошибки в нём — внятный отказ, а не ошибка целостности.
    const vehicleOnly = await takeInWork(foreign.id, { lessorId: ctx.vehicleLessorId });
    expect(vehicleOnly.statusCode, vehicleOnly.body).toBe(400);
    expect(vehicleOnly.json().fields?.lessorId).toBe('Нужен арендодатель механизации');
  }, 60_000);

  // ── Выдача, снятие отметки и отмена (Р2) ──

  it('выданное не отменяют, а после снятия отметки — снова отменяют', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id));
    ok(await issue(request.id, yesterday));

    const cancelled = await changeStatus(request.id, 'cancelled', { comment: 'Передумали' });
    expect(cancelled.statusCode, cancelled.body).toBe(422);
    expect(cancelled.json().message).toContain('завершить, а не отменять');

    const revoked = ok(await revokeIssue(request.id)) as unknown as MechRequestDto;
    // Снятие обнуляет факт целиком и оставляет договорённость: лечится опечатка, а не аренда.
    expect(revoked.actualFrom).toBeNull();
    expect(revoked.lessorId).toBe(ctx.mechLessorId);

    // Событие — единственный носитель факта: после снятия строка снова выглядит невыданной, и что
    // выдача была и почему её сняли, не помнит больше ничто.
    const entry = (await history(request.id)).find((e) => e.kind === 'mechIssueRevoked');
    expect(entry, 'снятие отметки обязано попасть в историю карточки').toBeDefined();
    expect(entry!.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(['actualFrom', 'issueRevokeReason']),
    );

    ok(await changeStatus(request.id, 'cancelled', { comment: 'Передумали' }));
  }, 60_000);

  it('снимать отметку не с чего: повторно, без выдачи, у отменённой и у коррекции', async () => {
    // Доступность снятия — это ВЕСЬ предикат действующей аренды, а не одно пустое `actual_to`.
    // Каждое из трёх его условий проверяется своим случаем: снимешь любое — один из них пройдёт.
    const running = await newRequest();
    ok(await takeInWork(running.id, { actualFrom: yesterday }));
    ok(await revokeIssue(running.id));
    const twice = await revokeIssue(running.id);
    expect(twice.statusCode, twice.body).toBe(422);
    expect(twice.json().message).toContain('Снимать отметку не с чего');

    const awaiting = await newRequest();
    ok(await takeInWork(awaiting.id));
    expect((await revokeIssue(awaiting.id)).statusCode).toBe(422);

    const cancelled = await newRequest();
    ok(await takeInWork(cancelled.id));
    ok(await changeStatus(cancelled.id, 'cancelled', { comment: 'Не понадобилась' }));
    expect((await revokeIssue(cancelled.id)).statusCode).toBe(422);

    // Коррекция завершения: техника ВОЗВРАЩЕНА, и снимать выдачу у неё нечего — заявку доводят
    // повторным завершением. Именно этот случай отсекается третьим условием предиката.
    const correction = await newRequest();
    ok(await takeInWork(correction.id, { actualFrom: yesterday }));
    ok(await changeStatus(correction.id, 'done', { completion: COMPLETION }));
    ok(await changeStatus(correction.id, 'confirmed'));
    expect((await revokeIssue(correction.id)).statusCode).toBe(422);
  }, 60_000);

  // ── Откаты (Р8) ──

  it('откат в «Новую» закрыт и у действующей аренды, и у коррекции завершения', async () => {
    // Запрет не следствие запрета отмены, а отдельный барьер: `confirmed → new` стирает
    // договорённость и факт по построению, и без него была бы дверь из трёх шагов в обход запрета
    // на удаление действующей аренды — откат, всё стёрлось, физическое удаление «Новой».
    const running = await newRequest();
    ok(await takeInWork(running.id, { actualFrom: yesterday }));
    const back = await changeStatus(running.id, 'new', { comment: 'Взяли по ошибке' });
    expect(back.statusCode, back.body).toBe(422);
    expect(back.json().message).toContain('снимите отметку выдачи');
    // Удаление той же строки закрыто тем же правилом — иначе обход существовал бы и без отката.
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${running.id}?version=${await version(running.id)}`,
      headers: ctx.auth,
    });
    expect(deleted.statusCode, deleted.body).toBe(422);

    // Коррекция завершения — тем же путём: техника возвращена, деньги посчитаны, и откат в «Новую»
    // унёс бы и то, и другое.
    const correction = await newRequest();
    ok(await takeInWork(correction.id, { actualFrom: yesterday }));
    ok(await changeStatus(correction.id, 'done', { completion: COMPLETION }));
    ok(await changeStatus(correction.id, 'confirmed'));
    const rolled = await changeStatus(correction.id, 'new', { comment: 'Отменяем целиком' });
    expect(rolled.statusCode, rolled.body).toBe(422);

    // А после снятия отметки тот же откат проходит — и требует причины: без неё в истории осталась
    // бы пара переходов, по которой не понять, за что сняли арендодателя и цену.
    ok(await revokeIssue(running.id));
    const silent = await changeStatus(running.id, 'new');
    expect(silent.statusCode, silent.body).toBe(400);
    expect(silent.json().fields?.comment).toBeTruthy();
    const cleared = ok(
      await changeStatus(running.id, 'new', { comment: 'Взяли по ошибке' }),
    ) as unknown as MechRequestDto;
    expect(cleared.status).toBe('new');
    expect(cleared.lessorId).toBeNull();
    expect(cleared.rate).toBeNull();
  }, 60_000);

  it('цепочка «в работу → отмена → новая» не сохраняет ни арендодателя, ни цену', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id));
    // Отмена договорённость БЕРЕЖЁТ: отменённая заявка остаётся историей того, с кем и почём
    // договаривались, и её ещё могут откатить обратно.
    const cancelled = ok(
      await changeStatus(request.id, 'cancelled', { comment: 'Площадка отказалась' }),
    ) as unknown as MechRequestDto;
    expect(cancelled.lessorId).toBe(ctx.mechLessorId);
    expect(cancelled.rate).toBe(1200);

    // А вход в «Новую» стирает её при ЛЮБОМ переходе, а не только прямым откатом: иначе цепочка из
    // двух ходов возвращала бы заявку чистым листом с сохранённой ценой.
    const back = ok(
      await changeStatus(request.id, 'new', { comment: 'Заведём заново' }),
    ) as unknown as MechRequestDto;
    expect(back.lessorId).toBeNull();
    expect(back.lessorType).toBeNull();
    expect(back.rate).toBeNull();
    expect(back.rateUnit).toBeNull();
  }, 60_000);

  it('откат «Выполнена → В работе» бережёт факт и не возвращает заявку в аренды', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id, { actualFrom: yesterday }));
    ok(await changeStatus(request.id, 'done', { completion: COMPLETION }));
    const rolled = ok(await changeStatus(request.id, 'confirmed')) as unknown as MechRequestDto;

    // Факт цел: повторное закрытие обходится уже предъявленными числами, а не вводится заново.
    expect(rolled.status).toBe('confirmed');
    expect(rolled.actualFrom).toBe(yesterday);
    expect(rolled.actualTo).toBe(today);
    expect(rolled.actualUnits).toBe(26);
    expect(rolled.finalCost).toBe(31200);

    // И ровно поэтому присутствие спрашивается всеми тремя условиями сразу: по одному
    // `actual_from` возвращённая техника снова оказалась бы во вкладке «В аренде», в сводке и в
    // расчёте просрочки. Отбор списка идёт в SQL, и разойтись с предикатом контрактов ему нельзя.
    expect(await listNums(`num=${rolled.num}&rental=true`)).toEqual([]);
    expect(await listNums(`num=${rolled.num}&rental=false`)).toEqual([rolled.num]);
    expect(await listNums(`num=${rolled.num}&overdue=true`)).toEqual([]);

    // Сводка считает теми же предикатами: разойдись они — вкладка показывала бы одно, а число над
    // ней другое.
    const summary = ok(await call('GET', `/summary?placeObjectId=${ctx.objectId}`)) as {
      rental: number;
    };
    const running = await newRequest();
    ok(await takeInWork(running.id, { actualFrom: yesterday }));
    const after = ok(await call('GET', `/summary?placeObjectId=${ctx.objectId}`)) as {
      rental: number;
    };
    expect(after.rental).toBe(summary.rental + 1);
    expect(await listNums(`num=${running.num}&rental=true`)).toEqual([running.num]);
  }, 60_000);

  // ── Завершение (Р7) ──

  it('завершение без дат, без отработанного и без суммы не проходит', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id, { actualFrom: yesterday }));

    // Без факта вовсе: расчёт `actual_units × rate` не с чем сверять, а сумма ниоткуда не берётся.
    const bare = await changeStatus(request.id, 'done');
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json().message).toContain('Укажите фактические даты');

    // Факт неделим: каждая из четырёх частей отвечает на свой вопрос закрытой заявки, и без любой
    // из них закрывать нечего. Проверяются все четыре — пропущенная означала бы, что схема
    // требует только три.
    for (const missing of ['actualFrom', 'actualTo', 'actualUnits', 'finalCost'] as const) {
      const completion: Record<string, unknown> = { ...COMPLETION };
      delete completion[missing];
      const res = await changeStatus(request.id, 'done', { completion });
      expect(res.statusCode, `${missing}: ${res.body}`).toBe(400);
    }

    const done = ok(
      await changeStatus(request.id, 'done', { completion: COMPLETION }),
    ) as unknown as MechRequestDto;
    expect(done.status).toBe('done');
    expect(done.finalCost).toBe(31200);
  }, 60_000);

  it('фактическая дата не бывает будущей, а «сегодня» считается по Москве', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id));

    const future = await issue(request.id, tomorrow);
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json().fields?.actualFrom).toBe(MECH_FUTURE_DATE_MESSAGE);

    /*
     * Пограничный случай, ради которого правила НЕТ в базе (§6 миграции 0238). `CURRENT_DATE`
     * считает день по часовому поясу сессии, а сессии приложения живут в UTC: в 00:30 МСК в Москве
     * уже новый день, а по UTC ещё вчерашний, и честное «выдана сегодня» CHECK отверг бы как
     * будущее. Считать день обязан тот, кто знает бизнес-зону, — и здесь проверяется, что считает
     * он его именно так.
     *
     * Часы подменяются только для `Date` (таймеры драйвера остаются настоящими), а вход делается
     * заново: у прежнего токена срок жизни пятнадцать минут, и по подменённым часам он истёк бы.
     */
    const moment = new Date(`${today}T21:30:00.000Z`);
    const moscowDay = moscowDateKeyOf(moment);
    expect(moscowDay, 'сцена обязана быть про сутки, разъехавшиеся с UTC').toBe(tomorrow);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(moment);
    try {
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: ADMIN_EMAIL, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      const auth = { authorization: `Bearer ${login.json().accessToken}` };
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/mech-requests/${request.id}/issue`,
        headers: auth,
        payload: { actualFrom: moscowDay, version: request.version + 1 },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().actualFrom).toBe(moscowDay);
      // А день после московского «сегодня» — по-прежнему будущее.
      const beyond = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/mech-requests/${request.id}/issue`,
        headers: auth,
        payload: { actualFrom: shiftDateKey(moscowDay, 1), version: request.version + 2 },
      });
      expect(beyond.statusCode, beyond.body).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('повтор статуса с приложенным содержимым — отказ, а не тихий успех', async () => {
    /*
     * Повтор того же статуса сам по себе — не событие, и 200 на него верен: писать переход
     * «В работе → В работе» в историю значило бы засорять её нажатиями.
     *
     * А вот повтор С СОДЕРЖИМЫМ — уже другое действие. Двойное нажатие сюда не доходит: у второго
     * запроса версия старая, и его отсекает 409 шагом раньше, — значит договорённость, дату выдачи
     * или факт возврата прислали осознанно и с актуальной версией. Тихий успех означал бы, что
     * портал показал «готово» там, где не произошло ничего: незамеченная отметка выдачи уводит
     * технику из вкладки «В аренде», а незамеченное повторное завершение теряет исправленную сумму.
     */
    const request = await newRequest();
    ok(await takeInWork(request.id));

    const redeal = await changeStatus(request.id, 'confirmed', {
      deal: { lessorId: ctx.mechLessorId, rate: 9999, rateUnit: 'shift' },
    });
    expect(redeal.statusCode, redeal.body).toBe(422);
    expect(redeal.json().fields?.deal).toBeTruthy();
    expect((await card(request.id)).rate).toBe(1200);

    const reissue = await changeStatus(request.id, 'confirmed', { actualFrom: yesterday });
    expect(reissue.statusCode, reissue.body).toBe(422);
    expect((await card(request.id)).actualFrom).toBeNull();

    // Голый повтор по-прежнему идёмпотентен и историю не пополняет.
    const before = (await history(request.id)).length;
    ok(await changeStatus(request.id, 'confirmed'));
    expect(await history(request.id)).toHaveLength(before);

    const closed = await newRequest();
    ok(await takeInWork(closed.id, { actualFrom: yesterday }));
    ok(await changeStatus(closed.id, 'done', { completion: COMPLETION }));
    const recomplete = await changeStatus(closed.id, 'done', {
      completion: { ...COMPLETION, finalCost: 55_555 },
    });
    expect(recomplete.statusCode, recomplete.body).toBe(422);
    expect(recomplete.json().message).toContain('откатите');
    expect((await card(closed.id)).finalCost).toBe(31200);
  }, 60_000);

  it('удаление насовсем не трогает ни действующую аренду, ни коррекцию завершения', async () => {
    /*
     * Через портал такая архивная строка не появляется — барьер состояния не даёт архивировать ни
     * то, ни другое, — но приходит она из прямого SQL, из старых данных и из ошибки будущей правки.
     * Поэтому состояние спрашивается и у `purge`: право открывает действие, состояние его
     * разрешает, а после `purge` восстанавливать уже нечего.
     *
     * Два случая, а не один: реализация через один предикат присутствия оставила бы коррекцию
     * завершения открытой — у неё техника возвращена, и «аренда идёт» про неё ложно.
     */
    for (const kind of ['running', 'correction'] as const) {
      const request = await newRequest();
      ok(await takeInWork(request.id, { actualFrom: yesterday }));
      if (kind === 'correction') {
        ok(await changeStatus(request.id, 'done', { completion: COMPLETION }));
        ok(await changeStatus(request.id, 'confirmed'));
      }
      // Обычное удаление обеих строк закрыто — тем же ответом и тем же текстом.
      const archived = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/mech-requests/${request.id}?version=${await version(request.id)}`,
        headers: ctx.auth,
      });
      expect(archived.statusCode, `${kind}: ${archived.body}`).toBe(422);

      // В архив строка попадает мимо портала — иначе этот случай не собрать вовсе.
      await ctx.db.execute(sql`
        UPDATE mech_requests SET deleted_at = now(), deleted_by = ${ctx.adminId}
         WHERE id = ${request.id}`);
      const purged = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/mech-requests/${request.id}/purge?version=${await version(request.id)}`,
        headers: ctx.auth,
      });
      expect(purged.statusCode, `${kind}: ${purged.body}`).toBe(422);
      const [row] = (
        await ctx.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM mech_requests WHERE id = ${request.id}`,
        )
      ).rows;
      expect(Number(row!.n), `${kind}: строка обязана остаться на месте`).toBe(1);
    }
  }, 60_000);

  // ── Гонки протокола мутаций (Р21) ──

  it('удаление, разошедшееся с отметкой выдачи, не оставляет архивной аренды', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id));
    const at = await version(request.id);

    // Опасный порядок именно этот: удаление читает «выдачи нет» и уводит строку в архив, а
    // параллельная отметка делает её действующей арендой. Останься проверка без замка и версии —
    // в архиве лежала бы техника, стоящая на площадке и стоящая денег каждый день.
    const [archived, issued] = await race(
      request.id,
      () =>
        ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/mech-requests/${request.id}?version=${at}`,
          headers: ctx.auth,
        }),
      () =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/mech-requests/${request.id}/issue`,
          headers: ctx.auth,
          payload: { actualFrom: today, version: at },
        }),
    );
    expect(archived.statusCode, archived.body).toBe(200);
    // Отметка приходит на изменившуюся под ней строку и получает 409 — «перечитай карточку», а не
    // тихий успех и не 500.
    expect(issued.statusCode, issued.body).toBe(409);

    const [row] = await ctx.db
      .execute<{ deleted: boolean; issued: boolean }>(
        sql`
      SELECT deleted_at IS NOT NULL AS deleted, actual_from IS NOT NULL AS issued
        FROM mech_requests WHERE id = ${request.id}`,
      )
      .then((r) => r.rows);
    expect(row!.deleted).toBe(true);
    expect(row!.issued, 'архивная действующая аренда — то, чего быть не должно').toBe(false);
  }, 90_000);

  it('встречные снятия отметки: второе — 409 по версии, а повторное — 422 по правилу', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id, { actualFrom: yesterday }));
    const at = await version(request.id);

    const revoke = (reason: string) => () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/mech-requests/${request.id}/issue-revoke`,
        headers: ctx.auth,
        payload: { reason, version: at },
      });
    const [first, second] = await race(request.id, revoke('Первый'), revoke('Второй'));
    expect(first.statusCode, first.body).toBe(200);
    // 409, а не 422: правило снятия к этому моменту действительно нарушено — аренда уже не идёт, —
    // но версия сверяется РАНЬШЕ предметных проверок, и человеку сказано «данные изменились».
    expect(second.statusCode, second.body).toBe(409);

    // Тот же запрос с актуальной версией отвечает уже по делу: гонки нет, снимать нечего. Эти два
    // ответа и есть проверка порядка шагов протокола — совпади они, порядок был бы не виден.
    const again = await revokeIssue(request.id);
    expect(again.statusCode, again.body).toBe(422);

    // Событие ровно одно: второе снятие не состоялось, и придумывать ему запись не из чего.
    const revokes = (await history(request.id)).filter((e) => e.kind === 'mechIssueRevoked');
    expect(revokes).toHaveLength(1);
  }, 90_000);

  it('правка срока, разошедшаяся с переводом в работу, отклоняется по версии', async () => {
    const request = await newRequest();
    const at = request.version;

    // Обе двери выходят из «Новой», где срок правится свободно. Пока правка ждала строку, заявку
    // взяли в работу — и предметный барьер («срок двигает только продление») стал бы формально
    // верным ответом на вопрос, которого человек не задавал: он правил НОВУЮ заявку.
    const [taken, edited] = await race(
      request.id,
      () =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/mech-requests/${request.id}/status`,
          headers: ctx.auth,
          payload: {
            status: 'confirmed',
            deal: { lessorId: ctx.mechLessorId, rate: 1200, rateUnit: 'hour' },
            version: at,
          },
        }),
      () =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/mech-requests/${request.id}`,
          headers: ctx.auth,
          payload: { plannedTo: shiftDateKey(today, 20), version: at },
        }),
    );
    expect(taken.statusCode, taken.body).toBe(200);
    expect(edited.statusCode, edited.body).toBe(409);
    // Отказ обязан быть про гонку, а не про правило: получи человек «оформите продление», он
    // повторил бы то же действие и получил бы тот же отказ.
    expect(edited.json().message).not.toContain('продление');
  }, 90_000);

  it('удаление насовсем, разошедшееся с восстановлением, живую заявку не трогает', async () => {
    const request = await newRequest();
    ok(await takeInWork(request.id));
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}?version=${await version(request.id)}`,
      headers: ctx.auth,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const at = await version(request.id);

    const [restored, purged] = await race(
      request.id,
      () =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/mech-requests/${request.id}/restore`,
          headers: ctx.auth,
          payload: { version: at },
        }),
      () =>
        ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/mech-requests/${request.id}/purge?version=${at}`,
          headers: ctx.auth,
        }),
    );
    expect(restored.statusCode, restored.body).toBe(200);
    // После `purge` восстанавливать было бы нечего: заявка исчезает вместе с историей и деньгами.
    // Поэтому версия сверяется до всего прочего, и разошедшийся запрос отвечает 409.
    expect(purged.statusCode, purged.body).toBe(409);

    const alive = await card(request.id);
    expect(alive.deletedAt).toBeNull();
  }, 90_000);
});
