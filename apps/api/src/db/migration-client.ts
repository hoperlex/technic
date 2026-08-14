import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Подключение **миграционного** пользователя: раннер миграций (`migrate.ts`) и служебные команды
 * необратимого выката (`scripts/cutover-down.ts`, протокол `docs/schema-cutover-protocol.md`).
 *
 * Своим модулем, а не функцией внутри раннера, по прозаической причине: `migrate.ts` выполняет
 * `main()` прямо при импорте — импортировать оттуда что-либо значит накатить миграции. Второй
 * копии здесь быть не должно: код ходит в базу с правами, которых нет у приложения, и TLS у него
 * настраивается вручную — разойдясь, две копии дали бы путь, где `verify-full` существует только
 * на бумаге, и заметить это было бы нечем.
 *
 * Секретов приложения не требует: только `DATABASE_MIGRATION_URL` (или `DATABASE_URL`) и корневой
 * сертификат в `PGSSLROOTCERT`.
 *
 * `sslmode` из строки вычищается намеренно: параметр понимает libpq, а node-postgres его не читает
 * вовсе — оставленный в URL, он молча ничего не включает. TLS задаётся объектом `ssl` с корневым
 * сертификатом, иначе цепочка не проверяется.
 */
export function buildMigrationClient(): pg.Client {
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
