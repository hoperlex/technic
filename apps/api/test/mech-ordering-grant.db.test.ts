import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GRANT_ORIGINS,
  MAX_ASSIGNED_GRANTS,
  ROLE_GRANTS,
  ROLE_MIGRATIONS,
} from '@technic/contracts';
import { applyMigrations, readMigration } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';

/**
 * Посев набора «Заказ механизации» (миграция `0290`, план
 * `docs/mechanization-approval-and-grants-plan.md`, Р7/Р9, этап Э2; ADR 0175).
 *
 * **Зачем этому файлу база.** Проверяется не правило и не DTO, а обещание ВЫКАТА: тем же релизом
 * модуль снимается с роли `site` в матрице, и единственное, что удерживает доступ живых площадок, —
 * строки, которые пишет эта миграция. Ошибка здесь не роняет ни один запрос и не видна в списке:
 * площадка просто перестаёт видеть раздел «Механизация» на следующее утро.
 *
 * Три обещания, и каждое проверяется на СВОИХ учётках, заведённых ДО повторного наката:
 *
 * 1. **действующему `site` — действующий набор** с происхождением `backfill`, без автора и без
 *    ссылки на перевод. Выключенная и удалённая учётки — тоже: их включают обратно, и вернуться
 *    они обязаны с тем же доступом (Р9, «без фильтра по `is_active` и `deleted_at`»);
 * 2. **снимку этапа 8 — взведённый**: `origin = 'migration'` и ссылка на снимок. До перевода он
 *    прав не даёт, и в этом весь смысл — модуль этим держателям пока даёт роль;
 * 3. **повторный накат ничего не портит**: миграция идёт по восстановленной из копии базе так же,
 *    как по свежей, — иначе её нельзя катить дважды, а именно это и делает выкат из бэкапа.
 *
 * Отдельно проверяется, что число предела в SQL — то же, что в контрактах: preflight миграции
 * считает будущий максимум назначений против `MAX_ASSIGNED_GRANTS`, и разъехавшись, две копии
 * дали бы молчаливое расхождение — выкат прошёл бы, а форма учётки перестала бы сохраняться.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/mech-ordering-grant.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const MIGRATION = '0290_mech_ordering_grant.sql';
const CODE = 'mech_ordering';

/** Свои учётки файла: база db-тестов общая, и всё здешнее опознаётся по этому префиксу. */
const PREFIX = 'db-mech-ordering';

/*
 * Хвост прогона в адресе: уникальность почты держит частичный индекс, и `ON CONFLICT (email)` он
 * не обслуживает. Оборвавшийся прогон оставил бы занятые адреса, а свои строки файл всё равно
 * убирает по префиксу — вместе с хвостами прошлых прогонов.
 */
const RUN = randomUUID().slice(0, 8);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
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

/** Учётка файла: роль и состояние задаются случаем — их и проверяет посев. */
async function seedUser(
  tag: string,
  role: string,
  extra: { isActive?: boolean; deletedAt?: Date } = {},
): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active, deleted_at)
    VALUES (${`${PREFIX}-${RUN}-${tag}@example.invalid`}, 'Тестовый', 'Посев', ${tag},
            'db-test-not-a-hash', ${role}::role, ${extra.isActive ?? true},
            ${extra.deletedAt ? extra.deletedAt.toISOString() : null})
    RETURNING id`);
  return rows.rows[0]!.id;
}

/** Снимок перевода этапа 8 — тот же, что заводит миграция 0155 живым площадочным ролям. */
async function seedSnapshot(userId: string, roleBefore: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO user_role_migration (user_id, stage, role_before, role_after)
    VALUES (${userId}, 8, ${roleBefore}::role, 'site'::role)
    ON CONFLICT (user_id, stage) DO NOTHING`);
}

/** Назначение набора у учётки: происхождение и ссылка на перевод — то, ради чего файл написан. */
async function grantOf(
  userId: string,
): Promise<{ origin: string; granted_by: string | null; migration_id: string | null } | undefined> {
  const rows = await ctx.db.execute<{
    origin: string;
    granted_by: string | null;
    migration_id: string | null;
  }>(sql`
    SELECT ug.origin, ug.granted_by, ug.migration_id
    FROM user_grants ug
    JOIN grants g ON g.id = ug.grant_id
    WHERE ug.user_id = ${userId} AND g.code = ${CODE}`);
  return rows.rows[0];
}

describe.skipIf(!DB_URL)('посев набора «Заказ механизации» (живая схема)', () => {
  const users: Record<string, string> = {};

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    ctx = { db, closeDb };

    // Учётки заводятся ПОСЛЕ первого наката и до повторного: миграция уже применена к базе, и
    // сеять ей эти строки придётся вторым проходом — то есть ровно тем, который и проверяется.
    users.site = await seedUser('site', 'site');
    users.siteOff = await seedUser('site-off', 'site', { isActive: false });
    users.siteGone = await seedUser('site-gone', 'site', { deletedAt: new Date() });
    users.shtab = await seedUser('shtab', 'shtab');
    users.commandant = await seedUser('commandant', 'commandant');
    users.manager = await seedUser('manager', 'manager');
    await seedSnapshot(users.shtab!, 'shtab');
    await seedSnapshot(users.commandant!, 'commandant');

    // Повторный накат — той же миграцией, руками: журнал её уже помнит, а нам нужен второй проход
    // по новым строкам. Он же проверяет идемпотентность (`ON CONFLICT DO NOTHING`) на строках,
    // которые первый проход уже завёл.
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await client.query(readMigration(MIGRATION));
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (!ctx?.db) return;
      // Уборка за собой: база общая. Назначения уходят раньше учёток — ключ `RESTRICT` на наборе
      // держит только сам набор, а строки снимков и выдач висят на учётке каскадом.
      await ctx.db.execute(sql`
        DELETE FROM user_grants WHERE user_id IN (
          SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%`})`);
      await ctx.db.execute(sql`
        DELETE FROM user_role_migration WHERE user_id IN (
          SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%`})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}-%`}`);
    } finally {
      await ctx?.closeDb();
    }
  }, 60_000);

  it('каталог несёт набор ровно того состава, что объявлен контрактами', async () => {
    const rows = await ctx.db.execute<{ permission: string }>(sql`
      SELECT gp.permission
      FROM grants g JOIN grant_permissions gp ON gp.grant_id = g.id
      WHERE g.code = ${CODE} ORDER BY gp.permission`);
    expect(rows.rows.map((r) => r.permission)).toEqual(
      [...ROLE_GRANTS.mech_ordering.permissions].sort(),
    );

    // Совместимая роль одна и целевая: упраздняемым ролям набор не назначается впредь, он приезжает
    // им взведённым (Р7).
    const roles = await ctx.db.execute<{ role: string }>(sql`
      SELECT gr.role FROM grants g JOIN grant_roles gr ON gr.grant_id = g.id
      WHERE g.code = ${CODE}`);
    expect(roles.rows.map((r) => r.role)).toEqual(['site']);
  });

  it('действующему «site» набор достаётся действующим — включая выключенных и удалённых', async () => {
    for (const key of ['site', 'siteOff', 'siteGone']) {
      const row = await grantOf(users[key]!);
      expect(row, key).toBeTruthy();
      // `backfill`, а не `manual`: выдачи не было — не было и того, кто её сделал. И не
      // `migration`: та запирается формой как часть подготовленного перевода, а эту снимают
      // галочкой наравне с ручной.
      expect(row!.origin, key).toBe('backfill');
      expect(row!.granted_by, key).toBeNull();
      expect(row!.migration_id, key).toBeNull();
    }
  });

  it('снимку этапа 8 набор достаётся взведённым — со ссылкой на перевод', async () => {
    for (const key of ['shtab', 'commandant']) {
      const row = await grantOf(users[key]!);
      expect(row, key).toBeTruthy();
      expect(row!.origin, key).toBe('migration');
      // Ссылка обязательна: без неё откат перевода назначение не найдёт, и CHECK происхождения
      // такую строку не примет вовсе.
      expect(row!.migration_id, key).toBeTruthy();
    }
    // Комендант получает набор наравне с прочей площадкой (Р8): до плана визы его строка перевода
    // была пустой, и молчаливая потеря модуля при переводе — ровно то, ради чего она заведена.
    expect(ROLE_MIGRATIONS.find((m) => m.from === 'commandant')?.grants).toContain(CODE);
  });

  it('роли, которой набор не положен, он и не достаётся', async () => {
    expect(await grantOf(users.manager!)).toBeUndefined();
  });

  it('предел назначений в SQL — тот же, что в контрактах', () => {
    const text = readMigration(MIGRATION);
    // Число написано в SQL руками: миграция не умеет спрашивать TypeScript. Разъехавшись с
    // константой, копии дали бы выкат, после которого форма учётки перестаёт сохраняться, — и
    // узналось бы это от администратора, а не от прогона.
    expect(text).toContain(`+ 1 > ${MAX_ASSIGNED_GRANTS}`);
    expect(text).toContain(`MAX_ASSIGNED_GRANTS = ${MAX_ASSIGNED_GRANTS}`);
  });

  it('третье происхождение принято базой и объявлено контрактами', async () => {
    expect(GRANT_ORIGINS).toContain('backfill');
    /*
     * CHECK читается из самой базы, а не проверяется отказом на вставке: у отказа имя ограничения
     * лежит в поле драйвера, а не в тексте, и утверждение о нём легко выродилось бы в «любая
     * вставка падает». Определение же говорит ровно то, что нужно: значений три, и ослабления
     * дальше не случилось.
     */
    const rows = await ctx.db.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'user_grants_origin_check'`);
    const def = rows.rows[0]?.def ?? '';
    for (const origin of GRANT_ORIGINS) expect(def, origin).toContain(`'${origin}'`);
    // Ровно перечень контрактов: лишнее значение означало бы, что база принимает происхождение,
    // о котором портал не знает и подписи для которого нет.
    expect(def.match(/'[a-z]+'/g)?.length).toBe(GRANT_ORIGINS.length);
  });
});
