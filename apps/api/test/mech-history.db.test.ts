import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
 * История заявки на аренду механизации и общий журнал (ADR 0152; план
 * `docs/mechanization-module-plan.md`, Р11, §6).
 *
 * **Зачем этому файлу база.** Обещание модуля теряется не в диффе и не в маршруте, а МЕЖДУ ними:
 * дифф собирает `changes`, маршрут пишет их в `audit_log`, а карточка читает журнал обратно
 * `mergeHistory` — и по дороге событие с незнакомым действием молча становится «изменено»
 * (`auditKinds[action] ?? 'updated'`), то есть отметка выдачи читается правкой формы. Проверять
 * это на строке `audit_log` бессмысленно (она-то как раз в порядке), а на подменённом журнале —
 * тем более: подмена вернёт то, что в неё положили. Вопрос стоит ровно в том, что приезжает в
 * `RequestHistoryEntryDto` после настоящей записи и настоящего чтения.
 *
 * Реестра аудита ДВА, и путать их нельзя (§6): история карточки (восемь действий, `changes`, свой
 * вид) и только общий журнал (`status`, `create`, `hard_delete`, `purge` — снимок того, что
 * исчезает, вида нет). Второй реестр без базы не проверить вовсе: у трёх его действий заявки
 * после операции уже нет, и единственное, что от неё остаётся, — строка журнала.
 *
 * **Чего файл не проверяет.** Область и барьеры — `mech-scope.db.test.ts`; вложения —
 * `mech-files.db.test.ts`; цикл и его отказы — `mech-cycle.db.test.ts`; подписи и теги видов без
 * базы — контрактные тесты.
 *
 * Запуск — как у остальных db-тестов (общая база, поимённо):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-history.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-history-${RUN}`;
/** «яя» в начале кода — чтобы объект не стал первым у соседних тестов с `ORDER BY … LIMIT 1`. */
const CODE_PREFIX = `яя-MECHHIST-${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const YESTERDAY = shiftDateKey(TODAY, -1);
const PLANNED_TO = shiftDateKey(TODAY, 7);
/** День человеку — той же разборкой строки, что и в диффе: у `date` зоны нет вовсе. */
function day(dateKey: string): string {
  const [yyyy, mm, dd] = dateKey.split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Четырнадцать ключей снимка (§6) — закрытый перечень, а не «реквизиты». Предмет аренды стоит в нём
 * ДВАЖДЫ (ADR 0156): `mechModelId` отвечает «какая это позиция справочника», `mechModelName` — «как
 * она называлась». Второй ключ не дублирует первый: после `purge` заявки нет, а модель с этого
 * момента можно снести насовсем — `RESTRICT` держал её, только пока заявка была. Написание заявки
 * (`kindName`) отвечало на этот же вопрос до уборки Э3 и ушло вместе с колонкой.
 */
const SNAPSHOT_KEYS = [
  'actualFrom',
  'actualTo',
  'actualUnits',
  'departmentId',
  'finalCost',
  'lessorId',
  'mechModelId',
  'mechModelName',
  'num',
  'objectId',
  'rate',
  'rateUnit',
  'requesterKind',
  'status',
];

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  objectId: string;
  departmentId: string;
  adminId: string;
  auth: { authorization: string };
  lessorId: string;
  lessorName: string;
  /** Модель из справочника: с Э2 предмет аренды выбирается строго из него (ADR 0156). */
  modelId: string;
  modelName: string;
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

/** Уборка своих строк — и перед прогоном тоже: база общая и переживает упавший прогон. */
async function cleanup(db: typeof AppDb): Promise<void> {
  const emailLike = `${EMAIL_PREFIX}%`;
  const users = sql`(SELECT id FROM users WHERE email LIKE ${emailLike})`;
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
  await db.execute(sql`DELETE FROM mech_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emailLike}`);
  await db.execute(sql`DELETE FROM departments WHERE code LIKE ${`${CODE_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM counterparties WHERE comment = ${CODE_PREFIX}`);
  // Модели — после заявок: ссылка стоит с `ON DELETE RESTRICT`.
  await db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-hist-${RUN}`}`);
}

// ── HTTP ──

interface CreateOptions {
  /** Заявитель-отдел: у снимка `purge` от этого зависит `requesterKind` и `departmentId`. */
  fromDepartment?: boolean;
}

async function createRequest(options: CreateOptions = {}): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/mech-requests',
    headers: ctx.auth,
    payload: {
      objectId: ctx.objectId,
      ...(options.fromDepartment ? { departmentId: ctx.departmentId } : {}),
      mechModelId: ctx.modelId,
      plannedFrom: TODAY,
      plannedTo: PLANNED_TO,
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9261234567',
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: механизация, история',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const dto = res.json();
  return { id: dto.id, version: dto.version };
}

function changeStatus(id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/mech-requests/${id}/status`,
    headers: ctx.auth,
    payload,
  });
}

async function versionOf(id: string): Promise<number> {
  const [row] = await ctx.db
    .select({ version: ctx.schema.mechRequests.version })
    .from(ctx.schema.mechRequests)
    .where(eq(ctx.schema.mechRequests.id, id));
  return row!.version;
}

async function history(id: string): Promise<RequestHistoryEntryDto[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/mech-requests/${id}/history`,
    headers: ctx.auth,
  });
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

async function auditRows(
  entityId: string,
  action: string,
): Promise<{ id: string; metadata: Record<string, unknown> }[]> {
  const rows = await ctx.db
    .select({ id: ctx.schema.auditLog.id, metadata: ctx.schema.auditLog.metadata })
    .from(ctx.schema.auditLog)
    .where(
      and(
        eq(ctx.schema.auditLog.entityType, 'mech_request'),
        eq(ctx.schema.auditLog.entityId, entityId),
        eq(ctx.schema.auditLog.action, action),
      ),
    )
    .orderBy(desc(ctx.schema.auditLog.createdAt));
  return rows.map((r) => ({ id: r.id, metadata: r.metadata as Record<string, unknown> }));
}

/** Заявка, взятая в работу с договорённостью: дальше от неё идут выдача, возврат и откаты. */
async function takeInWork(id: string, version: number, rate = 1200): Promise<void> {
  const res = await changeStatus(id, {
    status: 'confirmed',
    version,
    deal: { lessorId: ctx.lessorId, rate, rateUnit: 'hour' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe.skipIf(!DB_URL)('механизация: история карточки и общий журнал (ADR 0152)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    const app = await buildApp();
    // Упавший прогон обязан убираться следующим, а не копить заявки в общей базе.
    await cleanup(db);

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `${CODE_PREFIX}-O1`,
        name: `Площадка истории ${RUN}`,
        address: 'г. Москва, тестовый проезд, 3',
      })
      .returning({ id: schema.constructionObjects.id });
    const [department] = await db
      .insert(schema.departments)
      .values({ code: `${CODE_PREFIX}-D1`, name: `Отдел истории ${RUN}` })
      .returning({ id: schema.departments.id });
    // Пара «отдел ↔ площадка» обязана быть настоящей: без связи заявку отдела не завести вовсе.
    await db
      .insert(schema.departmentConstructionObjects)
      .values({ departmentId: department!.id, constructionObjectId: object!.id });

    const [admin] = await db
      .insert(schema.users)
      .values({
        email: `${EMAIL_PREFIX}-admin@example.invalid`,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: 'Исторический',
        // Администратор потому, что файлу нужны откаты (`requests.rollbackStatus`) и удаление
        // насовсем (`records.purge`): без них ни очистка договорённости, ни `purge` не достижимы.
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    const lessorName = `Арендодатель механизации ${RUN}`;
    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: lessorName,
        inn: String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10),
        comment: CODE_PREFIX,
        isActive: true,
      })
      .returning({ id: schema.counterparties.id });

    // Своя строка справочника на прогон, а не позиция сида: база общая, и заявка, сославшаяся на
    // общую модель, помешала бы соседнему файлу её гасить и сносить.
    const modelName = `Виброплита истории ${RUN}`;
    const [model] = await db
      .insert(schema.mechModels)
      .values({ code: `mech-hist-${RUN}`, name: modelName })
      .returning({ id: schema.mechModels.id });

    const token = await tokens.signAccessToken({ sub: admin!.id, role: 'admin', av: 0 });
    ctx = {
      app,
      db,
      schema,
      closeDb,
      objectId: object!.id,
      departmentId: department!.id,
      adminId: admin!.id,
      auth: { authorization: `Bearer ${token}` },
      lessorId: lessor!.id,
      lessorName,
      modelId: model!.id,
      modelName,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('каждое действие приезжает в карточку своим видом, а не «изменено»', async () => {
    const request = await createRequest();

    const edited = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/mech-requests/${request.id}`,
      headers: ctx.auth,
      payload: { comment: 'Уточнили подъезд', version: request.version },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    await takeInWork(request.id, await versionOf(request.id));
    const issued = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${request.id}/issue`,
      headers: ctx.auth,
      payload: { actualFrom: YESTERDAY, version: await versionOf(request.id) },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${request.id}/issue-revoke`,
      headers: ctx.auth,
      payload: { reason: 'Отметили не ту заявку', version: await versionOf(request.id) },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    const reissued = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${request.id}/issue`,
      headers: ctx.auth,
      payload: { actualFrom: TODAY, version: await versionOf(request.id) },
    });
    expect(reissued.statusCode, reissued.body).toBe(200);
    const completed = await changeStatus(request.id, {
      status: 'done',
      version: await versionOf(request.id),
      completion: { actualFrom: TODAY, actualTo: TODAY, actualUnits: 8, finalCost: 9600 },
    });
    expect(completed.statusCode, completed.body).toBe(200);

    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}?version=${await versionOf(request.id)}`,
      headers: ctx.auth,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${request.id}/restore`,
      headers: ctx.auth,
      payload: { version: await versionOf(request.id) },
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const entries = await history(request.id);
    const kinds = entries.map((e) => e.kind);
    // Восемь действий реестра карточки — каждое своим видом. Без вида событие приезжает как
    // «изменено», то есть отметка выдачи читалась бы правкой формы, а архивирование — тегом
    // «Правка» с текстом «состав изменений не записан».
    expect(kinds).toEqual(
      expect.arrayContaining([
        'created',
        'updated',
        'mechDeal',
        'mechIssued',
        'mechIssueRevoked',
        'completed',
        'deleted',
        'restored',
      ]),
    );
    // «Изменено» ровно одно — та единственная правка формы, которая и была.
    expect(kinds.filter((k) => k === 'updated')).toHaveLength(1);

    // Технические ключи со значениями, а не подписи: переименование поля в интерфейсе не должно
    // переписывать историю задним числом.
    const deal = entries.find((e) => e.kind === 'mechDeal');
    expect(changeOf(deal, 'lessor')).toEqual({ from: '—', to: ctx.lessorName });
    expect(changeOf(deal, 'rate').to).toMatch(/^1\s200,00\s₽$/u);
    expect(changeOf(deal, 'rateUnit')).toEqual({ from: '—', to: 'час' });

    const issue = entries.filter((e) => e.kind === 'mechIssued');
    expect(issue).toHaveLength(2);
    expect(changeOf(issue[0], 'actualFrom')).toEqual({ from: '—', to: day(YESTERDAY) });

    const revoke = entries.find((e) => e.kind === 'mechIssueRevoked');
    expect(changeOf(revoke, 'actualFrom')).toEqual({ from: day(YESTERDAY), to: '—' });
    // Причина — строкой вида «список» (`from === null`): у неё нет «было», и пара «— → текст»
    // читалась бы как потеря значения.
    expect(changeOf(revoke, 'issueRevokeReason')).toEqual({
      from: null,
      to: 'Отметили не ту заявку',
    });

    const complete = entries.find((e) => e.kind === 'completed');
    expect(changeOf(complete, 'actualTo')).toEqual({ from: '—', to: day(TODAY) });
    expect(changeOf(complete, 'actualUnits')).toEqual({ from: '—', to: '8 ч' });
    expect(changeOf(complete, 'finalCost').to).toMatch(/^9\s600,00\s₽$/u);

    // Архив и восстановление берут готовые виды и `changes` не несут по существу события.
    expect(entries.find((e) => e.kind === 'deleted')?.changes).toEqual([]);
    expect(entries.find((e) => e.kind === 'restored')?.changes).toEqual([]);
  });

  it('очистка договорённости откатом попадает в историю числами, а не молчанием', async () => {
    const request = await createRequest();
    await takeInWork(request.id, request.version, 1500);

    const rolledBack = await changeStatus(request.id, {
      status: 'new',
      version: await versionOf(request.id),
      comment: 'Арендодатель отказался',
    });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);

    // Цифры обязаны попасть в историю ровно в тот момент, когда исчезают из карточки: строка
    // помнит одно «сейчас», и без этого события «была ставка 1500/час» не осталось бы нигде.
    const cleared = (await history(request.id))
      .filter((e) => e.kind === 'mechDeal')
      .find((e) => e.changes.some((c) => c.field === 'lessor' && c.to === '—'));
    expect(cleared, 'событие очистки договорённости').toBeDefined();
    expect(changeOf(cleared, 'lessor')).toEqual({ from: ctx.lessorName, to: '—' });
    expect(changeOf(cleared, 'rate').from).toMatch(/^1\s500,00\s₽$/u);
    expect(changeOf(cleared, 'rate').to).toBe('—');
    expect(changeOf(cleared, 'rateUnit')).toEqual({ from: 'час', to: '—' });
  });

  it('повторное завершение показывает прежнюю сумму рядом с новой', async () => {
    const request = await createRequest();
    await takeInWork(request.id, request.version);
    const first = await changeStatus(request.id, {
      status: 'done',
      version: await versionOf(request.id),
      completion: { actualFrom: YESTERDAY, actualTo: TODAY, actualUnits: 8, finalCost: 9600 },
    });
    expect(first.statusCode, first.body).toBe(200);

    const rolledBack = await changeStatus(request.id, {
      status: 'confirmed',
      version: await versionOf(request.id),
      comment: 'Счёт пришёл на другую сумму',
    });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    const second = await changeStatus(request.id, {
      status: 'done',
      version: await versionOf(request.id),
      completion: { actualFrom: YESTERDAY, actualTo: TODAY, actualUnits: 10, finalCost: 12000 },
    });
    expect(second.statusCode, second.body).toBe(200);

    // Повторное завершение перезаписывает все четыре значения, и прежние не сохранит ничто, кроме
    // этой записи, — а именно их спрашивают, разбирая счёт.
    const entries = await history(request.id);
    const rewrite = entries
      .filter((e) => e.kind === 'completed')
      .find((e) => e.changes.some((c) => c.field === 'finalCost' && c.from !== '—'));
    expect(rewrite, 'событие повторного завершения').toBeDefined();
    expect(changeOf(rewrite, 'finalCost').from).toMatch(/^9\s600,00\s₽$/u);
    expect(changeOf(rewrite, 'finalCost').to).toMatch(/^12\s000,00\s₽$/u);
    expect(changeOf(rewrite, 'actualUnits')).toEqual({ from: '8 ч', to: '10 ч' });
  });

  it('заведение в карточку не приходит, но в общем журнале лежит снимком', async () => {
    const request = await createRequest();
    const created = await auditRows(request.id, 'mech_request.create');
    expect(created).toHaveLength(1);
    // Снимок один на все действия второго реестра, включая заведение, где половина ключей пуста по
    // существу: один набор с пустыми значениями честнее второго, укороченного.
    expect(Object.keys(created[0]!.metadata).sort()).toEqual(SNAPSHOT_KEYS);
    expect(created[0]!.metadata.sourceRequestId).toBeUndefined();

    const copy = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/mech-requests/${request.id}/duplicate`,
      headers: ctx.auth,
      payload: {},
    });
    expect(copy.statusCode, copy.body).toBe(201);
    const duplicated = await auditRows(copy.json().id, 'mech_request.create');
    // `sourceRequestId` бывает только у дубликата — это и отличает его в журнале, не заводя
    // второго действия.
    expect(duplicated[0]!.metadata.sourceRequestId).toBe(request.id);

    // В карточке заведение приходит переходом «— → Новая» из таблицы истории статусов, а событие
    // журнала туда не попадает вовсе: иначе на одну заявку было бы две записи о заведении.
    const entries = await history(request.id);
    expect(entries.filter((e) => e.kind === 'created')).toHaveLength(1);
    expect(entries.map((e) => e.id)).not.toContain(created[0]!.id);
  });

  it('переход статуса живёт только в общем журнале, а в карточку приходит из истории статусов', async () => {
    const request = await createRequest();
    const cancelled = await changeStatus(request.id, {
      status: 'cancelled',
      version: request.version,
      comment: 'Обошлись своими силами',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // Без этой записи отмена заявки не оставляет в `audit_log` ни строки, и сквозной разбор «что
    // происходило в портале в этот день» её не увидит.
    const rows = await auditRows(request.id, 'mech_request.status');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({
      from: 'new',
      to: 'cancelled',
      comment: 'Обошлись своими силами',
    });

    // А в карточке переход приходит из таблицы истории статусов — там есть и он, и причина:
    // событие журнала его бы только продублировало.
    const entries = await history(request.id);
    const status = entries.filter((e) => e.kind === 'status');
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      fromStatus: 'new',
      toStatus: 'cancelled',
      comment: 'Обошлись своими силами',
    });
    expect(entries.map((e) => e.id)).not.toContain(rows[0]!.id);
  });

  it('физическое удаление и удаление насовсем оставляют снимок, объясняющий деньги', async () => {
    const office = ctx.auth;
    // Первый случай — «Новая»: у неё снимок пуст по существу, но форма его та же.
    const fresh = await createRequest();
    const hardDeleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${fresh.id}?version=${fresh.version}`,
      headers: office,
    });
    expect(hardDeleted.statusCode, hardDeleted.body).toBe(200);
    expect(hardDeleted.json().mode).toBe('hard');
    const hardRows = await auditRows(fresh.id, 'mech_request.hard_delete');
    expect(hardRows).toHaveLength(1);
    expect(Object.keys(hardRows[0]!.metadata).sort()).toEqual(SNAPSHOT_KEYS);
    // Карточки больше нет — и истории у неё тоже: показывать событие негде.
    const goneHistory = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/mech-requests/${fresh.id}/history`,
      headers: office,
    });
    expect(goneHistory.statusCode).toBe(404);

    // Второй случай — `purge` завершённой аренды отдела: снимок обязан объяснить её деньги.
    const request = await createRequest({ fromDepartment: true });
    await takeInWork(request.id, request.version, 1200);
    const finished = await changeStatus(request.id, {
      status: 'done',
      version: await versionOf(request.id),
      completion: { actualFrom: YESTERDAY, actualTo: TODAY, actualUnits: 8, finalCost: 9600 },
    });
    expect(finished.statusCode, finished.body).toBe(200);
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}?version=${await versionOf(request.id)}`,
      headers: office,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const purged = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/mech-requests/${request.id}/purge?version=${await versionOf(request.id)}`,
      headers: office,
    });
    expect(purged.statusCode, purged.body).toBe(200);

    const purgeRows = await auditRows(request.id, 'mech_request.purge');
    expect(purgeRows).toHaveLength(1);
    const snapshot = purgeRows[0]!.metadata;
    expect(Object.keys(snapshot).sort()).toEqual(SNAPSHOT_KEYS);
    // Ставка с единицей и отработанные единицы показывают, из чего сложилась итоговая сумма: без
    // `actualUnits` итог оказался бы числом без вывода.
    expect(snapshot).toMatchObject({
      objectId: ctx.objectId,
      departmentId: ctx.departmentId,
      requesterKind: 'department',
      status: 'done',
      lessorId: ctx.lessorId,
      rate: 1200,
      rateUnit: 'hour',
      actualFrom: YESTERDAY,
      actualTo: TODAY,
      actualUnits: 8,
      finalCost: 9600,
    });
    // Персональных данных в append-only журнале нет намеренно: для финансового разбора они не
    // нужны, а строки заявки уже не существует.
    for (const forbidden of ['responsibleName', 'responsiblePhone', 'comment', 'files']) {
      expect(snapshot).not.toHaveProperty(forbidden);
    }

    const [gone] = await ctx.db
      .select({ id: ctx.schema.mechRequests.id })
      .from(ctx.schema.mechRequests)
      .where(eq(ctx.schema.mechRequests.id, request.id));
    expect(gone).toBeUndefined();
  });
});
