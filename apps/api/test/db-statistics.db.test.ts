import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * У базы под ворота качества посчитана статистика.
 *
 * ЧТО ОХРАНЯЕТСЯ. `scripts/check-db.mjs` накатывает миграции на одноразовую базу и зовёт следом
 * `ANALYZE` (`apps/api/scripts/quality-db.ts`, режим `migrate`). Убрать этот шаг — правка на одну
 * строчку, и набор от неё не покраснеет сразу: он начнёт краснеть через раз, у разных файлов, и
 * списываться на «флейк».
 *
 * ПОЧЕМУ ЭТО ВАЖНО. Свежесозданная база статистики не имеет вовсе: у таблицы `reltuples = -1`, и
 * планировщик берёт оценку «по умолчанию» — сотни строк на пустую таблицу. Одному join'у это
 * безразлично; запросу портала с двумя десятками LEFT JOIN'ов оценка перемножается по цепочке.
 * Замерено на этой самой схеме, карточка заявки на технику (`baseQuery` в
 * `routes/vehicle-requests.ts`), `EXPLAIN (ANALYZE, BUFFERS)` по двум идентификаторам:
 *
 *   без статистики:  cost=188 264 897 663, rows=2 624 945 150 при фактических 2
 *                    JIT: Functions 235, Inlining true, Optimization true, Total 1126 мс
 *                    Execution Time 1144 мс
 *   со статистикой:  cost=86, Execution Time 1,3 мс, JIT не включается вовсе
 *
 * Платит за разъехавшуюся оценку JIT: он смотрит на ОЦЕНКУ плана, а не на данные, и на такой
 * оценке компилирует две с лишним сотни функций с полной оптимизацией на каждый вызов.
 * `vehicle-feed.db.test.ts` на одной и той же свежей базе проходил три прогона подряд (257, 295,
 * 276 мс) и с четвёртого начинал стабильно упираться в пятисекундный предел — к тому моменту
 * автовакуум успевал посчитать 13 таблиц из 150, и смесь «часть посчитана, часть неизвестна»
 * разносила оценку сильнее, чем её отсутствие целиком.
 *
 * ДВЕ ПРОВЕРКИ, А НЕ ОДНА. Первая — сам факт: неизвестных таблиц нет. Вторая — то, ради чего факт
 * нужен: оценка цепочки LEFT JOIN'ов от заявки не разъезжается с действительностью. Цепочка
 * строится ИЗ СХЕМЫ (все внешние ключи, ссылающиеся на `vehicle_requests`), а не переписана сюда
 * из `baseQuery`: копия отстала бы от запроса молча, а эта форма следует за схемой сама. Замер
 * разницы: со статистикой `rows=1`, без неё `rows=9072` — при одной строке на выходе.
 *
 * ФАЙЛ СУДИТ О БАЗЕ ВОРОТ. Запусти его на своей базе, где `ANALYZE` никто не делал, — он покраснеет
 * по делу: планировщик там работает по оценкам «по умолчанию» ровно так же.
 *
 * Запуск:
 *
 *   pnpm check:db db-statistics
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Потолок оценки для цепочки. Единица была бы правдой (фильтр по первичному ключу), но правдой
 * хрупкой: обычная выборка статистики даёт небольшой разброс. Сотня отделяет «оценка держится» от
 * «оценка разъехалась» с запасом в обе стороны — измеренная разница между состояниями почти в сто
 * раз больше самого порога.
 */
const ROWS_LIMIT = 100;

let client: pg.Client;

describe.skipIf(!DB_URL)('база под ворота качества: статистика посчитана', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it('ни одной таблицы без статистики: reltuples нигде не -1', async () => {
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public' AND c.reltuples = -1
       ORDER BY c.relname`);
    expect(
      rows.map((r) => r.relname),
      'база заводится с ANALYZE (scripts/check-db.mjs → quality-db.ts migrate); ' +
        'на своей базе посчитайте статистику сами',
    ).toEqual([]);
  });

  it('оценка цепочки LEFT JOIN от заявки не разъезжается с действительностью', async () => {
    // Цепочка собирается из схемы: все внешние ключи, ссылающиеся на заявку. Копии `baseQuery`
    // здесь нет намеренно — она отстала бы от запроса молча.
    const { rows: joins } = await client.query<{ sql: string | null }>(`
      SELECT string_agg(
               format('LEFT JOIN %I t%s ON t%s.%I = vehicle_requests.id', child, n, n, col),
               E'\\n' ORDER BY n) AS sql
        FROM (
          SELECT row_number() OVER (ORDER BY c.conrelid::regclass::text, a.attname) AS n,
                 c.conrelid::regclass::text AS child, a.attname AS col
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           WHERE c.contype = 'f' AND c.confrelid = 'vehicle_requests'::regclass
        ) s`);
    const chain = joins[0]?.sql;
    // Пустая цепочка означала бы, что на заявку никто не ссылается, — тогда проверять нечего, и
    // молчаливое «зелено» было бы обманом.
    expect(
      chain,
      'на vehicle_requests нет ни одного внешнего ключа — цепочку не из чего собрать',
    ).toBeTruthy();

    const { rows: plan } = await client.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN SELECT 1 FROM vehicle_requests
      ${chain}
      WHERE vehicle_requests.id = '00000000-0000-0000-0000-000000000001'`);
    const head = plan[0]!['QUERY PLAN'];
    const estimate = Number(/rows=(\d+)/.exec(head)?.[1]);
    expect(Number.isFinite(estimate), head).toBe(true);
    expect(estimate, `оценка верхнего узла плана: ${head}`).toBeLessThanOrEqual(ROWS_LIMIT);
  });
});
