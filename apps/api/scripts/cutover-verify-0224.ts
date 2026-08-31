import { buildMigrationClient } from '../src/db/migration-client';

/**
 * Верификатор шага 6 протокола выката для бандла `0224_office_equipment_cycle.sql` (ADR 0145).
 *
 * ПОЧЕМУ СКРИПТ, А НЕ ОДНОСТРОЧНИК `node -e`. Первая редакция верификатора ходила в базу своим
 * `new pg.Client({ connectionString })` — и на боевом URL не соединилась бы вовсе. В проде
 * `DATABASE_MIGRATION_URL` несёт `?sslmode=verify-full`, а корневой сертификат лежит в
 * `PGSSLROOTCERT`: `pg-connection-string` по любому `sslmode` взводит TLS с `rejectUnauthorized`,
 * но `ca` не подставляет ниоткуда, а node-postgres переменную `PGSSLROOTCERT` не знает — она
 * libpq'шная. Цепочка проверялась бы по системному хранилищу, куда корень кластера не входит.
 * Ровно от этой ловушки и заведён `buildMigrationClient`, который снимает `sslmode` и подставляет
 * `ca` явно; здесь зовётся он, а не вторая копия настройки. Прецедент тот же — верификатор 0136
 * ходит в базу штатным скриптом релиза.
 *
 * Найдено репетицией по §9 протокола: без этой правки шаг 6 упал бы fail-closed ВНУТРИ окна, на
 * остановленных сервисах, по причине, не имеющей отношения к данным.
 *
 * ЧТО ПРОВЕРЯЕТ. Только постусловия, видимые по текущей базе: верификатор — отдельная команда
 * ПОСЛЕ наката, домиграционного состояния он не видит, а переменные миграции ему недоступны.
 * Сверка «Новых с исполнителями стало столько же, сколько было Назначенных» живёт внутри самой
 * миграции, в одном блоке с конверсией.
 *
 * ДВА ШАГА, А НЕ ОДИН ЗАПРОС. Проверка данных ссылается на колонку `estimate_pending_revision`,
 * поэтому на базе без бандла запрос не разбирается вовсе — и вместо внятного «нет колонок бандла»
 * приходил бы `column ... does not exist`, то есть ровно в том случае, ради которого проверка
 * наличия колонок и писалась. Сперва схема, потом данные.
 */

const RELEASE_SEQ = 63;
const RELEASE_VERSION = '0.1.54.0145';
const DEAD_STATUSES = ['it_approved', 'diagnostics', 'assigned', 'estimate_review'];

async function main(): Promise<void> {
  const client = buildMigrationClient();
  await client.connect();
  try {
    const problems: string[] = [];

    // ── Шаг 1: схема ──
    const schema = await client.query<{ columns: string; checks: string; door: boolean }>(`
      select
        (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'service_requests'
            and column_name in ('estimate_pending_revision','rejection_resolution','object_overridden')
        )::text as columns,
        (select count(*) from pg_constraint
          where conrelid = 'service_requests'::regclass
            and conname in ('service_requests_estimate_pending_check',
                            'service_requests_rejection_resolution_check')
        )::text as checks,
        exists (
          select 1 from pg_constraint
           where conrelid = 'service_requests'::regclass
             and conname = 'service_requests_dead_status_check'
             -- Дверь опознаётся СОДЕРЖИМЫМ, а не именем: имя то же, что у двери 0197, и проверка
             -- по имени пропустила бы её прежний вид на пару значений.
             and pg_get_constraintdef(oid) like '%assigned%'
             and pg_get_constraintdef(oid) like '%estimate_review%'
        ) as door
    `);
    const s = schema.rows[0]!;
    if (s.columns !== '3') problems.push(`колонок бандла на месте ${s.columns} из 3`);
    if (s.checks !== '2') problems.push(`ограничений вида на месте ${s.checks} из 2`);
    if (!s.door)
      problems.push('дверь мёртвых статусов не закрыта на «Назначена» и «Смету на согласовании»');

    // Без схемы проверять данные нечем — и незачем: отказ уже состоялся.
    if (problems.length > 0) return fail(problems);

    // ── Шаг 2: данные ──
    const data = await client.query<{ dead: string; stale: string; release: string }>(
      `
      select
        (select count(*) from service_requests
          where status = any($1::service_request_status[])
             or held_from_status = any($1::service_request_status[]))::text as dead,
        (select count(*) from service_requests
          where estimate_pending_revision is not null
            and estimate_pending_revision <> estimate_revision)::text as stale,
        (select count(*) from app_releases where seq = $2 and version = $3)::text as release
    `,
      [DEAD_STATUSES, RELEASE_SEQ, RELEASE_VERSION],
    );
    const d = data.rows[0]!;
    if (d.dead !== '0') problems.push(`заявок в мёртвых статусах: ${d.dead}`);
    if (d.stale !== '0') problems.push(`предъявлений не на текущей ревизии: ${d.stale}`);
    if (d.release !== '1') {
      problems.push(
        `строк выпуска seq ${RELEASE_SEQ} (${RELEASE_VERSION}): ${d.release}, ожидалась одна`,
      );
    }

    if (problems.length > 0) return fail(problems);
    console.log('0224: постусловия сошлись');
  } finally {
    await client.end();
  }
}

function fail(problems: string[]): never {
  console.error(`0224 не сошлась: ${problems.join('; ')}`);
  process.exit(1);
}

main().catch((e: unknown) => {
  console.error(`0224: проверка не выполнена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
