import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * Уборка права `autoParts.stock` из состава наборов — миграция `0247` (план
 * `docs/auto-part-receipts-plan.md`, §5, миграция C; решения Р4б, Р26, Р28; ADR 0154).
 *
 * ЧТО УТВЕРЖДАЕТСЯ. Строка `grant_permissions` с `autoParts.stock` снята; её копия легла в
 * `auto_parts_stock_grant_removed` в той же транзакции; само назначение набора цело (`user_grants`
 * не тронут) и остальные права набора целы — исчезло ровно одно право. Отдельным случаем — набор,
 * состоявший из одного этого права: он становится ПУСТЫМ, и это ожидаемое состояние, которое
 * разбирают руками (пересобирают состав либо удаляют набор), а не дефект миграции.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ — утверждения «держатели доступа не потеряли». Потеряли, и
 * именно `autoParts.stock`: ради этого миграция и написана. Права нет в словаре с выпуска 2
 * «Заморозка», строка в таблице доступа не давала ни дня (`isPermission` отсекает её в
 * `auth/principal.ts`), и убрана она ради каталога — набор с несуществующим правом показывается
 * администратору как дающий больше, чем даёт.
 *
 * ПОЧЕМУ SQL БЕРЁТСЯ ИЗ ФАЙЛА МИГРАЦИИ. Миграция одноразовая: к моменту прогона она уже накатана
 * (её катит `applyMigrations` в `beforeAll`), и второй раз журнал её не пустит — а работа у неё
 * ровно та, которую надо проверить на живых строках. Поэтому тест вырезает из файла ИМЕННО ЕЁ
 * снимок и удаление — по меткам `>>> УБОРКА` / `<<< УБОРКА` — и прогоняет их на своей сцене.
 * Пересказ тех же двух запросов рядом с тестом зеленел бы ровно до первой правки оригинала.
 *
 * БАЗА ОБЯЗАНА БЫТЬ СВОЕЙ, и это не осторожность. Удаление в миграции БЕЗУСЛОВНОЕ (Р4б): оно
 * снимает `autoParts.stock` во всей базе, а не в сцене теста. На общей базе db-тестов файл унёс бы
 * чужие строки и остался бы зелёным.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_apc_test \
 *     npx vitest run test/auto-parts-stock-grant-cleanup.db.test.ts
 *
 * У ПУСТОЙ базы расширения ставятся до первого прогона — `0001_init.sql` их не создаёт нарочно:
 *
 *   psql … -c 'create extension if not exists citext' -c 'create extension if not exists pg_trgm' \
 *          -c 'create extension if not exists pgcrypto' -c 'create extension if not exists btree_gin' \
 *          -c 'create extension if not exists unaccent'
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: коды наборов и email учётки уникальны глобально и живут между прогонами. */
const RUN = randomUUID().slice(0, 8);
const CODE_PREFIX = `test.apc-cleanup.${RUN}`;

/** Право, ради которого всё затевалось: снятое из словаря выпуском 2. */
const STOCK = 'autoParts.stock';

/**
 * Снимок и удаление — тем самым SQL, который поедет в прод.
 *
 * Метки — часть договора с миграцией: переименуют их, и `slice` вернул бы мусор либо пустоту, а
 * файл продолжил бы зеленеть, ничего не проверяя. Поэтому их отсутствие — падение с объяснением.
 */
const CLEANUP_SQL = ((): string => {
  const file = readFileSync(
    new URL('../drizzle/0247_auto_parts_stock_grant_cleanup.sql', import.meta.url),
    'utf8',
  );
  const open = file.indexOf('-- >>> УБОРКА');
  const close = file.indexOf('-- <<< УБОРКА');
  if (open < 0 || close <= open) {
    throw new Error(
      'в миграции 0247 не найден блок между метками «>>> УБОРКА» и «<<< УБОРКА» — ' +
        'тест прогонял бы пустоту вместо снимка и удаления',
    );
  }
  return file.slice(open, close);
})();

interface SceneGrant {
  id: string;
  code: string;
}

interface Ctx {
  client: pg.Client;
  userId: string;
  /** Набор со смешанным составом: право снимается, соседние остаются. */
  mixed: SceneGrant;
  /** Набор из одного `autoParts.stock`: после уборки пустеет. Выдан учётке. */
  only: SceneGrant;
  /** Набор без складского права вовсе: контроль «чужого не тронули». */
  other: SceneGrant;
  /** Набор из одного права, никому не выданный: на нём проверяется архив после удаления набора. */
  gone: SceneGrant;
  /** Сцена случая про откат: заводится ПОСЛЕ уборки, иначе её снял бы тот же безусловный DELETE. */
  rollback: SceneGrant;
}

let ctx: Ctx;

async function makeGrant(
  client: pg.Client,
  suffix: string,
  permissions: readonly string[],
): Promise<SceneGrant> {
  const code = `${CODE_PREFIX}.${suffix}`;
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO grants (code, name) VALUES ($1, $2) RETURNING id',
    [code, `Уборка ${RUN} ${suffix}`],
  );
  const id = rows[0]!.id;
  for (const permission of permissions) {
    await client.query('INSERT INTO grant_permissions (grant_id, permission) VALUES ($1, $2)', [
      id,
      permission,
    ]);
  }
  return { id, code };
}

async function permissionsOf(grantId: string): Promise<string[]> {
  const { rows } = await ctx.client.query<{ permission: string }>(
    'SELECT permission FROM grant_permissions WHERE grant_id = $1 ORDER BY permission',
    [grantId],
  );
  return rows.map((r) => r.permission);
}

beforeAll(async () => {
  if (!DB_URL) return;
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  await applyMigrations(client);

  const { rows: userRows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
     VALUES ($1, 'Складов', 'Пётр', 'x', 'manager', true) RETURNING id`,
    [`apc-cleanup-${RUN}@dev.local`],
  );
  const userId = userRows[0]!.id;

  const mixed = await makeGrant(client, 'mixed', [STOCK, 'autoParts.manage', 'garage.read']);
  const only = await makeGrant(client, 'only', [STOCK]);
  const other = await makeGrant(client, 'other', ['garage.read', 'vehicles.read']);
  const gone = await makeGrant(client, 'gone', [STOCK]);

  for (const grant of [mixed, only, other]) {
    await client.query('INSERT INTO user_grants (user_id, grant_id) VALUES ($1, $2)', [
      userId,
      grant.id,
    ]);
  }

  // Уборка — один раз и по-настоящему, ровно так же, как её выполнит накат: файл целиком внутри
  // одной транзакции (`applyMigrations`), без собственного `BEGIN` в самом SQL.
  await client.query('BEGIN');
  try {
    await client.query(CLEANUP_SQL);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  // Сцена отката заводится ПОСЛЕ уборки: удаление безусловно и сняло бы её заодно со сценой.
  const rollback = await makeGrant(client, 'rollback', [STOCK, 'garage.read']);

  ctx = { client, userId, mixed, only, other, gone, rollback };
}, 120_000);

afterAll(async () => {
  if (!DB_URL || !ctx) return;
  await ctx.client.query('DELETE FROM user_grants WHERE user_id = $1', [ctx.userId]);
  await ctx.client.query('DELETE FROM grants WHERE code LIKE $1', [`${CODE_PREFIX}%`]);
  await ctx.client.query('DELETE FROM auto_parts_stock_grant_removed WHERE grant_code LIKE $1', [
    `${CODE_PREFIX}%`,
  ]);
  await ctx.client.query('DELETE FROM users WHERE id = $1', [ctx.userId]);
  await ctx.client.end();
});

describe.skipIf(!DB_URL)('миграция 0247: уборка autoParts.stock из наборов полномочий', () => {
  it('блок уборки — это снимок И удаление, и своего BEGIN у него нет', () => {
    // Снимок без удаления — уборка, которая ничего не убрала; удаление без снимка — потеря
    // единственной записи о том, что и у кого было снято. Обе ошибки молчаливы.
    expect(CLEANUP_SQL).toContain('INSERT INTO auto_parts_stock_grant_removed');
    expect(CLEANUP_SQL).toContain('DELETE FROM grant_permissions');
    expect(CLEANUP_SQL).toContain(`'${STOCK}'`);
    // Условия у удаления быть не должно (Р4б): «если найдём» делает состав миграции функцией от
    // результата чужого запроса, и накат в деве перестаёт быть накатом на проде.
    expect(CLEANUP_SQL).toMatch(
      /DELETE FROM grant_permissions WHERE permission = 'autoParts\.stock';/,
    );
    // Собственная транзакция внутри файла разорвала бы пару: `applyMigrations` уже держит файл в
    // одной транзакции, а вложенный `COMMIT` дал бы «снято, но не записано» при падении второго
    // запроса.
    expect(CLEANUP_SQL).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
  });

  it('из смешанного набора исчезло ровно одно право, остальные целы', async () => {
    expect(await permissionsOf(ctx.mixed.id)).toEqual(['autoParts.manage', 'garage.read']);
  });

  it('чужой набор без складского права не тронут вовсе', async () => {
    expect(await permissionsOf(ctx.other.id)).toEqual(['garage.read', 'vehicles.read']);
  });

  it('копия снятого легла в архив — с кодом набора и временем', async () => {
    const { rows } = await ctx.client.query<{
      grant_id: string;
      grant_code: string;
      permission: string;
      removed_at: Date | null;
    }>(
      `SELECT grant_id, grant_code, permission, removed_at
         FROM auto_parts_stock_grant_removed
        WHERE grant_code LIKE $1
        ORDER BY grant_code`,
      [`${CODE_PREFIX}%`],
    );
    // Ровно три набора сцены несли право — смешанный, состоявший из него одного и невыданный.
    expect(rows.map((r) => r.grant_code)).toEqual([ctx.gone.code, ctx.mixed.code, ctx.only.code]);
    expect(rows.map((r) => r.permission)).toEqual([STOCK, STOCK, STOCK]);
    expect(rows.map((r) => r.grant_id).sort()).toEqual(
      [ctx.gone.id, ctx.mixed.id, ctx.only.id].sort(),
    );
    for (const row of rows) expect(row.removed_at).toBeInstanceOf(Date);
  });

  it('назначение набора цело: user_grants уборка не трогает', async () => {
    const { rows } = await ctx.client.query<{ grant_id: string }>(
      'SELECT grant_id FROM user_grants WHERE user_id = $1',
      [ctx.userId],
    );
    // Все три выданных набора остались за учёткой — в том числе тот, который уборка опустошила:
    // назначение и состав живут отдельно, и снимать выдачу миграция не вправе.
    expect(rows.map((r) => r.grant_id).sort()).toEqual(
      [ctx.mixed.id, ctx.only.id, ctx.other.id].sort(),
    );
  });

  it('набор из одного этого права опустел — ожидаемое состояние, разбирают его руками', async () => {
    // Пустой набор ничего не даёт и путает в окне учётки: его либо пересобирают осмысленным
    // составом, либо удаляют — и решает это администратор, а не миграция. Само право
    // восстановлению не подлежит: словарь `PERMISSIONS` оно покинуло выпуском 2.
    expect(await permissionsOf(ctx.only.id)).toEqual([]);
    // Набор при этом жив и выдан — по нему и находят, с кем разговаривать.
    const { rows } = await ctx.client.query<{ holders: string }>(
      `SELECT count(ug.id)::text AS holders
         FROM grants g LEFT JOIN user_grants ug ON ug.grant_id = g.id
        WHERE g.id = $1 AND g.deleted_at IS NULL
        GROUP BY g.id`,
      [ctx.only.id],
    );
    expect(rows[0]?.holders).toBe('1');
  });

  it('архив читается и после того, как опустевший набор удалили', async () => {
    // Ради этого у `grant_id` нет FK: каскад унёс бы снимок вместе с набором, а RESTRICT запретил
    // бы саму починку вперёд — «удалить пустой набор».
    await ctx.client.query('DELETE FROM grants WHERE id = $1', [ctx.gone.id]);
    const { rows } = await ctx.client.query<{ grant_code: string }>(
      'SELECT grant_code FROM auto_parts_stock_grant_removed WHERE grant_id = $1',
      [ctx.gone.id],
    );
    expect(rows.map((r) => r.grant_code)).toEqual([ctx.gone.code]);
  });

  it('снимок и удаление откатываются вместе — это одна транзакция, а не две', async () => {
    await ctx.client.query('BEGIN');
    try {
      await ctx.client.query(CLEANUP_SQL);
      // Внутри транзакции работа видна: сцена отката потеряла право, копия лежит в архиве.
      expect(await permissionsOf(ctx.rollback.id)).toEqual(['garage.read']);
    } finally {
      // Откат в `finally`, а не строкой ниже: падение сравнения оставило бы соединение в открытой
      // транзакции, и уборка `afterAll` ушла бы вместе с ней — сцена осталась бы в базе, а сам
      // файл при следующем прогоне жаловался бы на чужой мусор. Ловилось мутацией миграции.
      await ctx.client.query('ROLLBACK');
    }

    // После отката не осталось ни половины: собственный COMMIT между запросами оставил бы здесь
    // либо снятое право без снимка, либо снимок без снятия.
    expect(await permissionsOf(ctx.rollback.id)).toEqual([STOCK, 'garage.read']);
    const { rows } = await ctx.client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM auto_parts_stock_grant_removed WHERE grant_id = $1',
      [ctx.rollback.id],
    );
    expect(rows[0]?.count).toBe('0');
  });
});
