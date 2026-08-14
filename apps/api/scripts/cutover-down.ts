import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from '../src/db/migration-journal';
import { buildMigrationClient } from '../src/db/migration-client';

/**
 * Запускатель teardown — обратной миграции релиза (протокол выката, §7).
 *
 * Механика общая, SQL приносит релиз: файл `apps/api/teardown/<полное имя файла миграции>` —
 * например `apps/api/teardown/0136_route_trips.sql` для миграции `0136_route_trips.sql`.
 *
 * Каталог намеренно не тот, из которого читает раннер: `listMigrationFiles()` берёт каждый `*.sql`
 * из `apps/api/drizzle`, и лежи teardown там, ближайший `db:migrate` применил бы его следом за
 * миграцией — сняв ровно то, что только что накатил, и молча.
 *
 * Teardown и снятие записи журнала идут **одной транзакцией**. Порознь обрыв между ними оставляет
 * либо схему без записи (миграция накатится повторно поверх уже снятого), либо запись без схемы
 * (`missing` — код старше базы, и сервер не стартует вовсе).
 *
 * Запись снимается по полному имени файла с проверкой «удалена ровно одна строка»: ноль означает,
 * что миграция не применялась (повторный откат), больше одной — что журнал не тот. И то и другое —
 * отказ с откатом транзакции. Проверка идёт **до** применения SQL: отказать, не тронув схему,
 * честнее, чем откатывать уже сделанное, а порядок внутри транзакции на результат не влияет.
 *
 * Руками не вызывается: ни фазы выката, ни границы совместимости команда не проверяет — для
 * человека есть `deploy-auto --cutover-revert` (§3.3). Прямой запуск остаётся у репетиции на копии
 * базы (§9) и у самого `deploy-auto`, который эти проверки уже сделал.
 *
 * Использование: pnpm --filter @technic/api db:cutover-down 0136_route_trips.sql
 */

const EXIT_FAILURE = 1;

const here = dirname(fileURLToPath(import.meta.url));
/** `scripts` → `apps/api/teardown`: каталог, которого раннер миграций не видит. */
const teardownDir = join(here, '..', 'teardown');

/**
 * Имя миграции принимается только как имя файла: команда подставляет его в путь, и любой разделитель
 * каталогов или `..` увёл бы чтение за пределы `teardown/`. Запускает её деплой, но аргумент туда
 * приходит из состояния на диске — доверять ему как константе нельзя.
 */
function checkName(name: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*\.sql$/u.test(name) || name.includes('..')) {
    throw new Error(`Недопустимое имя миграции: ${name} (ожидалось имя файла вида 0136_name.sql)`);
  }
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    throw new Error(
      'Не указана миграция. Использование: pnpm --filter @technic/api db:cutover-down <миграция.sql>',
    );
  }
  checkName(name);

  /*
   * Миграция обязана быть известна ЭТОМУ образу. Teardown приезжает вместе с миграцией, поэтому
   * запускается образом кандидата (§7); имя, которого в его каталоге миграций нет, означает, что
   * команду позвали не тем образом — и снятие записи журнала оставило бы базу без миграции,
   * которую этот код считает применённой.
   */
  if (!listMigrationFiles().includes(name)) {
    throw new Error(
      `Миграции ${name} нет среди миграций этого образа — teardown запускается образом кандидата`,
    );
  }

  const file = join(teardownDir, name);
  if (!existsSync(file)) {
    throw new Error(`Нет teardown для ${name}: ожидался файл apps/api/teardown/${name}`);
  }
  const sql = readFileSync(file, 'utf8');

  const client = buildMigrationClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      // Журнал читается без его создания: команда снимает запись, а не заводит журнал.
      const reg = await client.query<{ t: string | null }>(
        "SELECT to_regclass('public._migrations') AS t",
      );
      if (reg.rows[0]?.t == null) {
        throw new Error('В базе нет журнала _migrations — снимать нечего');
      }
      const deleted = await client.query('DELETE FROM _migrations WHERE name = $1', [name]);
      if (deleted.rowCount !== 1) {
        throw new Error(
          `Из журнала удалено строк: ${deleted.rowCount ?? 0}, ожидалась ровно одна. ` +
            'Ноль — миграция не применялась (teardown уже выполнен), больше — журнал не тот. ' +
            'Транзакция откачена, база не тронута.',
        );
      }
      console.log(`→ teardown ${name} (apps/api/teardown/${name})`);
      await client.query(sql);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    console.log(`Миграция ${name} снята: teardown применён, запись журнала удалена.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Ошибка teardown:', e instanceof Error ? e.message : e);
  process.exit(EXIT_FAILURE);
});
