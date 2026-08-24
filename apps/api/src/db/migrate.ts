import type pg from 'pg';
import { applyMigrations, diffMigrations, type MigrationDiff } from './migration-journal';
import { buildMigrationClient } from './migration-client';

// Простой SQL-first раннер миграций (§8): применяет ./drizzle/*.sql по порядку,
// идемпотентно, с журналом `_migrations`. Не зависит от секретов приложения —
// нужен только доступ к БД (миграционный пользователь). Сама механика журнала живёт в
// `migration-journal`: тот же вопрос («что не применено») задаёт сервер при старте.
//
// Подкоманды (process.argv[2]):
//   (без аргумента) | apply — накатить новые миграции (создаёт журнал при необходимости)
//   check                    — статус по КОДУ ВОЗВРАТА: 0 = применено, 3 = есть pending,
//                              1 = журнал ссылается на отсутствующий файл (fail-closed)
//   status                   — печать JSON {applied, pending, missing}, exit 0
//
// check/status строго read-only: журнал НЕ создаётся (наличие проверяется через
// to_regclass), иначе «read-only» статус мутировал бы БД.

const EXIT_FAILURE = 1;
const EXIT_PENDING = 3;

async function runMigrations(client: pg.Client): Promise<void> {
  await applyMigrations(client, (message) => console.log(message));
  console.log('Миграции применены.');
}

async function checkCmd(client: pg.Client): Promise<number> {
  const d: MigrationDiff = await diffMigrations(client);
  if (d.missing.length > 0) {
    console.error(`journal ссылается на отсутствующие файлы: ${d.missing.join(', ')}`);
    return EXIT_FAILURE;
  }
  if (d.pending.length > 0) {
    console.error(`есть неприменённые миграции: ${d.pending.join(', ')}`);
    return EXIT_PENDING;
  }
  console.log('миграции применены');
  return 0;
}

async function statusCmd(client: pg.Client): Promise<void> {
  console.log(JSON.stringify(await diffMigrations(client)));
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'apply';
  const client = buildMigrationClient();
  await client.connect();
  let code = 0;
  try {
    switch (mode) {
      case 'check':
        code = await checkCmd(client);
        break;
      case 'status':
        await statusCmd(client);
        break;
      case 'apply':
      case 'run':
      case 'migrate':
        await runMigrations(client);
        break;
      default:
        console.error(`Неизвестная команда: ${mode} (ожидалось apply|check|status)`);
        code = EXIT_FAILURE;
    }
  } finally {
    await client.end();
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('Ошибка миграций:', e);
  process.exit(EXIT_FAILURE);
});
