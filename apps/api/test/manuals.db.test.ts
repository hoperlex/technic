import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ManualDto, Role } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Руководства пользователя на живой схеме (`docs/manuals-plan.md`, этапы 2 и 5).
 *
 * **Зачем это db-тест, а не проверка обработчика.** Заявление маршрута — «режима два, и различает
 * их право, а не адрес»: список читает любой вошедший, а снятые с публикации видит только держатель
 * `manuals.manage`. Проверяется это только настоящим входом, потому что подменённый принципал
 * доказывал бы ветку `can(...)`, а не то, что она вообще спрошена у того, кто пришёл.
 *
 * **Обе ветки, и положительная не менее важна отрицательной.** Реализация, которая показывает
 * активные вообще всем, прошла бы отрицательную половину целиком — и сломала бы вкладку ведения,
 * где снятое с публикации руководство обязано быть видно. Поэтому у держателя права проверяются
 * все три состояния фильтра: без него, `true` и `false`.
 *
 * **Общий прогон.** Свои строки помечены префиксом в названии, уборка идёт по нему же и по адресам
 * учёток; утверждений обо всей таблице тест не делает — рядом лежит руководство, заведённое
 * миграцией 0158, и оно к прогону отношения не имеет.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/manuals.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-manuals';
/** Уникальный хвост прогона: адрес учётки уникален в базе, а название — отбор своих руководств. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const TITLE_PREFIX = `db-manuals-${RUN}`;

const PASSWORD = 'db-test-password-123';

/** Страница заведомо больше числа руководств в базе: `total` сверяется с длиной ответа. */
const WHOLE_LIST = 'pageSize=500';

interface Account {
  id: string;
  email: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  /** Держатель `manuals.manage`: у администратора есть все права словаря. */
  keeper: Account;
  /** Диспетчер: `manuals.manage` у него нет — то есть это «любой вошедший». */
  reader: Account;
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
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
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
 * Уборка. Порядок обязателен: записи журнала уходят первыми — `audit_log.actor_user_id` стоит под
 * `ON DELETE SET NULL`, и удалённая учётка не уносит свои события, а обезличивает их, после чего
 * найти их по автору уже нечем.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'manual' AND actor_user_id IN (
    SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM app_manuals WHERE title LIKE ${`${TITLE_PREFIX}%`}`);
}

/** Учётка с настоящим входом: право спрашивается у принципала, собранного из базы. */
async function newAccount(role: Role, suffix: string): Promise<Account> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${suffix}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Пользователь',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { id: created!.id, email, auth: { authorization: `Bearer ${accessToken}` } };
}

// ── Ручки руководств ──

function listManuals(account: Account, query = WHOLE_LIST) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/manuals?${query}`,
    headers: account.auth,
  });
}

function postManual(account: Account, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/manuals',
    headers: account.auth,
    payload: body,
  });
}

function patchManual(account: Account, id: string, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/manuals/${id}`,
    headers: account.auth,
    payload: body,
  });
}

function deleteManual(account: Account, id: string) {
  return ctx.app.inject({ method: 'DELETE', url: `/api/v1/manuals/${id}`, headers: account.auth });
}

interface Page {
  items: ManualDto[];
  total: number;
}

/**
 * Страница списка вместе со сверкой `total` с длиной ответа. Сверка стоит здесь, а не отдельным
 * тестом, потому что она обязана выполняться на **каждом** запросе: счётчик, посчитанный другим
 * предикатом, рассказывал бы про строки, которых в ответе нет, — и заметить это можно только там,
 * где страница заведомо вмещает всё.
 */
async function page(account: Account, query = WHOLE_LIST): Promise<Page> {
  const res = await listManuals(account, query);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<Page>();
  expect(body.total, `total и длина списка разошлись (${query})`).toBe(body.items.length);
  return body;
}

/**
 * Названия своих строк в порядке ответа. Метка сужает отбор до строк одного теста: соседние тесты
 * заводят руководства в той же таблице, и утверждение о порядке, написанное по всему прогону,
 * зависело бы от того, кто отработал раньше.
 */
function ownTitles(body: Page, marker = ''): string[] {
  const prefix = marker ? `${TITLE_PREFIX} ${marker}` : TITLE_PREFIX;
  return body.items.filter((m) => m.title.startsWith(prefix)).map((m) => m.title);
}

/** Руководство прямо в базе: заведение маршрутом проверяется отдельно и своими ожиданиями. */
async function seedManual(
  suffix: string,
  over: Partial<{ sortOrder: number; isActive: boolean; description: string }> = {},
): Promise<{ id: string; title: string }> {
  const title = `${TITLE_PREFIX} ${suffix}`;
  const [row] = await ctx.db
    .insert(ctx.schema.appManuals)
    .values({
      title,
      url: `https://disk.360.yandex.ru/i/${RUN}-${suffix}`,
      description: over.description ?? '',
      sortOrder: over.sortOrder ?? 100,
      isActive: over.isActive ?? true,
    })
    .returning({ id: ctx.schema.appManuals.id });
  return { id: row!.id, title };
}

interface AuditRow {
  action: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
}

async function auditOf(manualId: string): Promise<AuditRow[]> {
  return ctx.db
    .select({
      action: ctx.schema.auditLog.action,
      actorUserId: ctx.schema.auditLog.actorUserId,
      metadata: ctx.schema.auditLog.metadata,
    })
    .from(ctx.schema.auditLog)
    .where(
      and(eq(ctx.schema.auditLog.entityType, 'manual'), eq(ctx.schema.auditLog.entityId, manualId)),
    ) as Promise<AuditRow[]>;
}

describe.skipIf(!DB_URL)('руководства пользователя: маршруты на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    ctx = {
      app,
      db,
      schema,
      closeDb,
      keeper: { id: '', email: '', auth: { authorization: '' } },
      reader: { id: '', email: '', auth: { authorization: '' } },
    };
    ctx.keeper = await newAccount('admin', 'keeper');
    ctx.reader = await newAccount('dispatcher', 'reader');
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Чтение: право решает, что видно, а не пускать ли ──

  it('без права приходят только опубликованные, и `isActive=false` этого не меняет', async () => {
    const live = await seedManual('живое');
    const down = await seedManual('снятое', { isActive: false });

    const plain = await page(ctx.reader);
    expect(
      plain.items.every((m) => m.isActive),
      'в списке без права есть снятые',
    ).toBe(true);
    expect(plain.items.map((m) => m.id)).toContain(live.id);
    expect(plain.items.map((m) => m.id)).not.toContain(down.id);

    // Тот же ответ, что и без параметра: без права `isActive` не игнорируется молча в пользу
    // «покажи пусто» — он подменяется на `true`. Иначе окно у обычного пользователя оставалось бы
    // пустым от одного лишнего параметра в запросе.
    const asked = await page(ctx.reader, `${WHOLE_LIST}&isActive=false`);
    expect(asked.items.map((m) => m.id)).toEqual(plain.items.map((m) => m.id));
  });

  it('с `manuals.manage` фильтр работает во всех трёх состояниях', async () => {
    const live = await seedManual('опубликованное');
    const down = await seedManual('снятое с публикации', { isActive: false });

    // Без фильтра — всё: это список вкладки ведения, и снятая строка на ней обязана быть видна.
    const all = await page(ctx.keeper);
    expect(all.items.map((m) => m.id)).toEqual(expect.arrayContaining([live.id, down.id]));

    const published = await page(ctx.keeper, `${WHOLE_LIST}&isActive=true`);
    expect(published.items.map((m) => m.id)).toContain(live.id);
    expect(published.items.map((m) => m.id)).not.toContain(down.id);

    const hidden = await page(ctx.keeper, `${WHOLE_LIST}&isActive=false`);
    expect(hidden.items.map((m) => m.id)).toContain(down.id);
    expect(hidden.items.map((m) => m.id)).not.toContain(live.id);
    expect(hidden.items.every((m) => !m.isActive)).toBe(true);
  });

  it('порядок устойчив: сначала `sortOrder`, затем название', async () => {
    // Одинаковый `sortOrder` у двух строк — обычное дело: умолчание у всех одно. Разводит их
    // название, а совпади и оно — `id`, поэтому порядок не зависит от того, как база вернёт строки.
    await seedManual('порядок — в конец', { sortOrder: 300 });
    await seedManual('порядок — Ю, по алфавиту вторая', { sortOrder: 200 });
    await seedManual('порядок — А, по алфавиту первая', { sortOrder: 200 });

    const titles = ownTitles(await page(ctx.keeper), 'порядок');
    expect(titles).toEqual([
      `${TITLE_PREFIX} порядок — А, по алфавиту первая`,
      `${TITLE_PREFIX} порядок — Ю, по алфавиту вторая`,
      `${TITLE_PREFIX} порядок — в конец`,
    ]);
    // Второй запрос тем же ответом: без добивочных ключей строки с равным `sortOrder` менялись бы
    // местами между запросами, и поймать это можно только повтором.
    expect(ownTitles(await page(ctx.keeper), 'порядок')).toEqual(titles);
  });

  // ── Запись ──

  it('вести список без права нельзя ни одной ручкой', async () => {
    const existing = await seedManual('чужое для диспетчера');
    for (const res of [
      await postManual(ctx.reader, {
        title: `${TITLE_PREFIX} от диспетчера`,
        url: 'https://disk.360.yandex.ru/i/dispatcher',
      }),
      await patchManual(ctx.reader, existing.id, { title: `${TITLE_PREFIX} переименованное` }),
      await deleteManual(ctx.reader, existing.id),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
    // Отказ не оставил следов: строка на месте и под прежним названием.
    const [row] = await ctx.db
      .select({ title: ctx.schema.appManuals.title })
      .from(ctx.schema.appManuals)
      .where(eq(ctx.schema.appManuals.id, existing.id));
    expect(row?.title).toBe(existing.title);
  });

  it('ссылка не по https отбивается', async () => {
    // Проверка живёт и в контракте, и в CHECK базы. Здесь она снимается с маршрута: по `http`
    // браузер вместо документа показал бы предупреждение, и руководство не открылось бы вовсе.
    for (const url of ['http://disk.360.yandex.ru/i/plain', 'ftp://files.example.invalid/manual']) {
      const res = await postManual(ctx.keeper, { title: `${TITLE_PREFIX} по http`, url });
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(ownTitles(await page(ctx.keeper))).not.toContain(`${TITLE_PREFIX} по http`);
  });

  it('заведение и снятие с публикации: строка появляется у всех, снятая — только у ведущего', async () => {
    const created = await postManual(ctx.keeper, {
      title: `${TITLE_PREFIX} заведённое маршрутом`,
      description: 'Пошаговое создание заявок в портале',
      url: 'https://disk.360.yandex.ru/i/jeliNg4vUBZdSw',
    });
    expect(created.statusCode, created.body).toBe(201);
    const manual = created.json<ManualDto>();
    // Умолчания приходят из контракта, а не из формы: заведённое без раздумий руководство встаёт в
    // общий ряд и сразу опубликовано.
    expect(manual).toMatchObject({ sortOrder: 100, isActive: true });
    expect((await page(ctx.reader)).items.map((m) => m.id)).toContain(manual.id);

    const patched = await patchManual(ctx.keeper, manual.id, { isActive: false });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<ManualDto>().isActive).toBe(false);
    expect((await page(ctx.reader)).items.map((m) => m.id)).not.toContain(manual.id);
    expect((await page(ctx.keeper)).items.map((m) => m.id)).toContain(manual.id);
  });

  it('очищенный «Порядок» в правке не трогает колонку `NOT NULL`', async () => {
    // Форма ведения шлёт `null` за стёртое числовое поле. Контракт читает его как «поля в правке
    // нет», и здесь проверяется последствие: правка проходит, а не падает на `NOT NULL`, и
    // порядок остаётся прежним — а не становится нулём, то есть первым в окне у всех.
    const manual = await seedManual('стёртый порядок', { sortOrder: 250 });

    const patched = await patchManual(ctx.keeper, manual.id, {
      title: `${TITLE_PREFIX} стёртый порядок, переименованное`,
      sortOrder: null,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<ManualDto>()).toMatchObject({
      title: `${TITLE_PREFIX} стёртый порядок, переименованное`,
      sortOrder: 250,
    });
  });

  it('удаление отвечает `{ ok: true }` и оставляет в журнале название и адрес', async () => {
    const url = `https://disk.360.yandex.ru/i/${RUN}-удаляемое`;
    const created = await postManual(ctx.keeper, {
      title: `${TITLE_PREFIX} удаляемое`,
      url,
    });
    expect(created.statusCode, created.body).toBe(201);
    const manual = created.json<ManualDto>();

    const removed = await deleteManual(ctx.keeper, manual.id);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    expect((await page(ctx.keeper)).items.map((m) => m.id)).not.toContain(manual.id);

    // Строки больше нет, и один `entityId` после удаления не объясняет ничего: в журнале обязаны
    // остаться название и адрес — то, чем руководство называли и куда оно вело.
    const entries = await auditOf(manual.id);
    const deletion = entries.find((e) => e.action === 'manual.delete');
    expect(deletion, 'события удаления в журнале нет').toBeDefined();
    expect(deletion!.actorUserId).toBe(ctx.keeper.id);
    expect(deletion!.metadata).toMatchObject({ title: manual.title, url });

    // Второе удаление — 404, а не молчаливый `{ ok: true }`: иначе вкладка ведения показывала бы
    // успех там, где ничего не произошло.
    expect((await deleteManual(ctx.keeper, manual.id)).statusCode).toBe(404);
  });

  it('миграция завела первое руководство — окно не открывается пустым', async () => {
    // Этап 5 плана: строка приезжает миграцией 0158, а не заводится руками после выката. Проверка
    // именно через ручку без права — так её увидит первый же вошедший пользователь.
    const seeded = (await page(ctx.reader)).items.find(
      (m) =>
        m.url === 'https://disk.360.yandex.ru/i/jeliNg4vUBZdSw' &&
        !m.title.startsWith(TITLE_PREFIX),
    );
    expect(seeded, 'руководства из миграции 0158 нет в списке').toBeDefined();
    expect(seeded).toMatchObject({
      title: 'Краткая инструкция по созданию заявок',
      description: 'Пошаговое создание заявок в портале',
      sortOrder: 100,
      isActive: true,
    });
  });

  it('выпуск журнала обновлений заведён той же миграцией', async () => {
    // Выпуски заводит миграция (ADR 0077 §3), и проверять его стоит там же, где саму работу: запись
    // без выката и выкат без записи — одинаково неправда для того, кто читает «Обновления».
    const [release] = await ctx.db
      .select({
        title: ctx.schema.appReleases.title,
        version: ctx.schema.appReleases.version,
        releasedOn: ctx.schema.appReleases.releasedOn,
        adrs: ctx.schema.appReleases.adrs,
      })
      .from(ctx.schema.appReleases)
      .where(eq(ctx.schema.appReleases.version, '0.1.24.0118'));
    expect(release, 'выпуска 0.1.24.0118 в журнале нет').toBeDefined();
    expect(release).toMatchObject({
      title: 'Руководства пользователя',
      releasedOn: '2026-08-18',
      adrs: [118],
    });
  });
});
