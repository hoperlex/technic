import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleAddon } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as UserScopesNs from '../src/services/user-scopes';

/**
 * Двойная запись назначений (ADR 0106, решение 9, шаг 1a; план реструктуризации модели доступа,
 * §13) — на живой схеме.
 *
 * Зачем база. Предмет теста и есть база: `replaceUserAddons` пишет разницу в две таблицы одной
 * транзакцией, и всё, что здесь проверяется, — свойства строк, которых на подменах не существует.
 * Собственный `id` назначения выдаёт `gen_random_uuid()`, время выдачи — умолчание `now()`,
 * повторную выдачу гасит `UNIQUE (user_id, grant_id)`, а сами системные наборы завела миграция
 * 0145. Мок ответил бы «функция вызвана» на любую из ошибок, ради которых шаг 1a и написан так.
 *
 * Главное утверждение — второе: добавление второй надстройки **не трогает первую**. Зеркалирование
 * `replaceUserAddons` буквально («снести всё и вставить заново») прошло бы все остальные проверки и
 * при этом каждый раз выдавало бы уцелевшему назначению новый `id`, нового автора и новое время. На
 * неизменности `id` держится откат будущего перевода ролей: он снимает свои строки и не трогает
 * выданное вручную, а найти их он может только по идентификаторам.
 *
 * Чтение здесь не проверяется намеренно: на шаге 1a права по-прежнему считаются по
 * `user_role_addons` (переключение — шаг 1c), и поведение `can` этот тест не касается.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-dual-write.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая с другими db-тестами и переживает прогоны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
/**
 * Метка своих учёток: уборка идёт по ней, а не «по последним строкам». Префикс общий на все
 * прогоны — упавший прогон обязан убираться следующим, а не копить учётки в общей базе.
 */
const EMAIL_PREFIX = 'db-user-grants-dual-write';

const OPERATOR: RoleAddon = 'office_equipment_operator';
const IT_APPROVER: RoleAddon = 'office_equipment_it_approver';

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof UserScopesNs;
  closeDb: () => Promise<void>;
  /** Кто выдаёт: двое, чтобы `granted_by` уцелевшего назначения было с чем спутать. */
  adminId: string;
  otherAdminId: string;
}

let ctx: Ctx;
let userSeq = 0;

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
  // Почта тут ни при чём: тест зовёт сервис напрямую, мимо маршрутов учёток.
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
 * Уборка своих учёток — и перед прогоном тоже. Достаточно удалить `users`: назначения и надстройки
 * уходят каскадом (`user_grants.user_id`, `user_role_addons.user_id` — оба `ON DELETE CASCADE`), а
 * `granted_by` у чужих строк каскад не трогает вовсе.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
}

/** Подопытная учётка: роль `shtab` — та, которой надстройки и положены (`ROLE_ADDON_BASE_ROLES`). */
async function newUser(role: 'shtab' | 'admin' = 'shtab'): Promise<string> {
  userSeq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${RUN}-${userSeq}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: `Надстроечный ${userSeq}`,
      // Входа здесь нет: тест зовёт сервис напрямую, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
}

/** Правка набора надстроек так, как её делает маршрут учёток, — своей транзакцией. */
async function setAddons(
  userId: string,
  addons: RoleAddon[],
  actorUserId: string,
): Promise<boolean> {
  return ctx.db.transaction((tx) => ctx.service.replaceUserAddons(tx, userId, addons, actorUserId));
}

interface AddonRow {
  addon: RoleAddon;
  grantedBy: string | null;
  grantedAt: Date;
}

/** Старая таблица — источник чтения на шаге 1a. */
async function addonRows(userId: string): Promise<AddonRow[]> {
  return ctx.db
    .select({
      addon: ctx.schema.userRoleAddons.addon,
      grantedBy: ctx.schema.userRoleAddons.grantedBy,
      grantedAt: ctx.schema.userRoleAddons.grantedAt,
    })
    .from(ctx.schema.userRoleAddons)
    .where(eq(ctx.schema.userRoleAddons.userId, userId))
    .orderBy(asc(ctx.schema.userRoleAddons.addon));
}

interface GrantRow {
  id: string;
  code: string;
  grantedBy: string | null;
  grantedAt: Date;
  origin: string;
  migrationId: string | null;
}

/**
 * Новая схема, прочитанная по коду набора: назначение ссылается на `grants.id`, а сопоставляется с
 * надстройкой именно код — тот самый, который двойная запись и ищет.
 */
async function grantRows(userId: string): Promise<GrantRow[]> {
  return ctx.db
    .select({
      id: ctx.schema.userGrants.id,
      code: ctx.schema.grants.code,
      grantedBy: ctx.schema.userGrants.grantedBy,
      grantedAt: ctx.schema.userGrants.grantedAt,
      origin: ctx.schema.userGrants.origin,
      migrationId: ctx.schema.userGrants.migrationId,
    })
    .from(ctx.schema.userGrants)
    .innerJoin(ctx.schema.grants, eq(ctx.schema.grants.id, ctx.schema.userGrants.grantId))
    .where(eq(ctx.schema.userGrants.userId, userId))
    .orderBy(asc(ctx.schema.grants.code));
}

describe.skipIf(!DB_URL)('назначения: двойная запись надстроек (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/user-scopes');
    await cleanup(db);

    ctx = {
      db,
      schema,
      service,
      closeDb,
      adminId: '',
      otherAdminId: '',
    };
    ctx.adminId = await newUser('admin');
    ctx.otherAdminId = await newUser('admin');

    // Системные наборы завела миграция 0145, и без них двойной записи некуда вставлять назначение.
    // Если их нет — сломан не тест, а накат: пусть это будет видно здесь, а не в чужом ожидании.
    const codes = await db
      .select({ code: schema.grants.code })
      .from(schema.grants)
      .orderBy(asc(schema.grants.code));
    const present = new Set(codes.map((row) => row.code));
    for (const code of [OPERATOR, IT_APPROVER]) {
      if (!present.has(code)) throw new Error(`В базе нет системного набора «${code}»`);
    }
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('выдача надстройки заводит строку и в старой таблице, и в назначениях', async () => {
    const userId = await newUser();
    expect(await setAddons(userId, [OPERATOR], ctx.adminId)).toBe(true);

    const addons = await addonRows(userId);
    expect(addons.map((row) => row.addon)).toEqual([OPERATOR]);
    expect(addons[0]!.grantedBy).toBe(ctx.adminId);

    const granted = await grantRows(userId);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.code).toBe(OPERATOR);
    // `manual` — выдал администратор. `migration` зарезервирован за переводом ролей, и колонка
    // перевода на этом шаге обязана оставаться пустой: писателя у неё ещё нет вовсе.
    expect(granted[0]!.origin).toBe('manual');
    expect(granted[0]!.migrationId).toBeNull();
    expect(granted[0]!.grantedBy).toBe(ctx.adminId);
    // Обе записи — одна транзакция, поэтому и время у них одно: `now()` в Postgres — момент начала
    // транзакции, а не строки.
    expect(granted[0]!.grantedAt.getTime()).toBe(addons[0]!.grantedAt.getTime());
  });

  /**
   * Главное утверждение шага 1a. Вторая надстройка выдаётся **другим** администратором и другой
   * транзакцией: пересоздание уцелевшей строки выдало бы себя тремя способами сразу — новым `id`,
   * чужим автором и более поздним временем.
   */
  it('добавление второй надстройки не трогает назначение первой', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);
    const [before] = await grantRows(userId);
    const [beforeAddon] = await addonRows(userId);

    expect(await setAddons(userId, [OPERATOR, IT_APPROVER], ctx.otherAdminId)).toBe(true);

    const after = await grantRows(userId);
    expect(after.map((row) => row.code)).toEqual([IT_APPROVER, OPERATOR]);
    const operator = after.find((row) => row.code === OPERATOR)!;
    expect(operator.id).toBe(before!.id);
    expect(operator.grantedAt.getTime()).toBe(before!.grantedAt.getTime());
    expect(operator.grantedBy).toBe(ctx.adminId);

    // Новое назначение — своё во всём: свой идентификатор, свой автор, своё время.
    const approver = after.find((row) => row.code === IT_APPROVER)!;
    expect(approver.id).not.toBe(before!.id);
    expect(approver.grantedBy).toBe(ctx.otherAdminId);
    expect(approver.grantedAt.getTime()).toBeGreaterThan(before!.grantedAt.getTime());

    // Старая таблица тоже идёт разницей: перенос шага 1b копирует `granted_by` и `granted_at`
    // именно из неё, и пересоздание увезло бы в новую схему уже переписанную историю выдачи.
    const afterAddons = await addonRows(userId);
    const operatorAddon = afterAddons.find((row) => row.addon === OPERATOR)!;
    expect(operatorAddon.grantedBy).toBe(ctx.adminId);
    expect(operatorAddon.grantedAt.getTime()).toBe(beforeAddon!.grantedAt.getTime());
  });

  it('снятие одной надстройки удаляет ровно её строку из обеих таблиц', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR, IT_APPROVER], ctx.adminId);
    const kept = (await grantRows(userId)).find((row) => row.code === IT_APPROVER)!;

    expect(await setAddons(userId, [IT_APPROVER], ctx.otherAdminId)).toBe(true);

    expect((await addonRows(userId)).map((row) => row.addon)).toEqual([IT_APPROVER]);
    const after = await grantRows(userId);
    expect(after.map((row) => row.code)).toEqual([IT_APPROVER]);
    // Уцелевшее назначение — то же самое, а не выданное заново вместо снятого соседа.
    expect(after[0]!.id).toBe(kept.id);
    expect(after[0]!.grantedAt.getTime()).toBe(kept.grantedAt.getTime());
  });

  /**
   * Повторная выдача уже выданного набора. Через сам сервис такого состояния не бывает — он видит
   * отсутствие разницы и не пишет ничего, — поэтому расхождение таблиц создаётся руками: надстройку
   * из старой таблицы уносит прямой `DELETE`, будто её сняла версия портала без двойной записи.
   * Ровно с таким состоянием и встретится шаг 1b, и вставка обязана его пережить: `ON CONFLICT
   * (user_id, grant_id) DO NOTHING` оставляет одну строку с прежним `id`, а не роняет правку
   * учётки на ограничении и не заводит второе назначение того же набора.
   */
  it('повторная выдача той же надстройки не создаёт второго назначения', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);
    const [before] = await grantRows(userId);

    await ctx.db
      .delete(ctx.schema.userRoleAddons)
      .where(eq(ctx.schema.userRoleAddons.userId, userId));
    expect(await setAddons(userId, [OPERATOR], ctx.otherAdminId)).toBe(true);

    const after = await grantRows(userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.grantedAt.getTime()).toBe(before!.grantedAt.getTime());
    // Автор прежний: `DO NOTHING` не переписывает строку, а повторная выдача её не «обновляет».
    expect(after[0]!.grantedBy).toBe(ctx.adminId);
  });

  /**
   * Отзыв и новая выдача — это новое назначение, а не воскрешение прежнего (ADR 0106, решение 3).
   * Переиспользование `id` сделало бы откат перевода ролей слепым: он снял бы строку, которую
   * администратор выдал заново по своей причине.
   */
  it('выданная заново надстройка получает новый идентификатор', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);
    const [first] = await grantRows(userId);

    await setAddons(userId, [], ctx.adminId);
    expect(await grantRows(userId)).toHaveLength(0);

    await setAddons(userId, [OPERATOR], ctx.otherAdminId);
    const [second] = await grantRows(userId);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.grantedBy).toBe(ctx.otherAdminId);
    expect(second!.origin).toBe('manual');
  });

  it('набор без изменений не пишет ничего', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR, IT_APPROVER], ctx.adminId);
    const before = await grantRows(userId);
    const beforeAddons = await addonRows(userId);

    // Порядок другой, состав тот же — разницы нет, и трогать нечего.
    expect(await setAddons(userId, [IT_APPROVER, OPERATOR], ctx.otherAdminId)).toBe(false);

    expect(await grantRows(userId)).toEqual(before);
    expect(await addonRows(userId)).toEqual(beforeAddons);
  });

  /**
   * Атомарность двойной записи. Наполовину применённая правка означала бы, что право снято в одной
   * таблице и осталось в другой, — а какая из двух истина, зависит от того, какой шаг перехода
   * сейчас выкачен. Транзакция здесь падает после вызова сервиса, как упала бы правка учётки на
   * любой следующей проверке.
   */
  it('откат транзакции не оставляет назначение без надстройки', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);

    await expect(
      ctx.db.transaction(async (tx) => {
        await ctx.service.replaceUserAddons(tx, userId, [OPERATOR, IT_APPROVER], ctx.adminId);
        throw new Error('правка учётки не удалась');
      }),
    ).rejects.toThrow('правка учётки не удалась');

    expect((await addonRows(userId)).map((row) => row.addon)).toEqual([OPERATOR]);
    expect((await grantRows(userId)).map((row) => row.code)).toEqual([OPERATOR]);
  });
});
