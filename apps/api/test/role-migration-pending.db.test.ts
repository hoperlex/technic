import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARCHIVED_ROLE_LABELS,
  ROLE_ADDON_BASE_ROLES,
  ROLE_MIGRATIONS,
  roleLabels,
  SYSTEM_GRANT_CODES,
  type Role,
} from '@technic/contracts';
import { applyMigrations, migrationsDir, readMigration } from '../src/db/migration-journal';

/**
 * Подготовленный, но не выкаченный SQL перевода ролей — шаги `migrate` и `cleanup` этапов 8 и 9 и
 * шаг 1e (`apps/api/drizzle/pending/`, план реструктуризации §13.2 и §15; ADR 0113).
 *
 * **Зачем тест на то, что ещё не едет.** Между написанием этих файлов и их выкатом пройдёт
 * несколько релизов, за которые изменятся и снимок, и каталог наборов, и сам перечень ролей.
 * Файл, пролежавший всё это время непрогнанным, к своему релизу окажется написан под прошлую
 * схему — и обнаружится это в проде, на живых учётках, посреди деплоя. Прогон здесь превращает
 * подготовленный SQL в проверяемое утверждение, а не в заготовку.
 *
 * **Своя временная база, и это требование, а не аккуратность.** Общая `technic_archive_test`
 * обслуживает соседние db-тесты; здешние запросы переводят роли **всем** учёткам площадки и
 * удаляют строки `grant_roles` — на общей базе это снесло бы чужие фикстуры, а предохранители,
 * которые ловят «остался держатель старой роли», срабатывали бы от чужих учёток. Поэтому база
 * создаётся своя, наполняется накатом всех миграций и удаляется за собой. `TEST_DATABASE_URL`
 * нужен только как адрес сервера и учётные данные — имя базы из него не используется.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/role-migration-pending.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
/** Имя своё и говорящее: базу видно в `\l` соседа, и по имени должно быть ясно, чья она и зачем. */
const SCRATCH_DB = 'technic_role_migration_pending_test';

let client: pg.Client;
let adminClient: pg.Client;

function urlFor(database: string): string {
  const url = new URL(DB_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Подготовленный файл читается с диска — тест обязан гонять тот SQL, который поедет. */
function readPending(name: string): string {
  return readFileSync(join(migrationsDir, 'pending', name), 'utf8');
}

/**
 * Прогон подготовленного файла ровно так, как его прогонит мигратор: один файл — одна транзакция,
 * ошибка внутри откатывает весь файл (`applyMigrations`). Без этого предохранитель, стоящий после
 * `UPDATE`, выглядел бы в тесте безобидным: перевод остался бы применённым.
 */
async function runPending(name: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(readPending(name));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function newUser(email: string, role: Role): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
     VALUES ($1, 'Тестов', 'Тест', 'x', $2, true) RETURNING id`,
    [email, role],
  );
  return rows[0]!.id;
}

async function userState(id: string): Promise<{ role: string; authVersion: number }> {
  const { rows } = await client.query<{ role: string; auth_version: number }>(
    'SELECT role::text AS role, auth_version FROM users WHERE id = $1',
    [id],
  );
  return { role: rows[0]!.role, authVersion: rows[0]!.auth_version };
}

async function migratedAt(userId: string, stage: number): Promise<string | null> {
  const { rows } = await client.query<{ migrated_at: string | null }>(
    'SELECT migrated_at FROM user_role_migration WHERE user_id = $1 AND stage = $2',
    [userId, stage],
  );
  return rows[0]?.migrated_at ?? null;
}

async function rolesOfGrant(code: string): Promise<string[]> {
  const { rows } = await client.query<{ role: string }>(
    `SELECT gr.role::text AS role FROM grant_roles gr
       JOIN grants g ON g.id = gr.grant_id
      WHERE g.code = $1 ORDER BY 1`,
    [code],
  );
  return rows.map((r) => r.role);
}

/** Коды наборов, выданных учётке, — то, что взвёл prepare и чем перевод сохраняет права. */
async function grantCodesOf(userId: string): Promise<string[]> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT g.code FROM user_grants ug JOIN grants g ON g.id = ug.grant_id
      WHERE ug.user_id = $1 ORDER BY 1`,
    [userId],
  );
  return rows.map((r) => r.code);
}

/** Идентификаторы участников: заводятся один раз, разбираются по сценариям ниже. */
const ids: Record<string, string> = {};

describe.skipIf(!DB_URL)('подготовленный SQL перевода ролей на своей временной базе', () => {
  beforeAll(async () => {
    adminClient = new pg.Client({ connectionString: urlFor('postgres') });
    await adminClient.connect();
    // Уборка за упавшим прошлым прогоном: база могла остаться, и накат миграций на неё дал бы
    // «уже существует» вместо внятного отказа.
    await adminClient.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE ${SCRATCH_DB}`);

    client = new pg.Client({ connectionString: urlFor(SCRATCH_DB) });
    await client.connect();
    // Расширения включает ops до миграций (§8): `0001_init` их не создаёт и рассчитывает на готовые.
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await applyMigrations(client);

    // Держатели упраздняемых ролей — как если бы они существовали до наката prepare.
    ids.shtab = await newUser('pending-shtab@example.invalid', 'shtab');
    ids.rukstroy = await newUser('pending-rukstroy@example.invalid', 'rukstroy');
    ids.commandant = await newUser('pending-commandant@example.invalid', 'commandant');
    ids.head = await newUser('pending-head@example.invalid', 'department_head');
    // Учётка, которой роль сменят руками между prepare и migrate: снимок у неё будет, перевод её
    // обязан пропустить.
    ids.handChanged = await newUser('pending-hand-changed@example.invalid', 'shtab');

    // Набор, собранный администратором под упраздняемую роль, — та самая беда §13.2, ради которой
    // prepare дописывает целевую роль рядом, а cleanup снимает старую.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO grants (code, name, is_system) VALUES ('pending_custom', 'Набор под штаб', false)
       RETURNING id`,
    );
    await client.query(
      `INSERT INTO grant_roles (grant_id, role) VALUES ($1, 'shtab'), ($1, 'department_head')`,
      [rows[0]!.id],
    );

    // Посевные запросы prepare прогоняются ПОВТОРНО — учётки заведены уже после наката. Это же и
    // есть лечение, которое runbook назначает при «снимка нет»: файлы идемпотентны.
    await client.query(readMigration('0155_site_role_prepare.sql'));
    await client.query(readMigration('0156_department_role_prepare.sql'));

    await client.query(`UPDATE users SET role = 'observer' WHERE id = $1`, [ids.handChanged]);
  }, 300_000);

  afterAll(async () => {
    await client?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await adminClient.end();
    }
  });

  it('prepare взвёл наборы и дописал целевые роли пользовательскому набору', async () => {
    expect(await grantCodesOf(ids.shtab)).toEqual(['vehicle_ordering']);
    expect(await grantCodesOf(ids.rukstroy)).toEqual(['site_approval', 'vehicle_ordering']);
    expect(await grantCodesOf(ids.commandant)).toEqual([]);
    expect(await grantCodesOf(ids.head)).toEqual(['department_approval']);
    // Аддитивная половина: обе роли стоят рядом, и до вычитания набор действует по любой из них.
    expect(await rolesOfGrant('pending_custom')).toEqual([
      'department',
      'department_head',
      'shtab',
      'site',
    ]);
  });

  it('migrate этапа 8 падает, пока есть держатель без снимка, и не переводит никого', async () => {
    const straggler = await newUser('pending-no-snapshot@example.invalid', 'shtab');
    await expect(runPending('stage8-migrate-site-role.sql')).rejects.toThrow(
      /Перевод этапа 8 не полон/,
    );
    // Предохранитель стоит после `UPDATE`, поэтому важно именно это: файл откатился целиком.
    expect((await userState(ids.shtab)).role).toBe('shtab');
    expect(await migratedAt(ids.shtab, 8)).toBeNull();
    await client.query('DELETE FROM users WHERE id = $1', [straggler]);
  });

  it('migrate этапа 8 переводит по снимку, метит снимок и гасит токены', async () => {
    const before = await userState(ids.shtab);
    await runPending('stage8-migrate-site-role.sql');

    for (const key of ['shtab', 'rukstroy', 'commandant']) {
      expect((await userState(ids[key]!)).role).toBe('site');
      expect(await migratedAt(ids[key]!, 8)).not.toBeNull();
    }
    expect((await userState(ids.shtab)).authVersion).toBe(before.authVersion + 1);
    // Наборы, взведённые prepare, остались на месте: перевод их не пересоздаёт и не отзывает.
    expect(await grantCodesOf(ids.rukstroy)).toEqual(['site_approval', 'vehicle_ordering']);
  });

  it('учётку, которой роль сменили руками, перевод пропускает и в снимке не метит', async () => {
    expect((await userState(ids.handChanged)).role).toBe('observer');
    expect(await migratedAt(ids.handChanged, 8)).toBeNull();
  });

  it('этап 9 переводится своим файлом и этапа 8 не касается', async () => {
    const before = await userState(ids.head);
    await runPending('stage9-migrate-department-role.sql');
    expect((await userState(ids.head)).role).toBe('department');
    expect((await userState(ids.head)).authVersion).toBe(before.authVersion + 1);
    expect(await migratedAt(ids.head, 9)).not.toBeNull();
  });

  it('повторный накат migrate ничего не меняет: версия токенов и метка на месте', async () => {
    const before = await userState(ids.shtab);
    const stamped = await migratedAt(ids.shtab, 8);
    await runPending('stage8-migrate-site-role.sql');
    await runPending('stage9-migrate-department-role.sql');
    expect(await userState(ids.shtab)).toEqual(before);
    expect(await migratedAt(ids.shtab, 8)).toEqual(stamped);
  });

  it('cleanup падает, пока держатель упраздняемой роли есть, и строк не трогает', async () => {
    const holder = await newUser('pending-late-holder@example.invalid', 'commandant');
    await expect(runPending('stage8-cleanup-site-role.sql')).rejects.toThrow(
      /Упразднение ролей этапа 8 невозможно/,
    );
    expect(await rolesOfGrant('pending_custom')).toContain('shtab');
    await client.query('DELETE FROM users WHERE id = $1', [holder]);
  });

  it('cleanup снимает старые роли из grant_roles, целевые оставляет', async () => {
    await runPending('stage8-cleanup-site-role.sql');
    await runPending('stage9-cleanup-department-role.sql');
    expect(await rolesOfGrant('pending_custom')).toEqual(['department', 'site']);
    // Снимок переживает cleanup: значение enum остаётся в типе мёртвым как раз ради него.
    const { rows } = await client.query<{ role_before: string }>(
      `SELECT role_before::text AS role_before FROM user_role_migration WHERE user_id = $1`,
      [ids.shtab],
    );
    expect(rows[0]!.role_before).toBe('shtab');
  });

  it('cleanup и ROLE_ADDON_BASE_ROLES — две половины одного релиза', async () => {
    // Пока обе половины не выехали, база и константа расходятся ровно на упраздняемые роли; сверяет
    // их построчно `grants-catalog.db.test.ts`, и правка одной половины без второй его красит.
    const retiring = new Set<string>(ROLE_MIGRATIONS.map((m) => m.from));
    for (const code of SYSTEM_GRANT_CODES) {
      const expected = ROLE_ADDON_BASE_ROLES[code].filter((role) => !retiring.has(role));
      expect(await rolesOfGrant(code)).toEqual([...expected].sort());
    }
  });

  it('шаг 1e убирает таблицу надстроек вместе с её типом', async () => {
    await runPending('step1e-drop-user-role-addons.sql');
    const { rows } = await client.query<{
      table_exists: string | null;
      type_exists: string | null;
    }>(
      `SELECT to_regclass('public.user_role_addons')::text AS table_exists,
              to_regtype('public.role_addon')::text  AS type_exists`,
    );
    expect(rows[0]!.table_exists).toBeNull();
    expect(rows[0]!.type_exists).toBeNull();
  });

  it('подпись есть у каждого значения enum роли, а не только у действующей роли', async () => {
    // Требование §13.2: роль записана задним числом в `audit_log.metadata` и в текстах писем, и
    // упразднение обязано оставить подпись в коде. Страж покраснеет на cleanup'е, который убрал
    // роль из `ROLES`, но забыл перенести подпись в `ARCHIVED_ROLE_LABELS`.
    const { rows } = await client.query<{ value: string }>(
      `SELECT e.enumlabel AS value FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'role' ORDER BY e.enumsortorder`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows
      .map((r) => r.value)
      .filter((value) => !(value in roleLabels) && !(value in ARCHIVED_ROLE_LABELS));
    expect(missing).toEqual([]);
  });
});
