import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * КАРАНТИН ПО УЖЕ СНЯТОМУ ВЛОЖЕНИЮ — аварийный выход в том окне, где он и нужен (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4).
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Самый частый порядок событий — не «инцидент, потом снятие», а наоборот:
 * вложение сняли, а чужой паспорт в нём заметили через неделю. Такой файл связей не имеет, помечен
 * `deleted` и живёт в хранилище ровно до задачи сноса, поставленной на тридцатые сутки. Значит
 * карантин обязан:
 *
 * | что                                              | иначе                                                    |
 * | ------------------------------------------------ | -------------------------------------------------------- |
 * | ставиться по снятому файлу, пока объект жив      | аварийного выхода нет ровно там, где он нужен            |
 * | снимать задачу сноса                             | карантин стоит, а улика уезжает по календарю             |
 * | отвечать `404`, если объект уже уничтожен        | система обещала бы сохранность того, чего нет            |
 * | возвращать задачу при снятии карантина           | ничейный файл остался бы в хранилище навсегда            |
 * | считать тридцать суток заново                    | месяц разбора съел бы окно возврата ошибочно снятого     |
 *
 * ЗАЧЕМ БАЗА И ЗАЧЕМ ХРАНИЛИЩЕ. Предмет проверки — не ветвление в обработчике, а СОСТОЯНИЕ ОЧЕРЕДИ:
 * живая строка `jobs` и есть единственный ответ системы на вопрос «объект ещё жив». Подменить её
 * нечем — она пишется настоящим снятием вложения (`scheduleFilesDeletion`) через настоящую правку
 * заявки. Хранилище берётся настоящим ради второй половины того же утверждения: хеш, посчитанный
 * постановкой карантина, обязан совпасть с содержимым, загруженным до снятия, — это и значит «объект
 * уцелел». Без живого хранилища (`TEST_S3_*` не подняты) файл не пропускается: проверки хеша и
 * `HeadObject` тогда снимаются флагом `storeReady`, а всё про очередь и доступ проверяется как есть.
 *
 * ОБРАТНАЯ СТОРОНА ПРОВЕРЯЕТСЯ ВСЮДУ. Рядом с запертым файлом идёт близнец без карантина, и он
 * обязан вести себя как прежде: держателю права разбора он тоже `404` — иначе «право открыло
 * запертый файл» значило бы «право открывает вообще всё».
 *
 * АВТОР ЗАГРУЗКИ — ГЛАВНЫЙ ОТКАЗ СЛУЧАЯ, и у снятого файла он не формальность: ветка авторства в
 * `canAccessFile` открывает файл загрузившему, пока тот «ещё никуда не привязан», а снятое вложение
 * — ровно такой файл. До карантина его прятал только статус `deleted`; карантинный файл этот статус
 * больше не прячет (разбор обязан его читать), и единственное, что стоит между автором и чужим
 * паспортом, — приоритет карантина.
 *
 * Запуск (база и хранилище — СВОИ, общая база db-набора здесь не годится: прогон правит очередь):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55901/technic_qdet_test \
 *   TEST_S3_ENDPOINT=http://localhost:59901 TEST_S3_BUCKET=qdet-test \
 *   TEST_S3_ACCESS_KEY_ID=qdettest TEST_S3_SECRET_ACCESS_KEY=qdettestsecret \
 *     pnpm --filter @technic/api test -- file-quarantine-detached.db
 *
 * ГРАНИЦЫ. Доступ к подшитому карантинному файлу, журнал и хеш — `file-quarantine.db.test.ts`;
 * пути уноса улики (снятие, уборка, подшивка, распознавание) — `file-quarantine-evidence.db.test.ts`;
 * имя файла в лентах истории — `file-quarantine-history.db.test.ts`. Здесь только снятое вложение.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база переживает прогоны, а уборка ищет своё по нему. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
/** Префикс ключей объектов: по нему уборка находит своё, включая оставленное падением. */
const KEY_PREFIX = `qdet/${RUN}/`;
/** Те же тридцать суток, что у сервиса (`S3_DELETE_DELAY_MS`) — здесь числом для сверки сроков. */
const DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000';
const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'qdet-test';
const S3_KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID ?? 'qdettest';
const S3_SECRET = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'qdettestsecret';

type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: только заводит набор разбора и подписывает выдачи. Ручек не зовёт. */
  adminId: string;
  /** Заказчик площадки: АВТОР ЗАГРУЗКИ, он же снимает вложение. Права разбора у него нет. */
  owner: TestUser;
  /** Держатель `files.quarantineAudit` и ничего больше: роль `mechanic`, набор из одного права. */
  auditor: TestUser;
  objectId: string;
  /** Живо ли хранилище: от него зависят хеш и `HeadObject`, но не сам карантин. */
  storeReady: boolean;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // Хранилище настоящее: уцелел ли объект, доказывает только содержимое, прочитанное из него.
  process.env.S3_ENDPOINT = S3_ENDPOINT;
  process.env.S3_BUCKET = S3_BUCKET;
  process.env.S3_ACCESS_KEY_ID = S3_KEY_ID;
  process.env.S3_SECRET_ACCESS_KEY = S3_SECRET;
  process.env.S3_FORCE_PATH_STYLE = 'true';
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

/** Свой адрес на каждое обращение: и вход, и общий ограничитель считают запросы по адресу. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function quarantine(fileId: string, auth: Auth): Promise<LightMyRequestResponse> {
  return inject('POST', `/api/v1/files/${fileId}/quarantine`, auth, {
    reason: 'В карточке оказался чужой документ с персональными данными — обращение прогона',
  });
}

function release(fileId: string, auth: Auth): Promise<LightMyRequestResponse> {
  return inject('POST', `/api/v1/files/${fileId}/quarantine/release`, auth, {
    reason: 'Обращение оказалось неосновательным — прогон',
  });
}

function download(fileId: string, auth: Auth): Promise<LightMyRequestResponse> {
  return inject('GET', `/api/v1/files/${fileId}/download`, auth);
}

/**
 * Отказ по прямой ссылке — `404` и тем же текстом, что у файла, которого нет вовсе (ADR 0160,
 * решение 6). Текст проверяется потому, что `404` от стража маршрута или от опечатки в адресе
 * выглядел бы так же, а означал бы, что случай ничего не доказал.
 */
async function expectHidden(fileId: string, auth: Auth, what: string): Promise<void> {
  const res = await download(fileId, auth);
  expect(res.statusCode, `${what}: ${res.body}`).toBe(404);
  expect((res.json() as { message?: string }).message, what).toBe('Файл не найден');
}

// ── Состояние файла и очереди ──

interface FileState {
  status: string;
  deletedAt: string | null;
  quarantinedAt: string | null;
  contentHash: string | null;
}

async function fileState(fileId: string): Promise<FileState | undefined> {
  const res = await ctx.db.execute<{
    status: string;
    deleted_at: string | null;
    quarantined_at: string | null;
    content_hash: string | null;
  }>(sql`SELECT status, deleted_at::text, quarantined_at::text, content_hash
           FROM files WHERE id = ${fileId}`);
  const row = res.rows[0];
  return row
    ? {
        status: row.status,
        deletedAt: row.deleted_at,
        quarantinedAt: row.quarantined_at,
        contentHash: row.content_hash,
      }
    : undefined;
}

/** Задачи сноса по ключу объекта: статус и срок — то, чем карантин и управляет. */
async function deletionJobs(objectKey: string): Promise<{ status: string; runAt: Date }[]> {
  const res = await ctx.db.execute<{ status: string; next_run_at: Date }>(sql`
    SELECT status, next_run_at FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${objectKey}
     ORDER BY created_at`);
  return res.rows.map((r) => ({ status: r.status, runAt: new Date(r.next_run_at) }));
}

/** Строки журнала по файлу — предмет проверок про след разбора. */
async function auditRows(
  fileId: string,
  action: string,
): Promise<{ actorUserId: string | null; metadata: Record<string, unknown> }[]> {
  const res = await ctx.db.execute<{ actor_user_id: string | null; metadata: unknown }>(sql`
    SELECT actor_user_id, metadata FROM audit_log
     WHERE entity_type = 'file' AND entity_id = ${fileId} AND action = ${action}
     ORDER BY created_at`);
  return res.rows.map((r) => ({
    actorUserId: r.actor_user_id,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/** Жив ли объект в хранилище — вопрос задаётся самому хранилищу, а не базе. */
async function objectAlive(objectKey: string): Promise<boolean> {
  const { headObject } = await import('../src/lib/s3');
  return (await headObject(objectKey)) !== null;
}

// ── Фикстуры ──

let fileNo = 0;

/**
 * Заявка вывоза металлолома: у неё нет предмета вовсе (ADR 0067), поэтому фикстуре не нужны ни тип
 * мусора, ни объём, ни тариф. Статус `new`: объектной роли правка открыта только в нём.
 */
async function newRequest(): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_requests (object_id, request_type, delivery_at, status, created_by,
                                responsible_name, responsible_phone, comment)
    VALUES (${ctx.objectId}, 'metal_removal', now(), 'new', ${ctx.owner.id},
            'Иванов Иван Иванович', '9990000000', ${`ТЕСТОВЫЕ ДАННЫЕ: карантин ${RUN}`})
    RETURNING id`);
  return res.rows[0]!.id;
}

async function requestVersion(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM waste_requests WHERE id = ${requestId}`,
  );
  return res.rows[0]!.version;
}

interface TestFile {
  id: string;
  objectKey: string;
  sha256: string;
}

/**
 * Снятое вложение — настоящим путём, а не `UPDATE` в обход приложения: файл грузится автором,
 * подшивается и снимается штатной правкой заявки. Именно она ставит задачу сноса, и именно её
 * снимает карантин.
 */
async function detachedFile(): Promise<TestFile> {
  fileNo += 1;
  const objectKey = `${KEY_PREFIX}${randomUUID()}`;
  const bytes = Buffer.from(`содержимое документа ${fileNo} прогона ${RUN}`, 'utf8');
  if (ctx.storeReady) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { s3 } = await import('../src/lib/s3');
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: objectKey, Body: bytes }));
  }
  const inserted = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES (${S3_BUCKET}, ${objectKey}, ${`Паспорт_Иванова-${fileNo}.pdf`}, 'application/pdf',
            ${bytes.length}, 'active', ${ctx.owner.id})
    RETURNING id`);
  const id = inserted.rows[0]!.id;

  const requestId = await newRequest();
  const attach = await inject('PATCH', `/api/v1/waste-requests/${requestId}`, ctx.owner.auth, {
    addFileIds: [id],
    version: await requestVersion(requestId),
  });
  expect(attach.statusCode, `подшивка вложения: ${attach.body}`).toBe(200);

  const remove = await inject('PATCH', `/api/v1/waste-requests/${requestId}`, ctx.owner.auth, {
    removeFileIds: [id],
    version: await requestVersion(requestId),
  });
  expect(remove.statusCode, `снятие вложения: ${remove.body}`).toBe(200);

  // Исходное состояние случая: файл снят, задача сноса стоит, объект ещё жив.
  const state = await fileState(id);
  expect(state?.status, 'снятое вложение помечено удалённым').toBe('deleted');
  expect(state?.deletedAt, 'у снятого вложения проставлено время удаления').not.toBeNull();
  expect(await deletionJobs(objectKey), 'снятие поставило одну задачу сноса').toMatchObject([
    { status: 'pending' },
  ]);
  return { id, objectKey, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Уборка своих строк — и ПЕРЕД прогоном тоже: упавшая подготовка оставляет мусор, до которого
 * суффиксная уборка следующего прогона не дотянется. Порядок задан внешними ключами.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const users = sql`SELECT id FROM users WHERE email LIKE 'db-qdet-%'`;
  await db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE 'qdet/%'`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN (${users})`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE 'qdet/%'`);
  await db.execute(sql`DELETE FROM user_grants WHERE user_id IN (${users})`);
  await db.execute(sql`DELETE FROM user_construction_objects WHERE user_id IN (${users})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'db-qdet-%'`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE 'qdet-%'`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'QDET-%'`);
}

describe.skipIf(!DB_URL)('карантин по снятому вложению (Р6, п. 4)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    // Сперва уборка: упавший прогон оставляет учётки и площадку, а имена у них те же.
    await cleanup(db);

    const passwordHash = await hashPassword(PASSWORD);
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-qdet-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`QDET-${RUN}`}, ${`Тестовая площадка QDET ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const admin = await makeUser('admin', 'admin');
    const owner = await makeUser('own', 'shtab');
    const auditor = await makeUser('audit', 'mechanic');

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${owner.id}, ${objectId})`);

    /*
     * Набор разбора — СВОИМ кодом, а не поставочным `files_quarantine_audit`: тот совместим с
     * ролями без своей оси, а случаю нужна роль, которой модуль вывоза не открыт вовсе, — механик.
     * Права набора считаются через гейт совместимости с ролью, поэтому строка `grant_roles`
     * обязательна: без неё держатель не получил бы ни одного права, и отказы ниже прошли бы сами
     * собой.
     */
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${`qdet-audit-${RUN}`}, ${`Файлы: разбор карантина ${RUN}`},
              'Набор прогона Р6 п. 4', false, ${admin.id})
      RETURNING id`);
    const grantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'files.quarantineAudit')`);
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'mechanic'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${auditor.id}, ${grantId}, ${admin.id})`);

    const app = await buildApp();
    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }

    // Бакет заводится здесь же: хранилище своё, и пустой контейнер о нём не знает. Неудача — не
    // падение прогона: без хранилища снимаются только проверки хеша и `HeadObject`.
    let storeReady = false;
    try {
      const { CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');
      const { s3 } = await import('../src/lib/s3');
      try {
        await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      }
      storeReady = true;
    } catch {
      storeReady = false;
    }

    ctx = {
      app,
      db,
      closeDb,
      adminId: admin.id,
      owner: { ...owner, auth: await login(owner.email) },
      auditor: { ...auditor, auth: await login(auditor.email) },
      objectId,
      storeReady,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('ставится по снятому файлу, снимает задачу сноса и оставляет объект в хранилище', async () => {
    const file = await detachedFile();

    const res = await quarantine(file.id, ctx.auditor.auth);
    expect(res.statusCode, `постановка по снятому файлу: ${res.body}`).toBe(200);
    const body = res.json() as {
      quarantined: boolean;
      quarantinedAt: string | null;
      contentHash: string | null;
      deletionCancelled: boolean;
    };
    expect(body.quarantined).toBe(true);
    expect(body.quarantinedAt).not.toBeNull();
    expect(body.deletionCancelled, 'постановка сняла задачу сноса').toBe(true);

    // ГЛАВНОЕ: сносить объект больше нечему.
    expect(await deletionJobs(file.objectKey), 'задач сноса не осталось').toEqual([]);

    // Файл остался снятым — карантин не воскрешает вложение, он только запирает предмет разбора.
    const state = await fileState(file.id);
    expect(state?.status, 'статус снятого файла не меняется').toBe('deleted');
    expect(state?.deletedAt, 'отметка снятия остаётся на месте').not.toBeNull();
    expect(state?.quarantinedAt, 'карантин поставлен').not.toBeNull();

    if (ctx.storeReady) {
      expect(await objectAlive(file.objectKey), 'объект в хранилище жив').toBe(true);
      // Хеш считается потоком из хранилища: совпал — значит уцелело именно то содержимое.
      expect(body.contentHash, 'хеш посчитан по живому объекту').toBe(file.sha256);
      expect((await fileState(file.id))?.contentHash).toBe(file.sha256);
    }

    /*
     * Повтор не должен превращаться в `404`: задачу снял он же, и её отсутствие означает не
     * «объект уничтожен», а «карантин уже стоит». Ручка остаётся идемпотентной, время постановки
     * не сдвигается.
     */
    const again = await quarantine(file.id, ctx.auditor.auth);
    expect(again.statusCode, `повторная постановка: ${again.body}`).toBe(200);
    const repeated = again.json() as { quarantinedAt: string | null; deletionCancelled: boolean };
    expect(repeated.quarantinedAt).toBe(body.quarantinedAt);
    expect(repeated.deletionCancelled, 'повтору снимать уже нечего').toBe(false);

    const trail = await auditRows(file.id, 'file.quarantine');
    expect(trail.length, 'обе постановки в журнале').toBe(2);
    expect(trail[0]?.metadata.detached, 'журнал помнит, что файл был снят').toBe(true);
    expect(trail[0]?.metadata.deletionCancelled).toBe(true);
    expect(trail[1]?.metadata.repeated).toBe(true);
  });

  it('снятый запертый файл открыт только праву разбора — включая отказ автору загрузки', async () => {
    const locked = await detachedFile();
    const plain = await detachedFile();
    expect((await quarantine(locked.id, ctx.auditor.auth)).statusCode).toBe(200);

    const res = await download(locked.id, ctx.auditor.auth);
    expect(res.statusCode, `разбор читает запертый файл: ${res.body}`).toBe(200);
    expect(typeof (res.json() as { url?: string }).url).toBe('string');

    // Автор загрузки — тот, кто чаще всего и приложил не тот документ.
    await expectHidden(locked.id, ctx.owner.auth, 'автор загрузки не получает запертый файл');

    /*
     * Обратная сторона: снятый файл БЕЗ карантина закрыт и самому разбору. Иначе зелёная строка
     * выше значила бы «право разбора открывает всё подряд», а не «карантин открывается правом».
     */
    await expectHidden(plain.id, ctx.auditor.auth, 'снятый файл без карантина закрыт и разбору');

    const views = await auditRows(locked.id, 'file.quarantine_access');
    expect(views.length, 'каждое открытие по праву разбора — строка журнала').toBe(1);
    expect(views[0]?.actorUserId).toBe(ctx.auditor.id);
  });

  it('снятие карантина возвращает задачу сноса, и тридцать суток отсчитываются заново', async () => {
    const file = await detachedFile();

    /*
     * Файл «пролежал в карантине» почти весь свой срок: задача сноса состарена на 29 суток ДО
     * постановки. Без этого сдвига новая задача отличалась бы от прежней на миллисекунды, и
     * утверждение «срок считается заново» ничего бы не значило.
     */
    await ctx.db.execute(sql`
      UPDATE jobs SET next_run_at = next_run_at - interval '29 days'
       WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${file.objectKey}`);
    const aged = (await deletionJobs(file.objectKey))[0]!.runAt;

    expect((await quarantine(file.id, ctx.auditor.auth)).statusCode).toBe(200);
    expect(await deletionJobs(file.objectKey)).toEqual([]);

    const res = await release(file.id, ctx.auditor.auth);
    expect(res.statusCode, `снятие карантина: ${res.body}`).toBe(200);
    const body = res.json() as { quarantined: boolean; deletionScheduledAt: string | null };
    expect(body.quarantined).toBe(false);
    expect(body.deletionScheduledAt, 'снятие назвало новый срок сноса').not.toBeNull();

    const jobsAfter = await deletionJobs(file.objectKey);
    expect(jobsAfter.length, 'задача сноса вернулась ровно одна').toBe(1);
    expect(jobsAfter[0]!.status).toBe('pending');
    // Срок пошёл от снятия карантина, а не дожил прежний: разница с состаренным — те самые 29 суток.
    expect(jobsAfter[0]!.runAt.getTime() - aged.getTime()).toBeGreaterThan(28 * 24 * 3600 * 1000);
    const expected = Date.now() + DELETE_DELAY_MS;
    expect(Math.abs(jobsAfter[0]!.runAt.getTime() - expected)).toBeLessThan(5 * 60 * 1000);

    // Прежнее состояние вернулось целиком: файл снова просто снятый — и снова закрыт всем.
    const state = await fileState(file.id);
    expect(state?.quarantinedAt).toBeNull();
    expect(state?.status).toBe('deleted');
    expect(state?.deletedAt).not.toBeNull();
    await expectHidden(file.id, ctx.auditor.auth, 'после снятия карантина файл снова просто снят');
    if (ctx.storeReady) expect(await objectAlive(file.objectKey)).toBe(true);
  });

  it('по уничтоженному файлу — тот же 404, что у файла, которого нет вовсе', async () => {
    const file = await detachedFile();

    /*
     * Задачу сноса выполнил воркер: объекта в хранилище больше нет, а строка `jobs` осталась в
     * конечном статусе. Это и есть «уничтоженный файл» — карантинить нечего, и обещать сохранность
     * того, чего нет, хуже отказа.
     */
    if (ctx.storeReady) {
      const { deleteObject } = await import('../src/lib/s3');
      await deleteObject(file.objectKey);
    }
    await ctx.db.execute(sql`
      UPDATE jobs SET status = 'done'
       WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${file.objectKey}`);

    const res = await quarantine(file.id, ctx.auditor.auth);
    expect(res.statusCode, `карантин по уничтоженному файлу: ${res.body}`).toBe(404);
    expect((res.json() as { message?: string }).message).toBe('Файл не найден');

    // Отказ ничего не поменял: ни карантина, ни выполненной задачи.
    expect((await fileState(file.id))?.quarantinedAt, 'карантин не поставлен').toBeNull();
    expect(
      await deletionJobs(file.objectKey),
      'выполненная задача осталась как была',
    ).toMatchObject([{ status: 'done' }]);
    expect(
      await auditRows(file.id, 'file.quarantine'),
      'отказ не пишет постановку в журнал',
    ).toEqual([]);

    // Та же пара кодов и текстов, что у файла, которого не существует вовсе.
    const missing = await quarantine(randomUUID(), ctx.auditor.auth);
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { message?: string }).message).toBe('Файл не найден');
  });
});
