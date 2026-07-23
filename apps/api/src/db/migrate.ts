import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Простой SQL-first раннер миграций (§8): применяет ./drizzle/*.sql по порядку,
// идемпотентно, с журналом `_migrations`. Не зависит от секретов приложения —
// нужен только доступ к БД (миграционный пользователь).
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

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');

function buildClient(): pg.Client {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('Не задан DATABASE_MIGRATION_URL (или DATABASE_URL)');
  }
  const caPath = process.env.PGSSLROOTCERT;
  const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
  const url = new URL(migrationUrl);
  url.searchParams.delete('sslmode');

  return new pg.Client({
    connectionString: url.toString(),
    ssl: ca ? { ca, rejectUnauthorized: true } : false,
  });
}

function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

interface Diff {
  applied: string[];
  pending: string[]; // на диске, но не в журнале
  missing: string[]; // в журнале, но не на диске (код старше БД)
}

// Читает журнал БЕЗ его создания: если таблицы `_migrations` ещё нет — все файлы pending.
async function diff(client: pg.Client): Promise<Diff> {
  const reg = await client.query<{ t: string | null }>(
    "SELECT to_regclass('public._migrations') AS t",
  );
  const journalExists = reg.rows[0]?.t != null;
  const appliedRows = journalExists
    ? (await client.query<{ name: string }>('SELECT name FROM _migrations')).rows
    : [];
  const applied = appliedRows.map((r) => r.name).sort();
  const appliedSet = new Set(applied);

  const files = listMigrationFiles();
  const fileSet = new Set(files);

  const pending = files.filter((f) => !appliedSet.has(f));
  const missing = applied.filter((n) => !fileSet.has(n));
  return { applied, pending, missing };
}

async function runMigrations(client: pg.Client): Promise<void> {
  await client.query(
    'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const appliedRes = await client.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  const files = listMigrationFiles();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= пропуск ${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`→ применяю ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  console.log('Миграции применены.');
}

async function checkCmd(client: pg.Client): Promise<number> {
  const d = await diff(client);
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
  console.log(JSON.stringify(await diff(client)));
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'apply';
  const client = buildClient();
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
