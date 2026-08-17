import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_ADDON_BASE_ROLES, ROLE_MIGRATIONS, SYSTEM_GRANT_CODES } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * Снимок перевода ролей и взведённые заранее назначения — шаг prepare этапов 8 и 9 (миграции
 * 0154–0156, ADR 0113): база против объявленной таблицы перевода.
 *
 * **Что здесь охраняется.** Соответствие «прежняя роль → наборы» существует в двух копиях: в
 * контрактах (`ROLE_MIGRATIONS`) и в миграциях, которые переписывают его руками строками `VALUES` —
 * миграция не умеет спрашивать TypeScript. Разъедься копии, и перевод выдаст не тот набор не тем
 * людям; тесты контрактов этого не увидят, потому что смотрят в другую копию.
 *
 * **Чего здесь НЕТ и почему.** Проверки «у каждой учётки со старой ролью есть снимок» тут быть не
 * может: тестовая база общая, соседние db-тесты заводят свои учётки с ролью `shtab` **после** того,
 * как миграции накатились, и снимка у них нет по построению — миграция отработала до их появления.
 * Полнота — вопрос выката, и отвечает на него сверка на живых данных
 * (`pnpm --filter @technic/api check:role-migration`), которая печатает такие учётки поимённо и
 * возвращает ненулевой код. Здесь же проверяется то, что от чужих учёток не зависит: устройство
 * снимка, согласованность каждой существующей строки и барьеры схемы.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/role-migration-prepare.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

let client: pg.Client;

/** Учётка-зонд: заводится своей и удаляется за собой — общей базе она ничего не оставляет. */
const PROBE_EMAIL = 'role-migration-probe@example.invalid';
let probeUserId = '';

async function probeSnapshot(stage: number): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO user_role_migration (user_id, stage, role_before, role_after)
     VALUES ($1, $2, 'shtab', 'site') RETURNING id`,
    [probeUserId, stage],
  );
  return rows[0]!.id;
}

describe.skipIf(!DB_URL)('шаг prepare перевода ролей: база против таблицы перевода', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
       VALUES ($1, 'Зондов', 'Зонд', 'x', 'observer', false) RETURNING id`,
      [PROBE_EMAIL],
    );
    probeUserId = rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    if (client && probeUserId) {
      await client.query('DELETE FROM users WHERE id = $1', [probeUserId]);
    }
    await client?.end();
  });

  /**
   * Каждая существующая строка снимка обязана соответствовать объявленному переводу: этап, роль до
   * и роль после. Строка с чужой парой ролей означает, что миграция посеяла перевод, которого в
   * контрактах нет, — а именно по контрактам будет считаться откат.
   */
  it('каждый снимок описывает объявленный перевод', async () => {
    const { rows } = await client.query<{
      stage: number;
      role_before: string;
      role_after: string;
      count: string;
    }>(
      `SELECT stage, role_before, role_after, count(*) AS count
         FROM user_role_migration
        GROUP BY stage, role_before, role_after`,
    );
    for (const row of rows) {
      const declared = ROLE_MIGRATIONS.find((m) => m.from === row.role_before);
      expect(
        declared,
        `снимок «${row.role_before}» — такого перевода в контрактах нет`,
      ).toBeTruthy();
      expect(row.role_after, `перевод «${row.role_before}»`).toBe(declared!.to);
      expect(row.stage, `перевод «${row.role_before}»`).toBe(declared!.stage);
    }
  });

  /**
   * Назначения, созданные переводом, — ровно те наборы, что объявлены, и ни одним больше. Лишний
   * набор здесь это доступ, которого никто не выдавал; недостающий — права, которые перевод
   * отберёт.
   */
  it('взведённые назначения совпадают с объявленными наборами', async () => {
    const { rows } = await client.query<{ role_before: string; codes: string[] }>(
      `SELECT m.role_before, coalesce(array_agg(g.code ORDER BY g.code), '{}') AS codes
         FROM user_role_migration m
         LEFT JOIN user_grants ug ON ug.migration_id = m.id
         LEFT JOIN grants g ON g.id = ug.grant_id
        GROUP BY m.id, m.role_before`,
    );
    for (const row of rows) {
      const declared = ROLE_MIGRATIONS.find((m) => m.from === row.role_before)!;
      expect(row.codes.filter(Boolean).sort(), `перевод «${row.role_before}»`).toEqual(
        [...declared.grants].sort(),
      );
    }
  });

  /** Происхождение у всех созданных переводом назначений одно: `migration`, и только оно. */
  it('назначения перевода помечены происхождением, а выданные руками — нет', async () => {
    const { rows } = await client.query<{ origin: string; with_migration: string; total: string }>(
      `SELECT origin,
              count(*) FILTER (WHERE migration_id IS NOT NULL) AS with_migration,
              count(*) AS total
         FROM user_grants
        GROUP BY origin`,
    );
    for (const row of rows) {
      const expected = row.origin === 'migration' ? row.total : '0';
      expect(row.with_migration, `origin = ${row.origin}`).toBe(expected);
    }
  });

  /**
   * Граница, найденная на этапе 4б: оба перенесённых из надстроек набора обязаны принимать целевую
   * роль перевода. Страж каталога сверяет `grant_roles` с `ROLE_ADDON_BASE_ROLES`, но не отвечает
   * на вопрос «а переживёт ли надстройка перевод» — здесь он задан прямо.
   */
  it('наборы оргтехники принимают целевые роли перевода', async () => {
    for (const code of SYSTEM_GRANT_CODES) {
      const { rows } = await client.query<{ role: string }>(
        `SELECT gr.role FROM grant_roles gr JOIN grants g ON g.id = gr.grant_id WHERE g.code = $1`,
        [code],
      );
      const inDb = rows.map((r) => r.role);
      for (const role of ROLE_ADDON_BASE_ROLES[code]) {
        const migration = ROLE_MIGRATIONS.find((m) => m.from === role);
        if (!migration) continue;
        expect(inDb, `набор «${code}»: после перевода «${role}» надстройка погаснет`).toContain(
          migration.to,
        );
      }
    }
  });

  /**
   * CHECK согласованности: «выдано переводом» и «известно, каким переводом» — одно утверждение.
   * Половина без второй означала бы назначение, которого откат не найдёт, либо снятие руками
   * выданного.
   */
  it('происхождение и ссылка на снимок не расходятся', async () => {
    const snapshotId = await probeSnapshot(801);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM grants WHERE code = 'vehicle_ordering'`,
    );
    const grantId = rows[0]!.id;
    await expect(
      client.query(
        `INSERT INTO user_grants (user_id, grant_id, origin) VALUES ($1, $2, 'migration')`,
        [probeUserId, grantId],
      ),
    ).rejects.toThrow(/user_grants_migration_origin_check/);
    await expect(
      client.query(
        `INSERT INTO user_grants (user_id, grant_id, origin, migration_id) VALUES ($1, $2, 'manual', $3)`,
        [probeUserId, grantId, snapshotId],
      ),
    ).rejects.toThrow(/user_grants_migration_origin_check/);
    await client.query('DELETE FROM user_role_migration WHERE id = $1', [snapshotId]);
  });

  /**
   * Снимок нельзя убрать, пока на него ссылаются назначения: откат перевода сначала снимает свои
   * строки и только потом убирает снимок — иначе он потерял бы список того, что снимает.
   */
  it('снимок держится назначениями, а вместе с учёткой уходит целиком', async () => {
    const snapshotId = await probeSnapshot(802);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM grants WHERE code = 'vehicle_ordering'`,
    );
    await client.query(
      `INSERT INTO user_grants (user_id, grant_id, origin, migration_id) VALUES ($1, $2, 'migration', $3)`,
      [probeUserId, rows[0]!.id, snapshotId],
    );
    await expect(
      client.query('DELETE FROM user_role_migration WHERE id = $1', [snapshotId]),
    ).rejects.toThrow(/user_grants_migration_fk/);

    // А удаление учётки сносит обе стороны одним оператором — ради этого ключ и объявлен
    // `NO ACTION`, а не `RESTRICT`: немедленная проверка упала бы на полпути каскада.
    await client.query('DELETE FROM users WHERE id = $1', [probeUserId]);
    const left = await client.query('SELECT 1 FROM user_role_migration WHERE id = $1', [
      snapshotId,
    ]);
    expect(left.rowCount).toBe(0);
    const { rows: again } = await client.query<{ id: string }>(
      `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
       VALUES ($1, 'Зондов', 'Зонд', 'x', 'observer', false) RETURNING id`,
      [PROBE_EMAIL],
    );
    probeUserId = again[0]!.id;
  });

  /** Один снимок на учётку и этап: повторный накат prepare безвреден, второго снимка не бывает. */
  it('второй снимок того же этапа не заводится', async () => {
    const snapshotId = await probeSnapshot(803);
    await expect(probeSnapshot(803)).rejects.toThrow(/user_role_migration_user_stage_unique/);
    await client.query('DELETE FROM user_role_migration WHERE id = $1', [snapshotId]);
  });
});
