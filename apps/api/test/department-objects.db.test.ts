import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DepartmentDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ScopesNs from '../src/services/user-scopes';
import type * as SessionsNs from '../src/auth/sessions';
import type * as PrincipalNs from '../src/auth/principal';
import type * as PurgeNs from '../src/services/directory-purge';
import type * as TokensNs from '../src/auth/tokens';

/**
 * Площадки отдела множеством (ADR 0144, миграция 0221) — на живой схеме.
 *
 * **Зачем этому файлу база.** Всё, что здесь проверяется, живёт в самой базе или в паре «SQL +
 * транзакция», и на подменах выглядит правильным:
 *
 * 1. **область** собирается выражением `departmentObjectIdsExpr` — подзапросом в таблицу связи.
 *    Проверка «поле массив» его не касается: до ADR 0144 источником была колонка
 *    `departments.construction_object_id`, и подмена отвечала бы одинаково в обоих случаях. Ошибка
 *    здесь не отказ, а тишина: гарантийный отдел не увидит своих площадок и не поймёт почему;
 * 2. **триггер совместимости** `department_object_sync_trg` — код предыдущей версии, работающий в
 *    окне выката на новой схеме. Его пять сценариев (§этап 1 плана) не выражаются вообще ничем,
 *    кроме записи в `departments` и чтения таблицы связи;
 * 3. **транзакционность отзыва сессий** (Р6): «отзыв случился внутри правки» и «отзыв случился
 *    после коммита» дают одинаковое состояние базы, если ничего не падало. Различить их можно
 *    только двумя соединениями и откатом;
 * 4. **`RESTRICT` на объекте** (Р2) и человеческий текст отказа — это про схему и про перевод
 *    ошибки БД, а не про правила;
 * 5. **409 старой вкладке** (Р11) и канонизация набора (шаг 1 сервиса) — про HTTP поверх живого
 *    состояния: и то и другое сравнивает присланное с ТЕКУЩИМ набором из базы.
 *
 * **Чего файл не проверяет.** Порядок блокировок `users` → `refresh_sessions` под конкуренцией —
 * `session-locking.db.test.ts`; область как функцию (`canUse`, `placeObjectScopeIds`) —
 * `access-scope.test.ts`; обмен справочниками — `directory-transfer-org.test.ts`.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm -C apps/api test -- department-objects
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метка своих строк: уборка идёт по ней, а не «по последним записям» — база общая на все файлы. */
const EMAIL_PREFIX = 'db-department-objects';
const CODE_PREFIX = 'DEPTOBJ';
/** Хвост прогона: код объекта и адрес учётки уникальны, и два прогона не должны спорить. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  /**
   * Второй пул — чтобы смотреть на базу СНАРУЖИ незакоммиченной транзакции. Через пул приложения
   * такой взгляд невозможен: запрос из той же транзакции видит её собственные правки, а запрос
   * мимо неё нужен на другом соединении.
   */
  sideDb: typeof AppDb;
  schema: typeof SchemaNs;
  scopes: typeof ScopesNs;
  sessions: typeof SessionsNs;
  principal: typeof PrincipalNs;
  purge: typeof PurgeNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  closeSide: () => Promise<void>;
  /** Кто правит: `created_by` привязок и автор событий журнала ссылаются на живую учётку. */
  adminId: string;
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
 * Уборка своих строк — и перед прогоном тоже: упавший прогон обязан убираться следующим, а не
 * копить отделы в общей базе. Порядок задан ссылками: события журнала (`entity_id` текстовый, ни
 * каскада, ни ключа), потом учётки (за ними каскадом уходят привязки и refresh-сессии), потом
 * отделы (за ними — набор площадок), и только в конце объекты: их держит `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const codeLike = `${CODE_PREFIX}-%`;
  const emailLike = `${EMAIL_PREFIX}%`;
  await db.execute(sql`
    DELETE FROM audit_log
    WHERE (entity_type = 'department'
             AND entity_id IN (SELECT id::text FROM departments WHERE code LIKE ${codeLike}))
       OR (entity_type = 'construction_object'
             AND entity_id IN (SELECT id::text FROM construction_objects WHERE code LIKE ${codeLike}))
       OR (entity_type = 'user'
             AND entity_id IN (SELECT id::text FROM users WHERE email LIKE ${emailLike}))`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emailLike}`);
  await db.execute(sql`DELETE FROM departments WHERE code LIKE ${codeLike}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${codeLike}`);
}

// ── Подопытные ──

interface TestObject {
  id: string;
  code: string;
}

/**
 * Объект строительства. `active` выключается там, где объект собираются удалять насовсем: живую
 * запись маршрут не удаляет вовсе, и без этого проверялась бы не та преграда.
 */
async function newObject(tag: string, active = true): Promise<TestObject> {
  seq += 1;
  const code = `${CODE_PREFIX}-${RUN}-O${seq}-${tag}`;
  const [row] = await ctx.db
    .insert(ctx.schema.constructionObjects)
    .values({ code, name: `Объект ${tag} ${RUN}`, isActive: active })
    .returning({ id: ctx.schema.constructionObjects.id });
  return { id: row!.id, code };
}

/**
 * Отдел. `columnObjectId` — это запись КОЛОНКИ, то есть ровно то, что делает код предыдущей версии:
 * набора он не знает и пишет площадку одним полем. Набор при этом появляется сам — триггером.
 */
async function newDepartment(tag: string, columnObjectId?: string): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.departments)
    .values({
      code: `${CODE_PREFIX}-${RUN}-D${seq}-${tag}`,
      name: `Отдел ${tag} ${RUN}`,
      constructionObjectId: columnObjectId ?? null,
    })
    .returning({ id: ctx.schema.departments.id });
  return row!.id;
}

async function newUser(tag: string, role: 'admin' | 'department' = 'department'): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${RUN}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      // Входа по паролю в файле нет: access-токен подписывается напрямую, refresh-сессия
      // заводится сервисом. Хеш здесь только ради `NOT NULL`.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return row!.id;
}

/** Сотрудник отдела: связь заводится напрямую — предмет файла не она, а область, что из неё следует. */
async function joinDepartment(userId: string, departmentId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userDepartments)
    .values({ userId, departmentId, isHead: false, createdBy: ctx.adminId });
}

/** Набор площадок отдела — чтением таблицы связи, а не сервисом: проверять код им же нельзя. */
async function objectsOf(departmentId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: ctx.schema.departmentConstructionObjects.constructionObjectId })
    .from(ctx.schema.departmentConstructionObjects)
    .where(eq(ctx.schema.departmentConstructionObjects.departmentId, departmentId))
    .orderBy(asc(ctx.schema.departmentConstructionObjects.constructionObjectId));
  return rows.map((r) => r.id);
}

/** Привязки со своими реквизитами: по ним видно, пересоздавал ли кто-то строку набора. */
async function linksOf(
  departmentId: string,
): Promise<{ objectId: string; createdBy: string | null; createdAt: Date }[]> {
  return ctx.db
    .select({
      objectId: ctx.schema.departmentConstructionObjects.constructionObjectId,
      createdBy: ctx.schema.departmentConstructionObjects.createdBy,
      createdAt: ctx.schema.departmentConstructionObjects.createdAt,
    })
    .from(ctx.schema.departmentConstructionObjects)
    .where(eq(ctx.schema.departmentConstructionObjects.departmentId, departmentId))
    .orderBy(asc(ctx.schema.departmentConstructionObjects.constructionObjectId));
}

/** Колонка-проекция (Р9) — её пишет сервис и читает предыдущая версия кода. */
async function columnOf(departmentId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ objectId: ctx.schema.departments.constructionObjectId })
    .from(ctx.schema.departments)
    .where(eq(ctx.schema.departments.id, departmentId));
  return row!.objectId;
}

async function nameOf(departmentId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ name: ctx.schema.departments.name })
    .from(ctx.schema.departments)
    .where(eq(ctx.schema.departments.id, departmentId));
  return row!.name;
}

async function authVersionOf(userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return row!.authVersion;
}

async function liveSessionIds(userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: ctx.schema.refreshSessions.id })
    .from(ctx.schema.refreshSessions)
    .where(
      and(
        eq(ctx.schema.refreshSessions.userId, userId),
        isNull(ctx.schema.refreshSessions.revokedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Последнее событие журнала по отделу — им проверяется разница набора (Р10). */
async function lastDepartmentAudit(
  departmentId: string,
): Promise<{ action: string; metadata: Record<string, unknown> } | undefined> {
  const rows = await ctx.db
    .select({ action: ctx.schema.auditLog.action, metadata: ctx.schema.auditLog.metadata })
    .from(ctx.schema.auditLog)
    .where(
      and(
        eq(ctx.schema.auditLog.entityType, 'department'),
        eq(ctx.schema.auditLog.entityId, departmentId),
      ),
    )
    .orderBy(sql`created_at DESC`)
    .limit(1);
  const row = rows[0];
  return row
    ? { action: row.action, metadata: row.metadata as Record<string, unknown> }
    : undefined;
}

/** Разница набора из события журнала — в том виде, в каком её прочитает человек. */
function auditObjects(metadata: Record<string, unknown>): { added: string[]; removed: string[] } {
  return metadata.objects as { added: string[]; removed: string[] };
}

// ── HTTP ──

/**
 * Свой адрес на каждый запрос: у ручек `/auth` лимит десять обращений в минуту с адреса, а файл
 * дёргает `refresh` подряд. Разные адреса стоят ноль и снимают вопрос целиком.
 */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * Заголовок с access-токеном. Подписывается напрямую, а не входом по паролю: предмет файла —
 * площадки, а не вход, и хеширование пароля стоило бы секунд на пустом месте. Версия доступа
 * читается из базы в момент выдачи — иначе токен, выписанный до смены области, получил бы 401
 * ровно за то, что проверяется другим тестом.
 */
async function authHeaders(userId: string): Promise<{ authorization: string }> {
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

function patchDepartment(
  headers: { authorization: string },
  id: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/departments/${id}`,
    remoteAddress: nextAddress(),
    headers,
    payload,
  });
}

function postDepartment(headers: { authorization: string }, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/departments',
    remoteAddress: nextAddress(),
    headers,
    payload,
  });
}

/** Обновление токена по refresh-сессии — единственный способ проверить, что сессия жива. */
function refresh(token: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    remoteAddress: nextAddress(),
    cookies: { refresh_token: token },
  });
}

describe.skipIf(!DB_URL)('площадки отдела множеством (ADR 0144, живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const scopes = await import('../src/services/user-scopes');
    const sessions = await import('../src/auth/sessions');
    const principal = await import('../src/auth/principal');
    const purge = await import('../src/services/directory-purge');
    const tokens = await import('../src/auth/tokens');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    // Схема и `casing` — те же, что у пула приложения: иначе второй пул читал бы другие имена
    // колонок и молча возвращал бы пустоту.
    const sidePool = new pg.Pool({ connectionString: DB_URL!, max: 4 });
    const sideDb = drizzle(sidePool, { schema, casing: 'snake_case' });

    ctx = {
      app,
      db,
      sideDb,
      schema,
      scopes,
      sessions,
      principal,
      purge,
      tokens,
      closeDb,
      closeSide: () => sidePool.end(),
      adminId: '',
    };
    await cleanup(db);
    ctx.adminId = await newUser('admin', 'admin');
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeSide();
    await ctx.closeDb();
  });

  /** Набор площадок отдела так, как его ставит портал, — единственным писателем. */
  async function setObjects(departmentId: string, objectIds: string[]) {
    return ctx.db.transaction((tx) =>
      ctx.scopes.replaceDepartmentObjects(tx, departmentId, objectIds, ctx.adminId),
    );
  }

  describe('область принципала считается из таблицы связи', () => {
    it('обе площадки отдела приходят в область целиком', async () => {
      // До ADR 0144 источником была колонка, а в ней помещается один объект: набор из двух
      // площадок отдавал бы либо одну, либо (при NULL-проекции) вовсе пустую область.
      const a = await newObject('scope-a');
      const b = await newObject('scope-b');
      const dept = await newDepartment('scope');
      await setObjects(dept, [a.id, b.id]);
      const user = await newUser('scope');
      await joinDepartment(user, dept);

      const p = await ctx.principal.loadPrincipal(user);
      expect(p!.departmentObjectIds).toEqual([a.id, b.id].sort());
    });

    it('пересечение двух отделов даёт один идентификатор, а не два', async () => {
      // Человек состоит в двух отделах, и общая площадка у них одна. Дубль в наборе — не ошибка
      // доступа, но лишнее значение в `IN` и неправда о числе объектов: `DISTINCT` в агрегате
      // отвечает именно на это.
      const shared = await newObject('shared');
      const own1 = await newObject('own-one');
      const own2 = await newObject('own-two');
      const dept1 = await newDepartment('cross-one');
      const dept2 = await newDepartment('cross-two');
      await setObjects(dept1, [shared.id, own1.id]);
      await setObjects(dept2, [shared.id, own2.id]);
      const user = await newUser('cross');
      await joinDepartment(user, dept1);
      await joinDepartment(user, dept2);

      const p = await ctx.principal.loadPrincipal(user);
      expect(p!.departmentObjectIds).toEqual([shared.id, own1.id, own2.id].sort());
      // Строк связи четыре, объектов в области три — считаем именно это, а не длину «примерно».
      expect(p!.departmentObjectIds.filter((id) => id === shared.id)).toHaveLength(1);
    });

    it('порядок набора один и тот же от вызова к вызову', async () => {
      // Без `ORDER BY` внутри агрегата порядок строк определяет план запроса, а не запрос:
      // `/auth/me` менял бы ответ от обращения к обращению, ломая сравнение снимков на клиенте.
      const objects = [
        await newObject('order-a'),
        await newObject('order-b'),
        await newObject('order-c'),
      ];
      const dept = await newDepartment('order');
      await setObjects(
        dept,
        objects.map((o) => o.id),
      );
      const user = await newUser('order');
      await joinDepartment(user, dept);

      const first = (await ctx.principal.loadPrincipal(user))!.departmentObjectIds;
      const second = (await ctx.principal.loadPrincipal(user))!.departmentObjectIds;
      expect(second).toEqual(first);
      // Порядок не «какой-нибудь стабильный», а объявленный: сортировка по идентификатору.
      expect(first).toEqual([...first].sort());
    });

    it('отдел без площадок даёт пустую область, а не всю базу', async () => {
      // Пустой набор — рабочее состояние ПТО и АХО, а не незаполненность. Ошибка здесь опаснее
      // прочих: `IN ()` и «фильтра нет» — это разные ответы на один вопрос.
      const dept = await newDepartment('empty');
      const user = await newUser('empty');
      await joinDepartment(user, dept);

      const p = await ctx.principal.loadPrincipal(user);
      expect(p!.departmentObjectIds).toEqual([]);
    });

    it('/auth/me отдаёт ту же область, что и принципал', async () => {
      // Портал считает область по ответу сессии, а не по принципалу: у них общий сборщик, но
      // выражение области в `routes/auth.ts` своё, и разойтись им есть где.
      const a = await newObject('me-a');
      const b = await newObject('me-b');
      const dept = await newDepartment('me');
      await setObjects(dept, [a.id, b.id]);
      const user = await newUser('me');
      await joinDepartment(user, dept);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        remoteAddress: nextAddress(),
        headers: await authHeaders(user),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ departmentObjectIds: string[] }>().departmentObjectIds).toEqual(
        [a.id, b.id].sort(),
      );
    });
  });

  describe('замена набора: разница, версия доступа и сессии', () => {
    it('разница считается кодами, а версия и отзыв случаются в той же транзакции', async () => {
      const kept = await newObject('diff-kept');
      const added = await newObject('diff-added');
      const dropped = await newObject('diff-dropped');
      const dept = await newDepartment('diff');
      await setObjects(dept, [kept.id, dropped.id]);
      const user = await newUser('diff');
      await joinDepartment(user, dept);
      const session = await ctx.sessions.createRefreshSession(user);
      const versionBefore = await authVersionOf(user);

      await ctx.db.transaction(async (tx) => {
        const diff = await ctx.scopes.replaceDepartmentObjects(
          tx,
          dept,
          [kept.id, added.id],
          ctx.adminId,
        );
        // Разница — кодами объектов: журнал читает человек, и «снята площадка 0f3a-…» ему не
        // отвечает ни на что.
        expect(diff).toEqual({ added: [added.code], removed: [dropped.code] });

        // Внутри транзакции всё уже случилось: счётчик поднят, сессия погашена.
        const [inside] = await tx
          .select({ revokedAt: ctx.schema.refreshSessions.revokedAt })
          .from(ctx.schema.refreshSessions)
          .where(eq(ctx.schema.refreshSessions.id, session.sessionId));
        expect(
          inside!.revokedAt,
          'отзыв сессий обязан идти внутри правки, а не после коммита (Р6)',
        ).not.toBeNull();

        // …а снаружи, с другого соединения, не видно ничего: правка и отзыв — одно целое, и
        // это ровно то, чего не даёт `afterCommit`.
        const [outside] = await ctx.sideDb
          .select({ revokedAt: ctx.schema.refreshSessions.revokedAt })
          .from(ctx.schema.refreshSessions)
          .where(eq(ctx.schema.refreshSessions.id, session.sessionId));
        expect(outside!.revokedAt).toBeNull();
      });

      expect(await objectsOf(dept)).toEqual([kept.id, added.id].sort());
      // Оба действия обязательны и отвечают на разное: счётчик гасит выданные access-токены,
      // отзыв — живую refresh-сессию.
      expect(await authVersionOf(user)).toBe(versionBefore + 1);
      expect(await liveSessionIds(user)).toEqual([]);
    });

    it('после коммита старой refresh-сессией токен уже не обновить', async () => {
      // `authVersion` сам по себе живую сессию не трогает: `POST /auth/refresh` прозрачно выдал бы
      // новый access-токен с новой версией, и человек остался бы в портале.
      const a = await newObject('revoke-a');
      const dept = await newDepartment('revoke');
      const user = await newUser('revoke');
      await joinDepartment(user, dept);
      const session = await ctx.sessions.createRefreshSession(user);

      // Пока область не трогали, сессия работает — иначе проверка ниже сошлась бы на чём угодно.
      const before = await refresh(session.token);
      expect(before.statusCode, before.body).toBe(200);
      const rotated = before.cookies.find((c) => c.name === 'refresh_token')!.value;

      await setObjects(dept, [a.id]);

      const after = await refresh(rotated);
      expect(after.statusCode, after.body).toBe(401);
    });

    it('откат правки не гасит сессии: области не сменилось — гасить нечего', async () => {
      // Обратная сторона Р6. Отзыв внутри транзакции откатывается вместе с ней, и это верно:
      // сессия, погашенная правкой, которой не было, выкинула бы человека из портала без причины.
      const a = await newObject('rollback-a');
      const dept = await newDepartment('rollback');
      const user = await newUser('rollback');
      await joinDepartment(user, dept);
      const session = await ctx.sessions.createRefreshSession(user);
      const versionBefore = await authVersionOf(user);

      await expect(
        ctx.db.transaction(async (tx) => {
          await ctx.scopes.replaceDepartmentObjects(tx, dept, [a.id], ctx.adminId);
          throw new Error('правка отменена');
        }),
      ).rejects.toThrow('правка отменена');

      expect(await objectsOf(dept)).toEqual([]);
      expect(await authVersionOf(user)).toBe(versionBefore);
      expect(await liveSessionIds(user)).toEqual([session.sessionId]);
      // Не только строка в базе: сессия действительно рабочая.
      const res = await refresh(session.token);
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('совместимость с колонкой: триггер department_object_sync_trg', () => {
    it('INSERT отдела с площадкой заводит набор из одной', async () => {
      // Так отдел заводит код предыдущей версии в окне выката: он пишет колонку и о таблице связи
      // не знает. Без триггера площадка легла бы в поле, которого новый код не читает.
      const a = await newObject('trg-insert');
      const dept = await newDepartment('trg-insert', a.id);

      expect(await objectsOf(dept)).toEqual([a.id]);
      // Автора у такой привязки нет: её завёл не человек, а код предыдущей версии.
      expect((await linksOf(dept))[0]!.createdBy).toBeNull();
    });

    it('UPDATE колонки на другую площадку схлопывает набор из нескольких', async () => {
      // Намерение писавшего колонку — «площадка у отдела вот эта», и в момент такой записи оно и
      // есть источник правды: иначе предыдущая версия показывала бы одно, а область считалась бы
      // по другому.
      const a = await newObject('trg-move-a');
      const b = await newObject('trg-move-b');
      const c = await newObject('trg-move-c');
      const dept = await newDepartment('trg-move');
      await setObjects(dept, [a.id, b.id]);

      await ctx.db
        .update(ctx.schema.departments)
        .set({ constructionObjectId: c.id })
        .where(eq(ctx.schema.departments.id, dept));

      expect(await objectsOf(dept)).toEqual([c.id]);
    });

    it('UPDATE тем же значением набор не трогает', async () => {
      // `UPDATE OF construction_object_id` срабатывает от одного УПОМИНАНИЯ колонки в `SET`, а не
      // от смены значения. Отсечка `TG_OP` внутри функции — единственное, что отличает правку
      // площадки от правки названия, пришедшей вместе с прежним значением колонки.
      const a = await newObject('trg-same');
      const dept = await newDepartment('trg-same');
      await setObjects(dept, [a.id]);
      const before = (await linksOf(dept))[0]!;

      await ctx.db
        .update(ctx.schema.departments)
        .set({ constructionObjectId: a.id, name: `Отдел переименован ${RUN}` })
        .where(eq(ctx.schema.departments.id, dept));

      const after = (await linksOf(dept))[0]!;
      expect(await objectsOf(dept)).toEqual([a.id]);
      // Строку не пересоздавали: сработавший триггер снёс бы привязку и вставил свою — без автора
      // и с новым временем, то есть подменил бы историю «кто и когда выдал отделу эту площадку».
      expect(after.createdBy).toBe(before.createdBy);
      expect(after.createdBy).toBe(ctx.adminId);
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    });

    it('UPDATE тем же NULL не сносит набор из нескольких площадок', async () => {
      // Самый дорогой случай отсечки. У набора из нескольких колонка-проекция равна `NULL`, и
      // любая правка, переписавшая её тем же `NULL` (правка названия старой формой, импорт),
      // без отсечки снесла бы весь набор — молча и на боевой схеме.
      const a = await newObject('trg-null-a');
      const b = await newObject('trg-null-b');
      const dept = await newDepartment('trg-null-keep');
      await setObjects(dept, [a.id, b.id]);
      expect(await columnOf(dept)).toBeNull();

      await ctx.db
        .update(ctx.schema.departments)
        .set({ constructionObjectId: null, name: `Отдел с прежним NULL ${RUN}` })
        .where(eq(ctx.schema.departments.id, dept));

      expect(await objectsOf(dept)).toEqual([a.id, b.id].sort());
      expect((await linksOf(dept)).map((l) => l.createdBy)).toEqual([ctx.adminId, ctx.adminId]);
    });

    it('UPDATE колонки в NULL опустошает набор', async () => {
      // А вот это уже настоящая смена значения: предыдущая версия сняла отделу площадку, и набор
      // обязан опустеть — иначе снятая площадка продолжала бы давать область.
      const a = await newObject('trg-clear');
      const dept = await newDepartment('trg-clear');
      await setObjects(dept, [a.id]);

      await ctx.db
        .update(ctx.schema.departments)
        .set({ constructionObjectId: null })
        .where(eq(ctx.schema.departments.id, dept));

      expect(await objectsOf(dept)).toEqual([]);
    });

    it('набор из нескольких оставляет в колонке NULL, набор из одной — саму площадку', async () => {
      // Обратное направление держит сервис: он пишет проекцию ПЕРВЫМ шагом, а набор — вторым,
      // поверх того, что оставил триггер. Переставь шаги местами — набор схлопнулся бы сразу
      // после записи, причём только на боевой схеме.
      const a = await newObject('proj-a');
      const b = await newObject('proj-b');
      const dept = await newDepartment('proj');

      await setObjects(dept, [a.id, b.id]);
      expect(await objectsOf(dept)).toEqual([a.id, b.id].sort());
      expect(await columnOf(dept)).toBeNull();

      await setObjects(dept, [b.id]);
      expect(await objectsOf(dept)).toEqual([b.id]);
      expect(await columnOf(dept)).toBe(b.id);

      await setObjects(dept, []);
      expect(await objectsOf(dept)).toEqual([]);
      expect(await columnOf(dept)).toBeNull();
    });
  });

  describe('удаление объекта насовсем упирается в площадку отдела', () => {
    it('маршрут отказывает человеческим текстом, а объект остаётся', async () => {
      // Объект деактивирован — иначе маршрут отказал бы раньше и по другой причине («сначала
      // деактивируйте»), и проверялась бы не та преграда.
      const a = await newObject('purge-a', false);
      const b = await newObject('purge-b', false);
      const dept = await newDepartment('purge');
      // Набор из двух намеренно: при наборе из одного объект держала бы ещё и колонка-проекция,
      // и отказ мог бы прийти от неё — то есть от связи, которой через релиз не будет.
      await setObjects(dept, [a.id, b.id]);

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${a.id}/purge`,
        remoteAddress: nextAddress(),
        headers: await authHeaders(ctx.adminId),
      });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ message: string }>().message).toBe(
        'Объект указан площадкой отделов (1) — снимите привязку и повторите',
      );
      const [row] = await ctx.db
        .select({ id: ctx.schema.constructionObjects.id })
        .from(ctx.schema.constructionObjects)
        .where(eq(ctx.schema.constructionObjects.id, a.id));
      expect(row, 'объект обязан остаться в справочнике').toBeDefined();
    });

    it('за сообщением стоит RESTRICT, и отказ БД переводится в «площадки отделов»', async () => {
      // Сообщение живёт в коде и может отстать от схемы, ограничение — нет (Р2). Проверяется
      // заодно и ключ карты названий: имя таблицы приходит от самой БД, и опечатка в нём
      // превратила бы отказ в безликое «ссылаются другие данные».
      const a = await newObject('restrict-a', false);
      const b = await newObject('restrict-b', false);
      const dept = await newDepartment('restrict');
      await setObjects(dept, [a.id, b.id]);

      let caught: unknown;
      try {
        await ctx.db
          .delete(ctx.schema.constructionObjects)
          .where(eq(ctx.schema.constructionObjects.id, a.id));
      } catch (e) {
        caught = e;
      }
      expect(caught, 'RESTRICT обязан не дать удалить объект, назначенный площадкой').toBeDefined();

      const mapped = ctx.purge.asReferenceConflict(caught, 'объект') as {
        statusCode?: number;
        message?: string;
      };
      expect(mapped.statusCode).toBe(409);
      expect(mapped.message).toBe(
        'Удалить объект насовсем нельзя: на запись ссылаются площадки отделов',
      );
    });
  });

  describe('старая вкладка справочника: совместимость на один релиз (Р11)', () => {
    it('старое поле против набора из нескольких — 409, и набор на месте', async () => {
      // Старая форма выражает ровно одну площадку и шлёт её при КАЖДОМ сохранении карточки — даже
      // когда правят одно название. Против набора из трёх это означало бы «оставить одну», чего
      // человек за старой формой не выбирал и выбрать не мог: набора он не видит.
      const a = await newObject('legacy-a');
      const b = await newObject('legacy-b');
      const dept = await newDepartment('legacy-conflict');
      await setObjects(dept, [a.id, b.id]);
      const nameBefore = await nameOf(dept);

      const res = await patchDepartment(await authHeaders(ctx.adminId), dept, {
        name: `Переименовано старой вкладкой ${RUN}`,
        constructionObjectId: a.id,
      });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ message: string }>().message).toBe(
        'У отдела несколько площадок — обновите страницу',
      );
      // Отказ вместо потери: название не сохранилось, зато площадки не исчезли.
      expect(await objectsOf(dept)).toEqual([a.id, b.id].sort());
      expect(await nameOf(dept)).toBe(nameBefore);
    });

    it('старое поле при наборе не больше одного принимается как набор из одного', async () => {
      // Иначе совместимость не давала бы работать вовсе: набор из одного и пустой набор старая
      // форма выражает верно.
      const a = await newObject('legacy-set');
      const dept = await newDepartment('legacy-set');

      const res = await patchDepartment(await authHeaders(ctx.adminId), dept, {
        constructionObjectId: a.id,
      });

      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json<DepartmentDto>();
      expect(dto.objects.map((o) => o.id)).toEqual([a.id]);
      // Выходная половина совместимости: при наборе из одного старая вкладка видит свою площадку.
      expect(dto.object?.id).toBe(a.id);
      expect(await objectsOf(dept)).toEqual([a.id]);
    });

    it('null старого поля снимает единственную площадку', async () => {
      // `null` означал «площадки нет» — рабочее состояние ПТО и АХО, а не пропуск поля. В наборе
      // это пустой список, а не список из одного `null`.
      const a = await newObject('legacy-null');
      const dept = await newDepartment('legacy-null');
      await setObjects(dept, [a.id]);

      const res = await patchDepartment(await authHeaders(ctx.adminId), dept, {
        constructionObjectId: null,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<DepartmentDto>().objects).toEqual([]);
      expect(res.json<DepartmentDto>().object).toBeNull();
      expect(await objectsOf(dept)).toEqual([]);
    });

    it('оба поля разом — 400, и набор не тронут', async () => {
      // Тело задаёт два итога сразу, и вопрос «какой из них главный» ответа не имеет. Старый
      // клиент нового поля не знает и под это правило не попадает никогда — попадает только новый
      // код, написавший лишнее.
      const a = await newObject('legacy-both-a');
      const b = await newObject('legacy-both-b');
      const dept = await newDepartment('legacy-both');
      await setObjects(dept, [a.id]);

      const res = await patchDepartment(await authHeaders(ctx.adminId), dept, {
        constructionObjectId: a.id,
        constructionObjectIds: [b.id],
      });

      expect(res.statusCode, res.body).toBe(400);
      expect(Object.keys(res.json<{ fields: Record<string, string> }>().fields)).toContain(
        'constructionObjectId',
      );
      expect(await objectsOf(dept)).toEqual([a.id]);
    });

    it('POST с одним старым полем правилом «оба сразу» не ловится', async () => {
      // У схемы создания набор объявлен с `.default([])`, и после разбора «поля не было»
      // неотличимо от «прислали пустой список»: нормализация обязана идти ДО применения
      // умолчания, иначе legacy-запрос выглядел бы запросом с обоими полями и получал 400.
      const a = await newObject('legacy-post');
      seq += 1;
      const code = `${CODE_PREFIX}-${RUN}-D${seq}-legacy-post`;

      const res = await postDepartment(await authHeaders(ctx.adminId), {
        code,
        name: `Отдел старой вкладкой ${RUN}`,
        constructionObjectId: a.id,
      });

      expect(res.statusCode, res.body).toBe(201);
      const dto = res.json<DepartmentDto>();
      expect(dto.objects.map((o) => o.id)).toEqual([a.id]);
      expect(await objectsOf(dto.id)).toEqual([a.id]);
    });
  });

  describe('правка одних руководителей гасит их сессии', () => {
    it('PATCH с одними руководителями поднимает версию и отзывает сессии назначенного', async () => {
      // Отзыв переехал внутрь `replaceDepartmentHeads` (ADR 0144, решение 6): маршрутный
      // `revokeScopeChanged` снят целиком, и не перенеси его — правка ОДНИХ руководителей
      // осталась бы без отзыва вовсе, а снятый руководитель дообновлял бы токен по живой сессии.
      const dept = await newDepartment('heads');
      const head = await newUser('head');
      const session = await ctx.sessions.createRefreshSession(head);
      const versionBefore = await authVersionOf(head);

      const res = await patchDepartment(await authHeaders(ctx.adminId), dept, {
        headUserIds: [head],
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<DepartmentDto>().heads.map((h) => h.id)).toEqual([head]);
      expect(await authVersionOf(head)).toBe(versionBefore + 1);
      expect(await liveSessionIds(head)).toEqual([]);
      const after = await refresh(session.token);
      expect(after.statusCode, after.body).toBe(401);
    });
  });

  describe('дубли в присланном наборе', () => {
    it('дубль не роняет запись, не удваивается в журнале и не портит проекцию', async () => {
      // Схема допускает одинаковые UUID в присланном списке. Без канонизации они упёрлись бы в
      // первичный ключ таблицы связи, а сравнение «изменилось ли» соврало бы ещё раньше — на
      // длине списка.
      const a = await newObject('dup-a');
      const dept = await newDepartment('dup-one');

      const res = await patchDepartment(await authHeaders(ctx.adminId), dept, {
        constructionObjectIds: [a.id, a.id],
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<DepartmentDto>().objects.map((o) => o.id)).toEqual([a.id]);
      expect(await objectsOf(dept)).toEqual([a.id]);
      // Проекция в колонку считается по ДЛИНЕ набора: `[A, A]` без канонизации выглядит набором из
      // двух, и в колонке оказался бы `NULL` — то есть предыдущая версия кода перестала бы видеть
      // единственную площадку отдела.
      expect(await columnOf(dept)).toBe(a.id);
      // Разница в журнале — то, чем задним числом объясняют смену области; дубль в ней означал бы
      // «выдали одну и ту же площадку дважды».
      const audit = await lastDepartmentAudit(dept);
      expect(audit!.action).toBe('department.update');
      expect(auditObjects(audit!.metadata)).toEqual({ added: [a.code], removed: [] });
    });

    it('тот же набор в другом порядке и с дублями изменением не считается', async () => {
      // Перезапись набора теми же строками подменила бы `created_by`/`created_at` привязок, а
      // `authVersion` и отзыв сессий выкинули бы из портала весь отдел из-за правки, его области
      // не касавшейся: набор в теле формы лежит всегда, даже когда правят одно название.
      const a = await newObject('dup-set-a');
      const b = await newObject('dup-set-b');
      const dept = await newDepartment('dup-set');
      const user = await newUser('dup-set');
      await joinDepartment(user, dept);
      const headers = await authHeaders(ctx.adminId);

      const first = await patchDepartment(headers, dept, {
        constructionObjectIds: [a.id, a.id, b.id],
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(await objectsOf(dept)).toEqual([a.id, b.id].sort());
      // Разница первой правки — по одному коду на площадку, без дублей. Порядок кодов сверяется
      // сортировкой самого теста, а не повторением правила сортировки из сервиса: проверять код
      // им же значило бы согласиться заранее с любой его перестановкой.
      const firstDiff = auditObjects((await lastDepartmentAudit(dept))!.metadata);
      expect(firstDiff.removed).toEqual([]);
      expect(firstDiff.added).toHaveLength(2);
      expect([...firstDiff.added].sort()).toEqual([a.code, b.code].sort());

      const versionAfterFirst = await authVersionOf(user);
      const linksAfterFirst = await linksOf(dept);
      const session = await ctx.sessions.createRefreshSession(user);

      const second = await patchDepartment(headers, dept, {
        constructionObjectIds: [b.id, a.id, a.id, b.id],
      });
      expect(second.statusCode, second.body).toBe(200);

      expect(await objectsOf(dept)).toEqual([a.id, b.id].sort());
      expect(await authVersionOf(user)).toBe(versionAfterFirst);
      expect(await liveSessionIds(user)).toEqual([session.sessionId]);
      // Привязки не пересоздавались — история «кто и когда выдал площадку» цела.
      expect((await linksOf(dept)).map((l) => l.createdAt.getTime())).toEqual(
        linksAfterFirst.map((l) => l.createdAt.getTime()),
      );
      expect(auditObjects((await lastDepartmentAudit(dept))!.metadata)).toEqual({
        added: [],
        removed: [],
      });
    });
  });
});
