import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения модуля берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { assertStockFrozenEmpty as AssertStockFrozenEmpty } from '../src/db/stock-frozen';

/**
 * Барьер пустоты склада автозапчастей (план `docs/auto-part-receipts-plan.md`, Р24, Р25;
 * `src/db/stock-frozen.ts`).
 *
 * ЗАЧЕМ БАЗА. Проверяемое утверждение целиком про базу: «в этих четырёх таблицах нет строк». На
 * моках оно не проверяется вовсе — там сходятся имена, которые сам же тест и написал. А ошибиться
 * здесь можно ровно двумя способами, и оба молчаливы: посчитать не ту таблицу (опечатка в списке —
 * и барьер не смотрит на неё никогда) и посчитать не так (`count(*)` возвращает `bigint`, то есть
 * строку; `Number('0')` — ноль, а вот `'0' > 0` — ложь при любом содержимом, и барьер пропустил бы
 * непустой склад молча).
 *
 * УСТРОЙСТВО ФАЙЛА — ДВА КОНТУРА, И ЭТО НЕ ДУБЛИРОВАНИЕ:
 *
 *   1. НАСТОЯЩИЕ ТАБЛИЦЫ отвечают за имена и за сам факт исполнимости запроса: список сверяется с
 *      каталогом (`to_regclass`), пустая база проходит барьер, а одна законно заведённая карточка
 *      (`auto_parts` с нулевым остатком — единственная строка склада, которую можно завести и
 *      убрать, не трогая неудаляемый журнал) его роняет;
 *   2. ТЕНЕВЫЕ ТАБЛИЦЫ в своей схеме (`search_path`) отвечают за поведение по КАЖДОЙ из четырёх:
 *      завести законную строку в журнале движения или в строке акта стоит машины, показаний и
 *      акта, а стереть её потом нельзя вовсе — `auto_part_stock_immutable` не пропускает `DELETE`
 *      (Р25). Тень даёт то же самое имя таблицы с той же непустотой и ничего не оставляет после
 *      себя.
 *
 * БАЗА ОБЯЗАНА БЫТЬ ЧИСТОЙ. Файл утверждает «пустой склад проходит», и на общей базе db-тестов это
 * утверждение неверно: там лежат складские строки, оставленные прежними прогонами (сам набор
 * `auto-parts.db.test.ts` уехал вместе со складом этим же выпуском, а его данные — нет: журнал
 * неизменяем и не убирается за собой, Р25). Поэтому пустота проверяется в
 * `beforeAll` и объясняется словами: иначе падение выглядело бы поломкой барьера, а не выбором
 * не той базы.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_stock_frozen_test \
 *     npx vitest run test/stock-frozen.db.test.ts
 *
 * У ПУСТОЙ базы расширения ставятся до первого прогона — `0001_init.sql` их не создаёт нарочно:
 *
 *   psql … -c 'create extension if not exists citext' \
 *          -c 'create extension if not exists pg_trgm' \
 *          -c 'create extension if not exists pgcrypto'
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Своя схема на прогон: файл переживает повторный запуск на той же базе. */
const SHADOW_SCHEMA = `stock_frozen_${randomUUID().slice(0, 8)}`;

/**
 * Имена таблиц выписаны здесь ЗАНОВО, а не взяты из модуля: тень, построенная по списку барьера,
 * сошлась бы с ним при любой опечатке в нём. Настоящая схема сверяется отдельным случаем.
 */
const SHADOW_TABLES = [
  'auto_parts',
  'auto_part_applicability',
  'auto_part_stock_entries',
  'vehicle_maintenance_parts',
] as const;

/** Наименование карточки, заводимой в настоящую таблицу: по нему же идёт уборка. */
const REAL_PART_NAME = `ЗАМОРОЗКА-ТЕСТ ${randomUUID().slice(0, 8)}`;

interface Ctx {
  /** Настоящие таблицы: `search_path` по умолчанию. */
  real: pg.Client;
  /** Теневые таблицы: у этого соединения `search_path` смотрит в схему прогона. */
  shadow: pg.Client;
  /** Схема без единой таблицы склада: на ней проверяется несчитаемый счёт. */
  blind: pg.Client;
  assertStockFrozenEmpty: typeof AssertStockFrozenEmpty;
  tables: readonly string[];
  logger: { warn: (...args: unknown[]) => void };
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PUBLIC_KEY_PEM ??= '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function connect(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

beforeAll(async () => {
  if (!DB_URL) return;
  prepareEnv(DB_URL);

  const real = await connect(DB_URL);
  await applyMigrations(real);

  // Пустота настоящих таблиц — предпосылка файла, а не его случай: сказать об этом надо ДО
  // прогона и своими словами.
  const { rows } = await real.query<{ table_name: string; row_count: string }>(
    `select 'auto_parts' as table_name, count(*)::bigint as row_count from auto_parts
     union all select 'auto_part_applicability', count(*) from auto_part_applicability
     union all select 'auto_part_stock_entries', count(*) from auto_part_stock_entries
     union all select 'vehicle_maintenance_parts', count(*) from vehicle_maintenance_parts`,
  );
  const dirty = rows.filter((r) => Number(r.row_count) > 0);
  if (dirty.length > 0) {
    throw new Error(
      `Склад в базе прогона не пуст (${dirty.map((r) => r.table_name).join(', ')}): ` +
        'этот файл проверяет барьер пустоты и требует СВОЕЙ чистой базы, а не общей базы db-тестов. ' +
        'Заведите пустую базу, накатите на неё миграции и укажите её в TEST_DATABASE_URL.',
    );
  }

  const shadow = await connect(DB_URL);
  await shadow.query(`create schema ${SHADOW_SCHEMA}`);
  // Тени одноимённы настоящим таблицам и содержат ровно то, что считает барьер, — строки.
  for (const table of SHADOW_TABLES) {
    await shadow.query(`create table ${SHADOW_SCHEMA}.${table} (id int)`);
  }
  // `search_path` без `public`: тень обязана перехватывать ВСЕ четыре имени, иначе случай про одну
  // таблицу молча считал бы настоящие остальные.
  await shadow.query(`set search_path to ${SHADOW_SCHEMA}`);

  const blind = await connect(DB_URL);
  // Пустой `search_path`: ни одно имя склада не разрешается — так же выглядел бы и снос таблиц.
  await blind.query(`set search_path to ''`);

  const stockFrozen = await import('../src/db/stock-frozen');
  const { logger } = await import('../src/logger');

  ctx = {
    real,
    shadow,
    blind,
    assertStockFrozenEmpty: stockFrozen.assertStockFrozenEmpty,
    tables: stockFrozen.STOCK_TABLES,
    logger,
  };
}, 120_000);

afterAll(async () => {
  if (!DB_URL || !ctx) return;
  await ctx.real.query('delete from auto_parts where name = $1', [REAL_PART_NAME]);
  await ctx.shadow.query(`drop schema if exists ${SHADOW_SCHEMA} cascade`);
  await Promise.all([ctx.real.end(), ctx.shadow.end(), ctx.blind.end()]);
});

/** Очистка теней между случаями: непустота одного случая не должна доставаться следующему. */
async function clearShadow(): Promise<void> {
  for (const table of SHADOW_TABLES) {
    await ctx.shadow.query(`truncate ${SHADOW_SCHEMA}.${table}`);
  }
}

describe.skipIf(!DB_URL)('барьер пустоты склада перед заморозкой', () => {
  it('список барьера — настоящие таблицы схемы, и их ровно четыре', async () => {
    // Опечатка в списке не даёт ошибки: таблица просто не считается никогда, и барьер молчит там,
    // где обязан кричать. Поэтому имена сверяются с каталогом, а не с копией списка в тесте.
    for (const table of ctx.tables) {
      const { rows } = await ctx.real.query<{ oid: string | null }>(
        'select to_regclass($1)::text as oid',
        [`public.${table}`],
      );
      expect(rows[0]?.oid, `таблица ${table} не найдена в схеме`).not.toBeNull();
    }
    // Число — отдельным утверждением: пропавшая из списка таблица иначе не заметна ничем.
    expect(ctx.tables.length).toBe(4);
    expect([...ctx.tables]).toEqual([...SHADOW_TABLES]);
  });

  it('пустой склад проходит барьер даже в самом строгом режиме', async () => {
    await expect(
      ctx.assertStockFrozenEmpty({ client: ctx.real, strict: true }),
    ).resolves.toBeUndefined();
  });

  /**
   * Настоящая строка в настоящей таблице — единственный контур, где проверяется весь путь целиком:
   * запрос, `bigint` из `count(*)`, отбор непустых. Карточка с нулевым остатком законна (отложенный
   * триггер покрытия допускает пустой журнал ровно при нуле) и, в отличие от движения, удаляема.
   */
  it('одна законно заведённая карточка отменяет выкат', async () => {
    await ctx.real.query('insert into auto_parts (name) values ($1)', [REAL_PART_NAME]);
    try {
      const error = await ctx.assertStockFrozenEmpty({ client: ctx.real, strict: true }).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/auto_parts: 1/);
    } finally {
      await ctx.real.query('delete from auto_parts where name = $1', [REAL_PART_NAME]);
    }

    // Убрали — и барьер снова пропускает: он смотрит на состояние, а не на историю.
    await expect(
      ctx.assertStockFrozenEmpty({ client: ctx.real, strict: true }),
    ).resolves.toBeUndefined();
  });

  it.each(SHADOW_TABLES)('непустая %s в проде роняет старт', async (table) => {
    await clearShadow();
    await ctx.shadow.query(`insert into ${SHADOW_SCHEMA}.${table} (id) values (1), (2)`);

    const error = await ctx.assertStockFrozenEmpty({ client: ctx.shadow, strict: true }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    // Имя таблицы и число строк — это первое, с чего начнётся разбор «откуда запись» (Р25).
    expect(error?.message).toMatch(new RegExp(`${table}: 2`));
  });

  /**
   * Текст отказа — половина работы барьера: человек, у которого не поднялся API, обязан прочитать
   * не «условие не выполнено», а что делать. Отсюда три обязательных куска: откуда взялась запись,
   * почему `DELETE` не поможет, и чем вернуть портал.
   */
  it('отказ объясняет происхождение записи, запрет DELETE и путь отката', async () => {
    await clearShadow();
    await ctx.shadow.query(`insert into ${SHADOW_SCHEMA}.auto_part_stock_entries (id) values (1)`);

    const error = await ctx.assertStockFrozenEmpty({ client: ctx.shadow, strict: true }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toMatch(/скрыт из портала с выпуска 1/);
    expect(error?.message).toMatch(/прямым запросом/);
    expect(error?.message).toMatch(/auto_part_stock_immutable/);
    expect(error?.message).toMatch(/deploy-auto --previous/);
  });

  /**
   * Вне production строгость выключена по умолчанию, и это не смягчение, а условие работоспособного
   * дева: там таблицы не пусты от пробного заведения, и одинаковая строгость выключила бы
   * `pnpm dev` всем сразу после выпуска 2. Умолчание берётся из `config.isProd`, поэтому случай
   * зовёт функцию БЕЗ `strict` — иначе он проверял бы аргумент, а не умолчание.
   */
  it('вне production непустой склад даёт предупреждение, а не отказ', async () => {
    await clearShadow();
    await ctx.shadow.query(`insert into ${SHADOW_SCHEMA}.auto_parts (id) values (1)`);
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {});

    try {
      await expect(ctx.assertStockFrozenEmpty({ client: ctx.shadow })).resolves.toBeUndefined();

      const message = warn.mock.calls.map((call) => String(call[1] ?? call[0])).join('\n');
      expect(message).toMatch(/Склад автозапчастей не пуст/);
      // Предупреждение обязано называть себя предупреждением: иначе тот же текст в логе дева
      // читается как отказ, которого не было.
      expect(message).toMatch(/Вне production это предупреждение/);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Несчитаемый счёт — это «не знаю, пусто ли», а барьер существует ради этого знания: в проде он
   * остаётся fail-closed и здесь. Проверяется на соединении, у которого в `search_path` нет ни
   * одной таблицы склада, — так же выглядел бы и снос склада будущим выпуском.
   */
  it('нечитаемый счёт в проде тоже отказ, а вне прода — предупреждение', async () => {
    await expect(ctx.assertStockFrozenEmpty({ client: ctx.blind, strict: true })).rejects.toThrow(
      /Не удалось сосчитать строки склада/,
    );

    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {});
    try {
      await expect(
        ctx.assertStockFrozenEmpty({ client: ctx.blind, strict: false }),
      ).resolves.toBeUndefined();
      const message = warn.mock.calls.map((call) => String(call[1] ?? call[0])).join('\n');
      expect(message).toMatch(/Не удалось сосчитать строки склада/);
    } finally {
      warn.mockRestore();
    }
  });
});
