/**
 * Свежая база под db-набор ворот качества: завести и снести. Зовётся из `scripts/check-db.mjs`.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ И ЗАЧЕМ ЗДЕСЬ. Создать и снести базу нужно ДО того, как поднимется хоть
 * один тест, — и тем же драйвером, которым потом пойдут они сами. `pg` объявлен зависимостью
 * api, поэтому механика живёт рядом с ним: скрипт в корне репозитория импортировать `pg` не может
 * (в корневом package.json его нет), а звать `psql` значило бы требовать клиент postgres на
 * машине, где тестам он не нужен.
 *
 * ПОЧЕМУ БАЗА СВЕЖАЯ. На общей `technic_archive_test` db-набор врёт в обе стороны: мусор
 * оборванных прогонов делает зелёными тесты, которые должны краснеть (`garage` сверялся с чужим
 * занятым водителем), а конкуренция за `max_connections` красит красным те, что в порядке.
 * Именно этим объясняли и настоящий дефект — потерю скана талона, — пять дней подряд.
 *
 * ПОЧЕМУ РАСШИРЕНИЯ СТАВЯТСЯ ЗДЕСЬ. Миграции портала опираются на `citext`, `pg_trgm` и
 * `pgcrypto` с самых первых номеров и на пустой базе без них просто не идут. Ставить их внутри
 * миграции нельзя: на проде расширения заводит администратор кластера, а не приложение.
 *
 * Подключение приходит окружением, а не аргументом командной строки: в строке подключения пароль,
 * а список процессов виден всей машине.
 *
 *   QUALITY_DB_ADMIN_URL  подключение к служебной базе (обычно `postgres`) того же кластера
 *   QUALITY_DB_NAME       имя заводимой/сносимой базы
 */
import process from 'node:process';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-journal';

const ADMIN_URL = process.env.QUALITY_DB_ADMIN_URL;
const DB_NAME = process.env.QUALITY_DB_NAME;

if (!ADMIN_URL || !DB_NAME) {
  console.error('нужны QUALITY_DB_ADMIN_URL и QUALITY_DB_NAME');
  process.exit(2);
}

/**
 * Имя базы приходит из своего же скрипта, но проверяется всё равно: оно подставляется в SQL
 * идентификатором, а не параметром — параметров у `CREATE DATABASE` не бывает. Проверка стоит
 * дешевле разговора о том, могла ли сюда попасть чужая строка.
 */
if (!/^[a-z][a-z0-9_]{0,62}$/.test(DB_NAME)) {
  console.error(`недопустимое имя базы: ${DB_NAME}`);
  process.exit(2);
}

const MODE = process.argv[2];

/** Расширения, без которых миграции портала не идут (см. шапку файла). */
const EXTENSIONS = ['citext', 'pg_trgm', 'pgcrypto'];

async function withAdmin<T>(action: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function create(): Promise<void> {
  await withAdmin(async (client) => {
    // FORCE — страховка от соединений ПРОШЛОГО прогона: имя базы содержит отметку времени, так
    // что столкнуться со своими же соединениями здесь нечем.
    await client.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${DB_NAME}"`);
  });

  const url = new URL(ADMIN_URL!);
  url.pathname = `/${DB_NAME}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    for (const extension of EXTENSIONS) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    }
  } finally {
    await client.end();
  }
  console.log(`база ${DB_NAME} заведена, расширения: ${EXTENSIONS.join(', ')}`);
}

/**
 * Накат миграций на заведённую базу. В полном наборе этот режим не нужен — миграции накатывают
 * сами тесты api, и порядок «api, потом worker» на этом и держится. Он нужен ТОЧЕЧНОМУ прогону
 * (`pnpm check:db <фильтр>`): если под фильтр не попал ни один тест api, база осталась бы пустой,
 * и тест воркера падал бы на отсутствующей таблице — падением, не имеющим отношения к делу.
 */
async function migrate(): Promise<void> {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${DB_NAME}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    let count = 0;
    await applyMigrations(client, () => {
      count += 1;
    });
    console.log(`база ${DB_NAME}: применено миграций — ${count}`);
  } finally {
    await client.end();
  }
}

async function drop(): Promise<void> {
  await withAdmin(async (client) => {
    // Часть db-тестов заводит СВОЮ базу от имени основной (`<основная>_rm_<метка>_<прогон>`) и
    // сносит её сама. Оборванный прогон этого не делает — и такие базы копятся десятками, потому
    // что снаружи неотличимы от чужих. Раз имя основной базы уникально для прогона, её потомство
    // опознаётся точно, и уборка их забирает: иначе «база сносится за собой» было бы неправдой.
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2',
      [DB_NAME, `${DB_NAME}\\_%`],
    );
    for (const row of rows) {
      await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    }
    const extra = rows.length - (rows.some((row) => row.datname === DB_NAME) ? 1 : 0);
    console.log(`база ${DB_NAME} снесена${extra > 0 ? ` (и ${extra} производных от тестов)` : ''}`);
  });
}

const ACTIONS: Record<string, () => Promise<void>> = { create, migrate, drop };
const action = MODE ? ACTIONS[MODE] : undefined;
if (!action) {
  console.error(`режим: ${Object.keys(ACTIONS).join(' | ')} (получено «${MODE ?? ''}»)`);
  process.exit(2);
}

await action().catch((error: unknown) => {
  console.error(`${MODE} ${DB_NAME}: ${String(error)}`);
  process.exit(1);
});
