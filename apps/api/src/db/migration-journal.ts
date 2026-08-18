import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Журнал миграций: какие файлы лежат на диске и какие из них записаны в `_migrations`.
 *
 * Вынесено из скрипта миграций (`migrate.ts`) отдельным модулем, потому что тот же вопрос
 * задаёт сам сервер при старте: код и схема расходятся молча, а падает на этом первое же
 * действие человека — и падает пятисоткой, по которой не догадаться, что не хватает миграции.
 *
 * Модуль намеренно ничего не знает ни о конфиге приложения, ни о пуле: скрипт миграций ходит в
 * базу миграционным пользователем и запускается без секретов приложения (§8), а сервер — своим
 * рабочим пулом. Общее у них ровно одно — механика журнала, и она принимает функцию запроса.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** `src/db` → `apps/api/drizzle`: и скрипт, и сервер читают один и тот же каталог. */
export const migrationsDir = join(here, '..', '..', 'drizzle');

/** Минимум от клиента БД: и `pg.Client`, и `pg.Pool` подходят как есть. */
export interface MigrationQuery {
  query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface MigrationDiff {
  applied: string[];
  /** На диске, но не в журнале: база отстала от кода. */
  pending: string[];
  /** В журнале, но не на диске: код старше базы (откатились не на ту версию). */
  missing: string[];
}

export function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(join(migrationsDir, name), 'utf8');
}

/**
 * Расхождение диска и журнала. Журнал читается БЕЗ его создания (`to_regclass`): вопрос задают и
 * read-only проверки — статус, стартовая сверка сервера, — а создание таблицы означало бы, что
 * «просто посмотреть» меняет базу. Нет таблицы — значит не применено ничего.
 */
export async function diffMigrations(client: MigrationQuery): Promise<MigrationDiff> {
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

  return {
    applied,
    pending: files.filter((f) => !appliedSet.has(f)),
    missing: applied.filter((n) => !fileSet.has(n)),
  };
}

/**
 * Ключ advisory-лока наката. Число произвольно, но постоянно: договариваются по нему все, кто
 * умеет катить миграции, и меняться оно не может — иначе старая и новая версии кода разойдутся по
 * разным замкам и снова встретятся в одной базе.
 */
const APPLY_LOCK_KEY = 6413361136;

/**
 * Накатить неприменённое, по файлу за транзакцию. Журнал создаётся здесь — это единственное
 * место, которое имеет право его завести: остальные только читают.
 *
 * НАКАТ ИДЁТ ПОД ЗАМКОМ. Два наката на одну базу одновременно ломают друг друга: каждый читает
 * журнал, видит один и тот же список неприменённого и катит его целиком. `CREATE TABLE` из
 * миграции при этом падает не «таблица уже есть», а `duplicate key ... pg_type_typname_nsp_index` —
 * гонкой в системном каталоге, по которой о миграциях не догадаться; соседний накат в это же время
 * может увидеть таблицу без ещё не добавленной колонки и упасть иначе. Ловилось это на прогоне
 * db-тестов по пустой базе (файлы идут параллельно, и каждый зовёт накат сам), но беда не тестовая:
 * два раннера деплоя на одну базу дают ровно то же.
 *
 * Замок — сеансовый advisory (`pg_advisory_lock`), а не таблица-семафор: его снимает сам Postgres
 * при обрыве соединения, и брошенный на полпути накат не оставляет базу запертой навсегда. Второй
 * ждёт на нём столько, сколько идёт первый (чистая база — секунды), и, дождавшись, читает журнал
 * **уже под замком**: список неприменённого к этому моменту пуст, и он ничего не делает.
 *
 * Отсюда требование к `client`: это должен быть один сеанс (`pg.Client`), а не пул. Сеансовый
 * замок принадлежит соединению, и на пуле `pg_advisory_unlock` мог бы уйти в другое соединение —
 * то есть не снять ничего. Все нынешние вызывающие передают `pg.Client`.
 */
export async function applyMigrations(
  client: MigrationQuery,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  // Замок берётся ДО журнала: гонка начинается уже на `CREATE TABLE IF NOT EXISTS` — «если нет»
  // проверяется до создания, а не вместо него, и два таких запроса разом дают ту же ошибку
  // каталога.
  await client.query('SELECT pg_advisory_lock($1)', [APPLY_LOCK_KEY]);
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const appliedRes = await client.query<{ name: string }>('SELECT name FROM _migrations');
    const applied = new Set(appliedRes.rows.map((r) => r.name));

    const done: string[] = [];
    for (const file of listMigrationFiles()) {
      if (applied.has(file)) {
        log(`= пропуск ${file}`);
        continue;
      }
      log(`→ применяю ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readMigration(file));
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      done.push(file);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [APPLY_LOCK_KEY]);
  }
}

/** Перечень для сообщения человеку: первые несколько имён и «ещё N» — список бывает длинным. */
export function listMigrationNames(names: readonly string[], limit = 5): string {
  const head = names.slice(0, limit).join(', ');
  return names.length > limit ? `${head} и ещё ${names.length - limit}` : head;
}
