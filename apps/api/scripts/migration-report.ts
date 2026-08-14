import { diffMigrations, listMigrationFiles } from '../src/db/migration-journal';
import { buildMigrationClient } from '../src/db/migration-client';

/**
 * Состав миграций машиночитаемо — для гейтов `deploy-auto` (протокол выката, §4.1, §5, §6).
 *
 * Отдельно от `db:migrate:status`: тот печатает JSON, а читает его bash деплоя, где разбирать JSON
 * нечем — `jq` на площадке нет, и заводить зависимость ради одного места означало бы, что гейт
 * отката перестанет работать на хосте, где её забыли поставить. Поэтому формат — строки вида
 * «вид имя», которые отбираются `grep`.
 *
 * Режимы (`process.argv[2]`):
 *   files    — какие миграции несёт ЭТОТ образ; база не нужна. Вопрос «умеет ли код жить с такой
 *              схемой» задаётся образу, а не журналу: журнал говорит, что накатано сейчас (§4.1);
 *   journal  — что видит журнал базы: `applied` / `pending` / `missing`.
 *
 * Последняя строка — маркер `files ok` / `journal ok`. Вывод едет через `docker compose run`, где к
 * нему может подмешаться чужое, а гейты выката fail-closed: «список пуст» и «команда не отработала»
 * обязаны отличаться, иначе упавший запуск прочитался бы как «границ нет, всё чисто».
 *
 * Использование:
 *   pnpm --filter @technic/api db:migrate:files
 *   pnpm --filter @technic/api db:migrate:journal
 */

const EXIT_FAILURE = 1;

function printNames(kind: string, names: readonly string[]): void {
  for (const name of names) console.log(`${kind} ${name}`);
}

function filesCmd(): void {
  printNames('file', listMigrationFiles());
  console.log('files ok');
}

async function journalCmd(): Promise<void> {
  const client = buildMigrationClient();
  await client.connect();
  try {
    const diff = await diffMigrations(client);
    printNames('applied', diff.applied);
    printNames('pending', diff.pending);
    printNames('missing', diff.missing);
    console.log('journal ok');
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'files';
  switch (mode) {
    case 'files':
      filesCmd();
      break;
    case 'journal':
      await journalCmd();
      break;
    default:
      console.error(`Неизвестная команда: ${mode} (ожидалось files|journal)`);
      process.exit(EXIT_FAILURE);
  }
}

main().catch((e) => {
  console.error('Ошибка отчёта о миграциях:', e);
  process.exit(EXIT_FAILURE);
});
