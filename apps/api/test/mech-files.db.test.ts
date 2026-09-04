import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';
import type * as JobsNs from '../src/lib/jobs';

/**
 * Вложения заявки на аренду механизации — полный контур (ADR 0152; план
 * `docs/mechanization-module-plan.md`, Р14).
 *
 * **Зачем этому файлу база.** Файловая модель портала держится на функции БД
 * `file_is_linked(uuid)`: модуль, о котором она не знает, отдаёт свои вложения загрузившему их
 * человеку БЕССРОЧНО — `decideFileAccess` считает такой файл ничьим, а ничей файл доступен автору
 * загрузки. Спросить это на подменах нельзя в принципе: подмена вернёт то, что в неё положили, а
 * вопрос стоит ровно обратный — знает ли НАСТОЯЩАЯ функция про НАСТОЯЩУЮ таблицу связи.
 *
 * Тем же объясняются три сценария удаления. Путей осиротения файла три, у каждого свой способ
 * (Р14), и различить их можно только по строке `files` и по задаче в `jobs`:
 *
 * | Путь                          | Что обязано случиться                                   |
 * | ----------------------------- | ------------------------------------------------------- |
 * | снятие вложения правкой       | связь снята, файл помечен удалённым, снос ОТЛОЖЕН на 30 дней |
 * | физическое удаление «Новой»   | строки `files` нет вовсе, снос НЕМЕДЛЕННЫЙ              |
 * | `records.purge` архивной      | то же самое                                             |
 *
 * Разница между отложенным и немедленным сносом не косметическая: отвязанный правкой файл человек
 * мог снять по ошибке и приложить обратно, а удаляемая заявка уносит свои файлы сразу —
 * восстанавливать нечего. Оба состояния видны только в базе.
 *
 * **Чего файл не проверяет.** Область и пару «отдел ↔ площадка» — `mech-scope.db.test.ts`; цикл и
 * переходы — `mech-cycle.db.test.ts`; полноту перечня таблиц в `file_is_linked` со стороны схемы —
 * `file-linkage.db.test.ts`; решение о доступе как чистую функцию — `file-access.test.ts`.
 *
 * Запуск — как у остальных db-тестов (общая база, поимённо):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-files.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-files-${RUN}`;
/** «яя» в начале кода — чтобы объект не стал первым у соседних тестов с `ORDER BY … LIMIT 1`. */
const CODE_PREFIX = `яя-MECHFILES-${RUN}`;
/** По этому префиксу идёт и уборка: упавший прогон оставляет файлы и задачи на их снос. */
const KEY_PREFIX = `db-mech-files-${RUN}/`;

const TODAY = moscowDateKeyOf(new Date());
const PLANNED_TO = shiftDateKey(TODAY, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  jobs: typeof JobsNs;
  closeDb: () => Promise<void>;
  objects: { first: string; second: string };
  users: { admin: string; manager: string; site: string; siteOther: string };
  lessorId: string;
  /** Модель из справочника: с Э2 предмет аренды выбирается строго из него (ADR 0156). */
  modelId: string;
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
  // Ссылка на скачивание подписывается локально, в хранилище никто не ходит: заглушки нерабочие
  // намеренно — тест проверяет решение о доступе, а не S3.
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
 * Уборка своих строк — и перед прогоном тоже. Порядок задан ссылками: задачи на снос, аудит,
 * заявки (за ними каскадом связи с файлами), файлы, учётки и только в конце объекты — их держит
 * `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const emailLike = `${EMAIL_PREFIX}%`;
  const keyLike = `${KEY_PREFIX}%`;
  const users = sql`(SELECT id FROM users WHERE email LIKE ${emailLike})`;
  await db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${keyLike}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
  await db.execute(sql`DELETE FROM mech_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${keyLike}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emailLike}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM counterparties WHERE comment = ${CODE_PREFIX}`);
  // Модели — после заявок: ссылка стоит с `ON DELETE RESTRICT`.
  await db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-files-${RUN}`}`);
}

// ── Подопытные ──

async function newObject(tag: string): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.constructionObjects)
    .values({
      code: `${CODE_PREFIX}-O${seq}-${tag}`,
      name: `Площадка ${tag} ${RUN}`,
      address: 'г. Москва, тестовый проезд, 2',
    })
    .returning({ id: ctx.schema.constructionObjects.id });
  return row!.id;
}

async function newUser(
  tag: string,
  role: 'admin' | 'manager' | 'site',
  objectIds: string[] = [],
): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  for (const constructionObjectId of objectIds) {
    await ctx.db
      .insert(ctx.schema.userConstructionObjects)
      .values({ userId: row!.id, constructionObjectId });
  }
  return row!.id;
}

/**
 * Загруженный файл. Заводится прямой вставкой: предмет теста — не загрузка в S3, а то, что
 * происходит со строкой `files` дальше. `active` потому, что ссылку на скачивание маршрут отдаёт
 * только по активному файлу, а привязка сама переводит `pending` в `active`.
 */
async function newFile(uploaderId: string): Promise<{ id: string; objectKey: string }> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${KEY_PREFIX}${randomUUID()}`,
      filename: `счёт-${seq}.pdf`,
      contentType: 'application/pdf',
      size: 2048,
      status: 'active',
      uploadedBy: uploaderId,
    })
    .returning({ id: ctx.schema.files.id, objectKey: ctx.schema.files.objectKey });
  return row!;
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

async function createRequest(
  headers: Headers,
  objectId: string,
  fileIds: string[],
): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/mech-requests',
    headers,
    payload: {
      objectId,
      mechModelId: ctx.modelId,
      plannedFrom: TODAY,
      plannedTo: PLANNED_TO,
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9261234567',
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: механизация, вложения',
      fileIds,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const dto = res.json();
  expect(dto.files).toHaveLength(fileIds.length);
  return { id: dto.id, version: dto.version };
}

function download(headers: Headers, fileId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/files/${fileId}/download`,
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

/** Ответ настоящей функции БД, а не пересказ её списка таблиц в тесте. */
async function isLinked(fileId: string): Promise<boolean> {
  const res = await ctx.db.execute<{ linked: boolean }>(
    sql`SELECT file_is_linked(${fileId}) AS linked`,
  );
  return res.rows[0]!.linked;
}

async function fileRow(
  fileId: string,
): Promise<{ status: string; deletedAt: Date | null } | undefined> {
  const [row] = await ctx.db
    .select({ status: ctx.schema.files.status, deletedAt: ctx.schema.files.deletedAt })
    .from(ctx.schema.files)
    .where(eq(ctx.schema.files.id, fileId));
  return row;
}

async function linkRowCount(fileId: string): Promise<number> {
  const rows = await ctx.db
    .select({ fileId: ctx.schema.mechRequestFiles.fileId })
    .from(ctx.schema.mechRequestFiles)
    .where(eq(ctx.schema.mechRequestFiles.fileId, fileId));
  return rows.length;
}

/** Задача на снос объекта из S3: по ней и различаются отложенный и немедленный пути (Р14). */
async function deletionJob(objectKey: string): Promise<{ type: string; nextRunAt: Date }> {
  const rows = await ctx.db
    .select({ type: ctx.schema.jobs.type, nextRunAt: ctx.schema.jobs.nextRunAt })
    .from(ctx.schema.jobs)
    .where(sql`${ctx.schema.jobs.payload}->>'objectKey' = ${objectKey}`);
  expect(rows, `задача на снос ${objectKey}`).toHaveLength(1);
  return rows[0]!;
}

describe.skipIf(!DB_URL)('механизация: вложения и доступ к ним (ADR 0152, Р14)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    const jobs = await import('../src/lib/jobs');
    const app = await buildApp();
    ctx = {
      app,
      db,
      schema,
      tokens,
      jobs,
      closeDb,
      objects: {} as Ctx['objects'],
      users: {} as Ctx['users'],
      lessorId: '',
      modelId: '',
    };
    await cleanup(db);

    ctx.objects = { first: await newObject('first'), second: await newObject('second') };
    ctx.users = {
      admin: await newUser('admin', 'admin'),
      manager: await newUser('manager', 'manager'),
      site: await newUser('site', 'site', [ctx.objects.first]),
      siteOther: await newUser('siteOther', 'site', [ctx.objects.second]),
    };
    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: `Арендодатель механизации ${RUN}`,
        inn: String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10),
        comment: CODE_PREFIX,
        isActive: true,
      })
      .returning({ id: schema.counterparties.id });
    ctx.lessorId = lessor!.id;
    // Своя строка справочника на прогон, а не позиция сида: база общая, и заявка, сославшаяся на
    // общую модель, помешала бы соседнему файлу её гасить и сносить. Код — kebab-case латиницей
    // (`mech_models_code_format_check`).
    const [model] = await db
      .insert(schema.mechModels)
      .values({ code: `mech-files-${RUN}`, name: `Генератор ${RUN}` })
      .returning({ id: schema.mechModels.id });
    ctx.modelId = model!.id;
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('привязанное вложение перестаёт быть свободным, и автор загрузки теряет к нему доступ', async () => {
    const site = await headersOf(ctx.users.site);
    const other = await headersOf(ctx.users.siteOther);
    const file = await newFile(ctx.users.site);

    // До привязки файл ничей — и виден только автору загрузки: так работает форма, где файл
    // грузится до сохранения заявки.
    expect(await isLinked(file.id)).toBe(false);
    expect((await download(site, file.id)).statusCode).toBe(200);
    // `404`, а не `403`, — с ADR 0160 (решение 6) отказ в доступе к файлу неотличим от «нет такого
    // файла», и одинаково во всех модулях: разные коды позволяли бы перебором идентификаторов
    // читать, сколько документов лежит в чужой заявке. Ответ маршрута сменился, поведение — нет.
    expect((await download(other, file.id)).statusCode).toBe(404);

    const request = await createRequest(site, ctx.objects.first, [file.id]);
    // Ветка модуля в `file_is_linked` (миграция 0238): без неё файл остался бы «ничьим», то есть
    // доступным автору загрузки бессрочно и удаляемым им в обход заявки.
    expect(await isLinked(file.id)).toBe(true);

    // Теперь файл живёт по правилам заявки: автору он виден потому, что видна она.
    expect((await download(site, file.id)).statusCode).toBe(200);
    // Чужая площадка вложения не открывает: право читать модуль есть у обоих, а область — нет.
    // Код — `404` (ADR 0160, решение 6): «не тебе» и «нет такого» отвечают одинаково.
    expect((await download(other, file.id)).statusCode).toBe(404);

    // И вынуть документ из заявки в обход её формы автор тоже не может.
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/files/${file.id}`,
      headers: site,
    });
    expect(removed.statusCode, removed.body).toBe(409);

    // Заявку перевели на другую площадку — она перестала быть видна автору загрузки. Ветка
    // авторства не должна вернуть ему доступ: файл уже не ничей.
    const moved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/mech-requests/${request.id}`,
      headers: await headersOf(ctx.users.admin),
      payload: { objectId: ctx.objects.second, version: await versionOf(request.id) },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    expect((await download(site, file.id)).statusCode).toBe(404);
    expect((await download(other, file.id)).statusCode).toBe(200);
  });

  it('снятие вложения правкой уводит файл в отложенное удаление', async () => {
    const office = await headersOf(ctx.users.manager);
    const file = await newFile(ctx.users.manager);
    const request = await createRequest(office, ctx.objects.first, [file.id]);

    const edited = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/mech-requests/${request.id}`,
      headers: office,
      payload: { removeFileIds: [file.id], version: await versionOf(request.id) },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().files).toHaveLength(0);

    // Снять одну связь мало: запись в `files` осталась бы живой и ничьей, а автор загрузки получил
    // бы к ней доступ обратно — та же дыра, что пропущенная ветка `file_is_linked`, с третьего
    // конца.
    expect(await linkRowCount(file.id)).toBe(0);
    expect(await isLinked(file.id)).toBe(false);
    const row = await fileRow(file.id);
    expect(row?.status).toBe('deleted');
    expect(row?.deletedAt).not.toBeNull();

    // Снос ОТЛОЖЕН: человек мог снять вложение по ошибке и приложить обратно.
    const job = await deletionJob(file.objectKey);
    expect(job.type).toBe(ctx.jobs.JOB_DELETE_S3_OBJECT);
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    // Автор доступа не вернул: помеченный удалённым файл маршрут не отдаёт вовсе.
    expect((await download(office, file.id)).statusCode).toBe(404);
  });

  it('физическое удаление «Новой» уносит вложение вместе с заявкой', async () => {
    const office = await headersOf(ctx.users.manager);
    const file = await newFile(ctx.users.manager);
    const request = await createRequest(office, ctx.objects.first, [file.id]);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}?version=${await versionOf(request.id)}`,
      headers: office,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    // «Новая» стирается физически: просьба, о которой передумали, историей не является.
    expect(removed.json().mode).toBe('hard');

    // Связь ушла каскадом, а сама строка `files` — защищённым `hardDeleteFiles`: каскад её не
    // трогает, и без второго шага файл остался бы живым и ничьим.
    expect(await fileRow(file.id)).toBeUndefined();
    const job = await deletionJob(file.objectKey);
    expect(job.type).toBe(ctx.jobs.JOB_DELETE_S3_OBJECT);
    // Снос НЕМЕДЛЕННЫЙ: восстанавливать нечего — заявки уже нет.
    expect(job.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS);

    expect((await download(office, file.id)).statusCode).toBe(404);
  });

  it('удаление насовсем архивной заявки уносит вложение так же, как физическое удаление «Новой»', async () => {
    const office = await headersOf(ctx.users.manager);
    const admin = await headersOf(ctx.users.admin);
    const file = await newFile(ctx.users.manager);
    const request = await createRequest(office, ctx.objects.first, [file.id]);

    // Архивируется только заявка после «Новой»: «Новую» портал стирает физически, и `purge` для
    // неё был бы недостижим.
    const inWork = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/mech-requests/${request.id}/status`,
      headers: office,
      payload: {
        status: 'confirmed',
        version: await versionOf(request.id),
        deal: { lessorId: ctx.lessorId, rate: 900, rateUnit: 'shift' },
      },
    });
    expect(inWork.statusCode, inWork.body).toBe(200);
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}?version=${await versionOf(request.id)}`,
      headers: office,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().mode).toBe('soft');
    // Архивная заявка вложений не отдаёт — ни автору загрузки, ни площадке: архив открывает
    // карточку, а не прямую ссылку на файл. Приоткрыт архив только у заявок на обслуживание
    // оргтехники и только держателю `archive.read` (ADR 0160, решение 6); у механизации решение
    // прежнее. Код отказа — `404`, общий для всех модулей с того же решения.
    expect((await download(office, file.id)).statusCode).toBe(404);

    const purged = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}/purge?version=${await versionOf(request.id)}`,
      headers: admin,
    });
    expect(purged.statusCode, purged.body).toBe(200);

    const [gone] = await ctx.db
      .select({ id: ctx.schema.mechRequests.id })
      .from(ctx.schema.mechRequests)
      .where(eq(ctx.schema.mechRequests.id, request.id));
    expect(gone).toBeUndefined();
    expect(await fileRow(file.id)).toBeUndefined();
    const job = await deletionJob(file.objectKey);
    expect(job.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect((await download(office, file.id)).statusCode).toBe(404);
  });
});
