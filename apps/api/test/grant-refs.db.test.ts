import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as CatalogNs from '../src/services/grant-catalog';
import type * as UserScopesNs from '../src/services/user-scopes';

/**
 * Назначения учётки, прочитанные для окна учётки (план «полномочия назначаются в окне учётки», §4):
 * `grantRefsByUserIds` — то, что уходит в `UserAccountDto.grants`, и `assignmentsOfUser` — то, из
 * чего считается разница. Плюс `lockGrants` — порядок захвата строк наборов (Р6).
 *
 * **Зачем база.** Предмет теста и есть SQL. `roleMismatch` считается соединением с `grant_roles` по
 * роли учётки — тем же, что стоит гейтом в выражении чтения прав, — и на подменах «гейт есть» и
 * «гейта нет» выглядят одинаково. Ровно так же не существует на моках ни фильтр `deleted_at`, ни
 * право-сирота в составе набора, ни `FOR UPDATE`.
 *
 * **Главное утверждение — первое:** в поле идут **все** живые назначения, включая несовместимые с
 * ролью. Отдай мы здесь только совместимые — правило полноты высказывания (§4.2) стало бы
 * невыполнимым ровно в том переходе, ради которого оно заведено: версию гасимого набора порталу
 * взять было бы неоткуда.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/grant-refs.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая с другими db-тестами и переживает прогоны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
/** Метка своих строк: уборка идёт по ней, а не «по последним строкам». */
const PREFIX = 'db-grant-refs';

/** Право, снятое из словаря выкатом: в базе строка есть, в `PERMISSIONS` его нет. */
const RETIRED_PERMISSION = 'officeEquipment.retire';

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  catalog: typeof CatalogNs;
  scopes: typeof UserScopesNs;
  closeDb: () => Promise<void>;
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
 * Уборка своих строк — и перед прогоном тоже. Порядок обязателен: `user_grants.grant_id` стоит под
 * RESTRICT, и свой набор не удалить, пока он кому-то выдан; учётки уносят назначения каскадом.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${PREFIX}%`}`);
}

async function newUser(role: Role | null): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${PREFIX}-${RUN}-${seq}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: `Наборный ${seq}`,
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: role !== null,
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
}

/** Набор, собранный тестом: не системный — ровно такие и собирает администратор. */
async function newGrant(options: {
  roles: Role[];
  permissions: string[];
  deleted?: boolean;
  codeSuffix?: string;
  version?: number;
}): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.grants)
    .values({
      code: `${PREFIX}-${RUN}-${options.codeSuffix ?? String(seq).padStart(3, '0')}`,
      name: `Тестовый набор ${options.codeSuffix ?? seq}`,
      isSystem: false,
      version: options.version ?? 1,
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({ id: ctx.schema.grants.id });
  const grantId = created!.id;
  if (options.roles.length > 0) {
    await ctx.db
      .insert(ctx.schema.grantRoles)
      .values(options.roles.map((role) => ({ grantId, role })));
  }
  if (options.permissions.length > 0) {
    await ctx.db
      .insert(ctx.schema.grantPermissions)
      .values(options.permissions.map((permission) => ({ grantId, permission })));
  }
  return grantId;
}

/**
 * Выдача набора учётке. Напрямую в таблицу: предмет теста — чтение, а не маршрут выдачи.
 *
 * Взведённое переводом назначение требует снимка перевода: `origin = 'migration'` без
 * `migration_id` база не примет (CHECK согласованности, миграция 0154). Снимок поэтому заводится
 * здесь же — иначе происхождение назначения нечем было бы проверить вовсе.
 */
async function assign(
  userId: string,
  grantId: string,
  origin: 'manual' | 'migration' = 'manual',
): Promise<void> {
  let migrationId: string | null = null;
  if (origin === 'migration') {
    const [snapshot] = await ctx.db
      .insert(ctx.schema.userRoleMigration)
      .values({ userId, stage: 8, roleBefore: 'shtab', roleAfter: 'site' })
      .returning({ id: ctx.schema.userRoleMigration.id });
    migrationId = snapshot!.id;
  }
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.adminId, origin, migrationId });
}

describe.skipIf(!DB_URL)('назначения учётки для окна правки (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const catalog = await import('../src/services/grant-catalog');
    const scopes = await import('../src/services/user-scopes');
    await cleanup(db);

    ctx = { db, schema, catalog, scopes, closeDb, adminId: '' };
    ctx.adminId = await newUser('admin');
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('в поле идут все живые назначения — и совместимые, и нет, — по коду', async () => {
    const userId = await newUser('site');
    // Коды заданы явно: порядок ответа проверяется по ним, а не по порядку выдачи.
    const compatible = await newGrant({ roles: ['site'], permissions: [], codeSuffix: 'b-live' });
    const mismatched = await newGrant({ roles: ['shtab'], permissions: [], codeSuffix: 'a-alien' });
    const removed = await newGrant({
      roles: ['site'],
      permissions: [],
      codeSuffix: 'c-dead',
      deleted: true,
    });
    await assign(userId, compatible);
    await assign(userId, mismatched, 'migration');
    await assign(userId, removed);

    const refs = (await ctx.scopes.grantRefsByUserIds(ctx.db, [userId])).get(userId) ?? [];
    expect(refs.map((ref) => ref.id)).toEqual([mismatched, compatible]);
    expect(refs[0]).toMatchObject({ roleMismatch: true, origin: 'migration', version: 1 });
    expect(refs[1]).toMatchObject({ roleMismatch: false, origin: 'manual' });
    // Мягко удалённый набор не действует ни у кого — и чекбоксом его не показывают.
    expect(refs.map((ref) => ref.id)).not.toContain(removed);
  });

  it('у учётки без роли назначение живо, а прав по нему нет', async () => {
    const userId = await newUser(null);
    const grantId = await newGrant({ roles: ['site'], permissions: [] });
    await assign(userId, grantId);

    const refs = (await ctx.scopes.grantRefsByUserIds(ctx.db, [userId])).get(userId) ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.roleMismatch).toBe(true);
  });

  it('читается пачкой: два держателя — один запрос и две строки ответа', async () => {
    const first = await newUser('site');
    const second = await newUser('shtab');
    const grantId = await newGrant({ roles: ['site'], permissions: [] });
    await assign(first, grantId);
    await assign(second, grantId);

    const refs = await ctx.scopes.grantRefsByUserIds(ctx.db, [first, second]);
    expect(refs.get(first)![0]!.roleMismatch).toBe(false);
    expect(refs.get(second)![0]!.roleMismatch).toBe(true);
  });

  it('назначения для расчёта несут состав, роли, версию и происхождение', async () => {
    const userId = await newUser('site');
    const grantId = await newGrant({
      roles: ['site', 'shtab'],
      // Сирота в составе: в базе строка есть, доступа она не даёт, и читателю её видеть незачем.
      permissions: ['audit.read', RETIRED_PERMISSION],
      version: 5,
    });
    await assign(userId, grantId, 'migration');

    const assignments = await ctx.catalog.assignmentsOfUser(ctx.db, userId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      id: grantId,
      version: 5,
      origin: 'migration',
      permissions: ['audit.read'],
    });
    // Порядок ролей — словарный (`ROLES`), а не порядок вставки.
    expect(assignments[0]!.roles).toEqual(['shtab', 'site']);
    expect(assignments[0]!.assignmentId).toBeTruthy();
  });

  it('порядок назначений — по возрастанию `grant_id`: им же берутся блокировки', async () => {
    const userId = await newUser('site');
    const ids = [
      await newGrant({ roles: ['site'], permissions: [] }),
      await newGrant({ roles: ['site'], permissions: [] }),
      await newGrant({ roles: ['site'], permissions: [] }),
    ];
    for (const id of ids) await assign(userId, id);

    const assignments = await ctx.catalog.assignmentsOfUser(ctx.db, userId);
    expect(assignments.map((row) => row.id)).toEqual([...ids].sort());
  });

  it('блокировка берёт существующие строки наборов и молчит о ненайденных', async () => {
    const alive = await newGrant({ roles: ['site'], permissions: [] });
    const gone = randomUUID();
    const locked = await ctx.db.transaction(
      async (tx) => await ctx.catalog.lockGrants(tx, [gone, alive, alive]),
    );
    expect([...locked.keys()]).toEqual([alive]);
    expect(locked.get(alive)!.code).toContain(PREFIX);
  });
});
