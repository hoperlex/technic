import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Простой SQL-first раннер миграций (§8): применяет ./drizzle/*.sql по порядку,
// идемпотентно, с журналом `_migrations`. Не зависит от секретов приложения —
// нужен только доступ к БД (миграционный пользователь).

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');

async function run(): Promise<void> {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('Не задан DATABASE_MIGRATION_URL (или DATABASE_URL)');
  }
  const caPath = process.env.PGSSLROOTCERT;
  const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
  const url = new URL(migrationUrl);
  url.searchParams.delete('sslmode');

  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: ca ? { ca, rejectUnauthorized: true } : false,
  });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const appliedRes = await client.query<{ name: string }>('SELECT name FROM _migrations');
    const applied = new Set(appliedRes.rows.map((r) => r.name));

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

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
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('Ошибка миграций:', e);
  process.exit(1);
});
