import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Role } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';

/**
 * Сканы талонов держателю права аудита распознавания (ADR 0137, решение 8; план аудита §4.2).
 *
 * **Зачем через живой маршрут, а не вызовом правила.** Предмет проверки — ЗАПРЕТ и его граница:
 * право `wasteRequests.ticketAudit` открывает бумагу всех площадок, минуя объектную область, и
 * ровно поэтому обязано открывать **только талоны**. Не сузь его до `request_files.kind='ticket'`
 * — и право аудита машинного чтения тихо отдаст все прочие вложения заявок вывоза: договоры,
 * письма, фотографии. Проверить это можно только там, где решение принимается: правило доступа к
 * файлу собирается из связей запросами к базе, и подменённая база проверяла бы подмену.
 *
 * **Кто такой держатель.** Роль `shtab` с одной площадкой плюс собранный набор с единственным
 * правом аудита. Роль объектная намеренно: `PERMISSION_REQUIRES` не даёт выдать аудит без
 * `wasteRequests.read`, так что держатель всегда ведёт и свою обычную работу, — и вопрос «каким
 * входом открыт файл» имеет смысл только у такого субъекта. Он же отвечает на второй вопрос: своя
 * площадка открывается обычным путём и в журнал просмотров не попадает.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_audit_scan_test \
 *     pnpm --filter @technic/api test ticket-audit-scan.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
/** Метка прогона: база у db-тестов общая и живёт между запусками — чужого здесь быть не должно. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const MARK = `scan-${RUN}`;
const PASSWORD = 'Portal-Door-Secret-77';
/** Действие журнала просмотров — то самое, которым план уравновешивает сквозное право (§4.2). */
const VIEW_ACTION = 'waste_request.ticket_audit_view';

interface Person {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof DbSchema;
  closeDb: () => Promise<void>;
  /** Держатель права аудита: своя площадка одна, а талоны видны все. */
  auditor: Person;
  /** Штаб без набора: тот же модуль и та же площадка, но без сквозного входа. */
  local: Person;
  /** Загрузивший файлы и заведший заявки: авторство не должно открывать файл ни тому, ни другому. */
  uploader: Person;
  ownObjectId: string;
  foreignObjectId: string;
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
  // Ссылку на скачивание клиент S3 подписывает локально: сеть тут не нужна, нужен только конфиг.
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

/** Свой адрес на запрос: вход ограничен десятью попытками в минуту с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * Учётка с настоящим паролем и областью. Вставкой, а не маршрутом учёток: форма проверяет
 * совместимость набора с ролью по каталогу, а сюда нужен собранный набор, которого в каталоге нет.
 */
async function newPerson(tag: string, role: Role, objectIds: string[]): Promise<Person> {
  const { hashPassword } = await import('../src/auth/password');
  const email = `${MARK}-${tag}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Смотров',
      firstName: 'Тест',
      middleName: tag,
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  const id = created!.id;
  if (objectIds.length > 0) {
    await ctx.db
      .insert(ctx.schema.userConstructionObjects)
      .values(objectIds.map((constructionObjectId) => ({ userId: id, constructionObjectId })));
  }
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { id, auth: { authorization: `Bearer ${login.json().accessToken as string}` } };
}

/** Набор с единственным правом аудита — ровно такой администратор и выдаёт поимённо (§4.1). */
async function grantTicketAudit(userId: string, role: Role): Promise<void> {
  const { db, schema } = ctx;
  const [grant] = await db
    .insert(schema.grants)
    .values({ code: `${MARK}-audit`, name: 'Аудит распознавания (тест)', isSystem: false })
    .returning({ id: schema.grants.id });
  const grantId = grant!.id;
  // Гейт совместимости стоит в чтении прав (`grantPermissionsExpr` соединяется с `grant_roles`):
  // без строки роли набор доехал бы до учётки, а права из него — нет.
  await db.insert(schema.grantRoles).values({ grantId, role });
  await db
    .insert(schema.grantPermissions)
    .values({ grantId, permission: 'wasteRequests.ticketAudit' });
  await db
    .insert(schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.uploader.id, origin: 'manual' });
}

/** Заявка вывоза на площадке: `deleted` — та, которую откатили после закрытия. */
async function newRequest(objectId: string, deleted = false): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-08-20T09:00:00.000Z'),
      createdBy: ctx.uploader.id,
      status: 'done',
      comment: MARK,
      volumeM3: '20',
      deletedAt: deleted ? new Date() : null,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return request!.id;
}

/**
 * Живой файл в хранилище. `uploadedBy` — третий человек: ветка авторства открывает непривязанный
 * файл загрузившему, и попади она в кадр, любая проверка ниже прошла бы мимо предмета.
 */
async function newFile(name: string): Promise<string> {
  seq += 1;
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${MARK}/${seq}-${name}.jpg`,
      filename: `${name}.jpg`,
      contentType: 'image/jpeg',
      size: 2048,
      status: 'active',
      uploadedBy: ctx.uploader.id,
    })
    .returning({ id: ctx.schema.files.id });
  return file!.id;
}

/** Вложение заявки: талон или обычный документ — это ровно одна колонка разницы. */
async function attach(
  requestId: string,
  fileId: string,
  kind: 'ticket' | 'attachment',
): Promise<void> {
  await ctx.db.insert(ctx.schema.requestFiles).values({ requestId, fileId, kind });
}

/**
 * Наблюдение — машинное чтение одного поля (ADR 0137, решение 1). Заводится без заявки и без
 * талона: так строка выглядит после их уборки, и от скана остаётся единственная ниточка к
 * картинке — `file_id`.
 */
async function observe(fileId: string): Promise<void> {
  await ctx.db.insert(ctx.schema.wasteTicketFieldEvents).values({
    event: 'recognized',
    field: 'volumeM3',
    newValue: '38',
    readState: 'read',
    model: 'test-model',
    modelReported: 'test-model',
    fileId,
    pageNo: 1,
  });
}

function download(person: Person, fileId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/files/${fileId}/download`,
    headers: person.auth,
  });
}

/** Записи журнала просмотров по конкретному скану: их наличие — половина предмета проверки. */
function views(fileId: string) {
  const { auditLog } = ctx.schema;
  return ctx.db
    .select({ actorUserId: auditLog.actorUserId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.action, VIEW_ACTION), eq(auditLog.entityId, fileId)));
}

describe.skipIf(!DB_URL)('сканы талонов праву аудита распознавания', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const objects = await db
      .insert(schema.constructionObjects)
      .values([
        { code: `${MARK}-own`, name: `Своя площадка ${RUN}`, address: 'Волоколамское ш., 71к14' },
        { code: `${MARK}-far`, name: `Чужая площадка ${RUN}`, address: 'Ленинградское ш., 16' },
      ])
      .returning({ id: schema.constructionObjects.id });

    ctx = {
      app,
      db,
      schema,
      closeDb,
      ownObjectId: objects[0]!.id,
      foreignObjectId: objects[1]!.id,
      auditor: null as never,
      local: null as never,
      uploader: null as never,
    };
    ctx.uploader = await newPerson('uploader', 'admin', []);
    ctx.auditor = await newPerson('auditor', 'shtab', [ctx.ownObjectId]);
    ctx.local = await newPerson('local', 'shtab', [ctx.ownObjectId]);
    await grantTicketAudit(ctx.auditor.id, 'shtab');
  }, 240_000);

  afterAll(async () => {
    if (!DB_URL) return;
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    // Порядок уборки: журнал первым (`entity_id` текстовый, каскадом не уходит), затем наблюдения
    // (их ссылка на файл обнуляема, и строка пережила бы прогон), потом заявки со своими
    // вложениями, файлы, учётки и набор — `user_grants.grant_id` стоит под RESTRICT.
    const like = `${MARK}/%`;
    await client.query(
      `DELETE FROM audit_log WHERE entity_type = 'file'
         AND entity_id IN (SELECT id::text FROM files WHERE object_key LIKE $1)`,
      [like],
    );
    await client.query(
      `DELETE FROM waste_ticket_field_events
         WHERE file_id IN (SELECT id FROM files WHERE object_key LIKE $1)`,
      [like],
    );
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(`DELETE FROM files WHERE object_key LIKE $1`, [like]);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${MARK}-%`]);
    await client.query(`DELETE FROM grants WHERE code = $1`, [`${MARK}-audit`]);
    await client.query(`DELETE FROM construction_objects WHERE code LIKE $1`, [`${MARK}-%`]);
    await client.end();
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('талон чужой площадки открывается правом аудита и попадает в журнал просмотров', async () => {
    const requestId = await newRequest(ctx.foreignObjectId);
    const fileId = await newFile('ticket-foreign');
    await attach(requestId, fileId, 'ticket');

    // Штабу той же роли и той же площадки чужой талон закрыт: право на модуль у него есть, области
    // нет — и разница между двумя ответами есть ровно то, что даёт набор.
    expect((await download(ctx.local, fileId)).statusCode).toBe(403);

    const res = await download(ctx.auditor, fileId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().url).toBeTruthy();

    const rows = await views(fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(ctx.auditor.id);
    // Заявка в метаданных: по ней читается, чью площадку смотрели, — вопрос, ради которого журнал
    // и заведён.
    expect(rows[0]!.metadata).toMatchObject({ requestId });
  });

  it('НЕталонное вложение той же заявки праву аудита закрыто', async () => {
    const requestId = await newRequest(ctx.foreignObjectId);
    const ticketId = await newFile('ticket-with-neighbour');
    const paperId = await newFile('contract');
    await attach(requestId, ticketId, 'ticket');
    await attach(requestId, paperId, 'attachment');

    // Главная проверка: одна заявка, один держатель, разница — одна колонка `kind`. Открой ветка
    // «файл, связанный с заявкой вывоза», и право аудита машинного чтения отдало бы заодно
    // договоры, письма и фотографии площадок.
    expect((await download(ctx.auditor, ticketId)).statusCode).toBe(200);
    const res = await download(ctx.auditor, paperId);
    expect(res.statusCode, res.body).toBe(403);
    // Отказ в журнал не пишется: событие называется просмотром, а просмотра не было.
    expect(await views(paperId)).toHaveLength(0);
  });

  it('талон удалённой заявки по-прежнему открывается', async () => {
    const requestId = await newRequest(ctx.foreignObjectId, true);
    const fileId = await newFile('ticket-deleted-request');
    await attach(requestId, fileId, 'ticket');

    // Обычная ветка вывоза удалённых заявок не видит — и правильно делает. Аудиту наоборот: талон
    // откатанной заявки для метрики ценнее прочих (его и трогали потому, что с чтением что-то было
    // не так), а разбор ошибки без картинки бессмыслен.
    const res = await download(ctx.auditor, fileId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await views(fileId)).toHaveLength(1);
  });

  it('скан, от которого осталось одно наблюдение, открывается по нему', async () => {
    // Ни заявки, ни талона, ни строки в `request_files`: так выглядит скан после уборки заявки —
    // `file_id` наблюдения переживает обнуление всех прочих ссылок (§4.2).
    const fileId = await newFile('orphan-observation');
    await observe(fileId);

    expect((await download(ctx.auditor, fileId)).statusCode).toBe(200);
    expect(await views(fileId)).toHaveLength(1);
    // Штабу без набора он закрыт: связи с видимой заявкой у файла нет вовсе.
    expect((await download(ctx.local, fileId)).statusCode).toBe(403);
  });

  it('своя площадка держателя открывается обычным путём и в журнал просмотров не идёт', async () => {
    const requestId = await newRequest(ctx.ownObjectId);
    const ticketId = await newFile('ticket-own');
    const paperId = await newFile('paper-own');
    await attach(requestId, ticketId, 'ticket');
    await attach(requestId, paperId, 'attachment');

    // Держателю набора своя работа видна как прежде — включая обычное вложение, которое открывает
    // ему `wasteRequests.read`, а не аудит.
    expect((await download(ctx.auditor, ticketId)).statusCode).toBe(200);
    expect((await download(ctx.auditor, paperId)).statusCode).toBe(200);
    // И ни одной записи: журнал про сквозной доступ, а не про свою работу. Пиши он всё подряд —
    // редкие переходы через область утонули бы в собственных открытиях держателя.
    expect(await views(ticketId)).toHaveLength(0);
    expect(await views(paperId)).toHaveLength(0);

    // Штаб без набора: поведение прежнее до последней строки — своя площадка открыта, журнал пуст.
    expect((await download(ctx.local, ticketId)).statusCode).toBe(200);
    expect((await download(ctx.local, paperId)).statusCode).toBe(200);
    expect(await views(ticketId)).toHaveLength(0);
  });
});
