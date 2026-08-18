import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, readMigration } from '../src/db/migration-journal';

/**
 * Совместимость переработки с тем, что уже лежит в базе (план `docs/route-trips-plan.md`, Р24,
 * §5.7) — на данных «как в проде».
 *
 * Это не тест новой функции, а ответ на единственный вопрос выката: **переживёт ли миграция то,
 * что накопилось**. Отдельной обработки для старых заявок не заводится (Р24) — они становятся
 * заявками с одной ездкой, — и вся цена этого решения ложится на бэкфил `0136`. Потеряй он
 * что-нибудь, узнали бы об этом из карточки заявки, у которой пропали адреса, и уже после того,
 * как колонки-источники удалены той же миграцией, а откат запрещён навсегда (Р23).
 *
 * ПОЧЕМУ ТАК, А НЕ ПРОЩЕ. На пустой базе бэкфил проверять нечем: он переносит ровно то, чего в
 * свежей базе не бывает, — заявки старше [ADR 0006](../../../docs/adr/0006-address-verification.md)
 * и миграции `0062` (адрес без метаданных, контакт пустой строкой), архивные заявки, выданные
 * листы. Поэтому база берётся **копией накопленной** (`TEST_DATABASE_URL`), откатывается за границу
 * `0136` штатным `db:cutover-down`, дополняется своими сценариями в старой форме — и миграция
 * накатывается на всё это разом. Копия своя: откат сносит таблицы, и на общей базе он унёс бы
 * работу соседних файлов.
 *
 * Снимки снимаются ДО наката и сверяются ПОСЛЕ. Иначе тест проверял бы не перенос, а собственные
 * ожидания: «адрес на месте» без снимка означает «адрес такой, какой я тут написал», а вопрос
 * стоит иначе — тот ли он, что был.
 *
 * Вся работа сделана один раз, в `beforeAll`, и это не лень: миграция накатывается ровно однажды,
 * как в проде, а каждый `it` спрашивает о снятом состоянии свой вопрос. Разложи их по тестам — и
 * порядок файлов начал бы значить, накатана ли уже миграция.
 *
 * Что здесь НЕ проверяется: правка старой заявки после миграции (её держит
 * `legacy-trip-edit.db.test.ts`, Р2а) и обратимость teardown как таковая (репетиция выката,
 * протокол §9).
 *
 * Копия — не «база как есть», а база «как была бы на выкате»: см. `dropSkeletonRequests`, где с
 * неё снимается то, чего в проде в этот момент существовать не может.
 *
 * Запуск (нужны `pg_dump` и `psql` в PATH — копия снимается ими, а не `CREATE DATABASE …
 * TEMPLATE`: шаблон требует, чтобы к источнику не было ни одного подключения, а соседние db-тесты
 * идут параллельно и держат его открытым):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test legacy-compat
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Миграция переработки: имя файла — оно же ключ журнала и имя teardown. */
const CUTOVER = '0136_route_trips.sql';
/** Позиция роли внутри точки: заведена после ревью и едет отдельным обычным деплоем (§12б). */
const ROLE_POSITIONS = '0146_route_role_positions.sql';

const here = dirname(fileURLToPath(import.meta.url));
/** `test` → `apps/api`: отсюда запускаются штатные команды пакета. */
const apiDir = join(here, '..');

interface Row {
  [column: string]: unknown;
}

/** Строка деталей заявки до миграции — ровно те поля, которые обязаны доехать до ездки. */
interface LegacyDetails extends Row {
  request_id: string;
  loading_location: string;
  unloading_location: string;
  loading_address: string | null;
  unloading_address: string | null;
  volume_m3: string | null;
  weight_tons: string | null;
  loading_responsible_name: string;
  loading_responsible_phone: string;
  unloading_responsible_name: string;
  unloading_responsible_phone: string;
}

/** Ездка после миграции — те же поля под новыми именами. */
interface MigratedTrip extends Row {
  request_id: string;
  num: number;
  from_location: string;
  to_location: string;
  from_address: string | null;
  to_address: string | null;
  volume_m3: string | null;
  weight_tons: string | null;
  from_responsible_name: string;
  from_responsible_phone: string;
  to_responsible_name: string;
  to_responsible_phone: string;
}

/** Печатное состояние листов: число, объём и отпечаток снимков `waybills.data`. */
interface PrintDigest extends Row {
  waybills: string;
  bytes: string;
  digest: string;
}

/** Заявки сценария: у каждой своё состояние, и каждая обязана пережить миграцию одинаково. */
interface Scenario {
  /** В работе. */
  working: string;
  /** Закрытая. */
  closed: string;
  /** Архивная (`deleted_at`): её карточка открывается и печатается, значит адреса нужны и ей. */
  archived: string;
  /** С выданным листом: её строка задания уже на бумаге. */
  papered: string;
  /** Старше ADR 0006 и миграции `0062`: адрес без метаданных, контакт пустой строкой. */
  legacy: string;
  /** День линейного заказа в составе маршрута — ездок у него нет и не будет (Р5а). */
  linear: string;
  routeId: string;
  waybillId: string;
  /** Адрес линейного дня, как его склеит бэкфил: «наименование объекта, адрес». */
  objectLocation: string;
}

interface Ctx {
  db: pg.Client;
  copyUrl: string;
  scenario: Scenario;
  /** Снимки «до»: детали заявок, печатные данные листов и связь «лист ↔ заявка». */
  detailsBefore: Map<string, LegacyDetails>;
  printBefore: PrintDigest;
  printedTaskBefore: string;
  waybillRequestsBefore: { request_id: string; slot: number }[];
  /** Отказ миграции на заявке без деталей — вместе с состоянием базы после отказа. */
  orphan: { message: string; applied: boolean; tripsTable: string | null; trace: string };
  /** Заявки-скелеты, снятые с копии перед откатом (`dropSkeletonRequests`): обычно ни одной. */
  skeletons: string[];
  /** Что накатилось на втором заходе. */
  applied: string[];
  /** Состояние «после»: ездки, точки с ролями, связь «лист ↔ ездка», печать. */
  tripsAfter: Map<string, MigratedTrip[]>;
  tripCount: number;
  detailCount: number;
  pointsAfter: { position: number; location: string; role: string; request_id: string }[];
  waybillTripsAfter: { slot: number; request_id: string; num: number }[];
  waybillTripsTotal: number;
  freightWaybillRequests: number;
  printAfter: PrintDigest;
  printedTaskAfter: string;
}

let ctx: Ctx;

// ── Служебное: копия базы, откат за границу, запуск штатных команд ────────────────────────────

/** Копия базы: имя источника с суффиксом — её видно в `\l`, и понятно, чья она и зачем. */
function copyUrlOf(source: string): string {
  const url = new URL(source);
  url.pathname = `${url.pathname}_legacy_compat`;
  return url.toString();
}

/** Служебная база того же кластера: `CREATE DATABASE` изнутри создаваемой копии не выполнить. */
function maintenanceUrlOf(source: string): string {
  const url = new URL(source);
  url.pathname = '/postgres';
  return url.toString();
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//u, '');
}

/** Запуск команды с ожиданием кода возврата; вывод возвращается целиком — он и есть объяснение. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

/** Копия базы `pg_dump | psql`: поток идёт мимо диска, 80 МБ тестовой базы копируются за секунды. */
async function copyDatabase(source: string, target: string): Promise<void> {
  const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const restore = spawn('psql', ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', target], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let errors = '';
  dump.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  restore.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  dump.stdout.pipe(restore.stdin);

  const codes = await Promise.all(
    [dump, restore].map(
      (child) =>
        new Promise<number>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code) => resolve(code ?? -1));
        }),
    ),
  );
  if (codes.some((code) => code !== 0)) {
    throw new Error(`Копия базы не снялась (коды ${codes.join('/')}): ${errors}`);
  }
}

/** Сколько ждать, пока сосед доведёт свою заявку до ездок или уберёт её (см. ниже). */
const SKELETON_WAIT_MS = 30_000;

/**
 * Снять с копии заявки-скелеты: строка деталей есть, а ездок нет НИ ОДНОЙ.
 *
 * Откуда они берутся. В проде такой заявки не бывает: форма требует хотя бы одну ездку
 * (`requestTripsSchema`), заводятся детали и ездки одной транзакцией, а удаляются ездки только
 * мягко — на них ссылается выданный лист. База же у db-тестов общая, и соседние файлы кладут
 * заявки прямым SQL: `vehicle-type-linear-switch` заводит грузовую заявку без ездок (ездки ему
 * незачем — он проверяет заморозку режима) и держит её пару секунд до своего `afterAll`. Попади
 * `pg_dump` в это окно — и копия унесёт строку, которой в прод-базе на выкате быть не могло.
 *
 * Почему это ломает тест целиком. Откат за границу `0136` возвращает адреса заявке ИЗ ПЕРВОЙ
 * ездки, и teardown первым делом пересчитывает такие строки: «Строк деталей без единой ездки: 1
 * шт.» — отказ до всякой записи, потому что иначе `SET NOT NULL` упал бы кодом 23502, ничего не
 * объяснив. Отказ верный, и трогать его нельзя: он и стережёт то, ради чего файл написан.
 *
 * Почему снимать честно. Проверка не ослабляется, а фиксация обязана быть доказанной, и она
 * доказывается по ИСТОЧНИКУ: снимок мог застать соседа посередине, но сам сосед на месте не
 * стоит — он либо доведёт заявку до ездок, либо уберёт её. Дождались, что в источнике скелета
 * больше нет, — значит копия поймала промежуточное состояние, и его место в фикстуре пусто.
 * Остался скелет в источнике насовсем — это уже не гонка, а накопленный мусор либо дефект, и файл
 * падает с перечнем заявок, а не молча выкидывает их.
 *
 * Снимается заявка целиком, а не одна строка деталей: половинка испортила бы фикстуру не хуже
 * скелета. Всё, что за заявку держится, уходит каскадом; держись за неё бумага (`RESTRICT`) —
 * удаление откажет, и это опять же отказ, а не тишина.
 */
async function dropSkeletonRequests(copy: pg.Client, sourceUrl: string): Promise<string[]> {
  const skeletons = async (client: pg.Client, only: string[] | null): Promise<string[]> => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT d.request_id::text AS id
         FROM freight_transport_request_details d
        WHERE ($1::uuid[] IS NULL OR d.request_id = ANY($1::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM vehicle_request_trips t WHERE t.request_id = d.request_id)`,
      [only],
    );
    return rows.map((r) => r.id);
  };

  const ids = await skeletons(copy, null);
  if (ids.length === 0) return [];

  const source = new pg.Client({ connectionString: sourceUrl });
  await source.connect();
  let stuck = ids;
  try {
    const deadline = Date.now() + SKELETON_WAIT_MS;
    for (;;) {
      stuck = await skeletons(source, stuck);
      if (stuck.length === 0 || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await source.end();
  }
  if (stuck.length > 0) {
    throw new Error(
      `Заявок на грузоперевозку без единой ездки в базе-источнике: ${stuck.length} шт., и за ` +
        `${SKELETON_WAIT_MS / 1000} с они никуда не делись — это не гонка со снимком, а лежащий ` +
        `в базе мусор: ${stuck.join(', ')}. Откат за границу ${CUTOVER} на таких заявках ` +
        `невозможен по смыслу (адреса брать неоткуда), и разбирать их надо в источнике.`,
    );
  }

  const removed = await copy.query(`DELETE FROM vehicle_requests WHERE id = ANY($1::uuid[])`, [
    ids,
  ]);
  if (removed.rowCount !== ids.length) {
    throw new Error(
      `С копии снято заявок ${removed.rowCount ?? 0}, а найдено скелетов ${ids.length}`,
    );
  }
  return ids;
}

/** Строка выпуска, которую вставляет нынешний файл миграции: её же ищет teardown. */
function expectedRelease(): { seq: number; version: string } {
  const match = /INSERT INTO app_releases[\s\S]*?VALUES \(\s*(\d+),\s*'([^']+)'/u.exec(
    readMigration(CUTOVER),
  );
  if (!match) throw new Error(`В ${CUTOVER} не нашлась запись выпуска — тест устарел`);
  return { seq: Number(match[1]), version: match[2]! };
}

/**
 * Возврат копии за границу `0136` — тем же путём, каким её откатывал бы выкат.
 *
 * Прямым `psql -f teardown` откат не зовут: файл выполняется вне транзакции, и обрыв посередине
 * оставил бы схему полуразобранной, а тест после этого проверял бы не миграцию, а обломки
 * (протокол выката §7). Штатная команда делает teardown и снятие записи журнала одной транзакцией.
 *
 * Двух препятствий, которые здесь приходится обойти, в плане нет ни одного, и оба — находки:
 *
 * 1. **У `0146` teardown'а не существует**, и так задумано (§12б): позиция роли едет обычным
 *    деплоем, а обратный ход полагается только необратимому бандлу. Но снять `0136`, не сняв
 *    `0146`, нельзя: колонка `0146` живёт в таблице, которую teardown `0136` удаляет целиком, и
 *    запись `0146` осталась бы в журнале без объекта — повторный накат пропустил бы её, а колонки
 *    после него не было бы. Поэтому `0146` снимается здесь руками и **одной транзакцией**, как
 *    протокол требует от всякого снятия миграции.
 * 2. **Копия помнит прежний номер ADR.** В журнале выпусков стоит `0.1.18.0107`, а нынешний файл
 *    `0136` вставляет `0.1.18.0108`; teardown ищет строку выпуска по паре «`seq` + версия» и на
 *    расхождении отказывает целиком. Это ровно тот отказ, о котором §12б предупреждает словами
 *    «накатанный файл миграции неизменяем, правка ломает собственный откат», — и он уже случился:
 *    файл поправили после того, как его накатили на тестовую базу. На копии лечится приведением
 *    строки к тому, что вставит нынешний файл; в проде миграция не накатывалась, и строки нет вовсе.
 */
async function rollbackBeforeCutover(db: pg.Client, copyUrl: string): Promise<void> {
  const release = expectedRelease();
  await db.query('BEGIN');
  try {
    await db.query('ALTER TABLE vehicle_route_point_trips DROP COLUMN position');
    const removed = await db.query('DELETE FROM _migrations WHERE name = $1', [ROLE_POSITIONS]);
    if (removed.rowCount !== 1) {
      throw new Error(`Из журнала снято записей ${ROLE_POSITIONS}: ${removed.rowCount ?? 0}`);
    }
    await db.query('UPDATE app_releases SET version = $2 WHERE seq = $1 AND version <> $2', [
      release.seq,
      release.version,
    ]);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  // Своя база в обеих переменных, а не только в миграционной: приоритет у
  // `DATABASE_MIGRATION_URL`, но промах мимо неё увёл бы teardown в общую базу — а он сносит
  // таблицы. Пусть промах ведёт туда же, куда попадание.
  const env = { ...process.env, DATABASE_MIGRATION_URL: copyUrl, DATABASE_URL: copyUrl };
  delete env.PGSSLROOTCERT;
  const { code, out } = await run('pnpm', ['--silent', 'db:cutover-down', CUTOVER], {
    cwd: apiDir,
    env,
  });
  if (code !== 0) throw new Error(`db:cutover-down ${CUTOVER} отказал: ${out}`);
}

// ── Сценарии «как в проде»: заявки в старой форме, собранный маршрут, выданный лист ───────────

/**
 * Данные, которых в свежей базе не бывает, — в той форме, в какой их застаёт миграция.
 *
 * Заводятся прямым `INSERT` по единственной причине: сегодняшний сервер такого уже не принимает.
 * Адрес без метаданных отклоняет жёсткая модель (ADR 0006), пустой контакт — схема заявки, а
 * колонок, в которые всё это писалось, после `0136` не существует вовсе. Значит либо `INSERT` в
 * откаченную схему, либо тест не о том.
 */
async function seedLegacy(db: pg.Client): Promise<Scenario> {
  const one = async <T extends Row>(sql: string, params: unknown[] = []): Promise<T> => {
    const { rows } = await db.query<T>(sql, params);
    const row = rows[0];
    if (!row) throw new Error(`Пусто там, где ожидалась строка: ${sql.trim().slice(0, 80)}`);
    return row;
  };

  const user = await one<{ id: string }>(
    `SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  const vehicle = await one<{ id: string }>(
    `SELECT id FROM vehicles WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  const person = await one<{ id: string }>(
    `SELECT id FROM persons WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  const organization = await one<{ id: string }>(
    `SELECT id FROM organizations ORDER BY id LIMIT 1`,
  );
  const series = await one<{ id: string }>(
    `SELECT id FROM waybill_series WHERE is_active ORDER BY code LIMIT 1`,
  );
  // Объект с непустыми наименованием и адресом: из них бэкфил склеивает адрес точки линейного дня,
  // и пустой он быть не может — у точки CHECK на непустой адрес (предохранитель миграции).
  const object = await one<{ id: string; location: string }>(`
    SELECT id, btrim(concat_ws(', ', nullif(btrim(name), ''), nullif(btrim(address), ''))) AS location
    FROM construction_objects
    WHERE is_active AND btrim(name) <> '' AND btrim(address) <> ''
    ORDER BY code LIMIT 1`);
  const freightType = await one<{ id: string }>(`
    SELECT vt.id FROM vehicle_types vt
    JOIN vehicle_kinds vk ON vk.id = vt.kind_id
    WHERE vk.code = 'freight_transport' ORDER BY vt.name LIMIT 1`);
  const linearType = await one<{ id: string }>(`
    SELECT vt.id FROM vehicle_types vt
    JOIN vehicle_kinds vk ON vk.id = vt.kind_id
    WHERE vk.code <> 'freight_transport' ORDER BY vt.name LIMIT 1`);

  const freight = async (
    status: string,
    details: {
      from: string;
      to: string;
      fromAddress: string | null;
      toAddress: string | null;
      volume: number | null;
      weight: number | null;
      contacts: boolean;
    },
    deleted = false,
  ): Promise<string> => {
    const request = await one<{ id: string }>(
      `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                     deleted_at, deleted_by)
       VALUES ('freight_transport', $1, $2, $3::request_status, $4,
               CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $4::uuid END)
       RETURNING id`,
      [object.id, freightType.id, status, user.id, deleted],
    );
    await db.query(
      `INSERT INTO freight_transport_request_details (
         request_id, scheduled_at, loading_location, unloading_location,
         loading_address, unloading_address, volume_m3, weight_tons,
         loading_responsible_name, loading_responsible_phone,
         unloading_responsible_name, unloading_responsible_phone)
       VALUES ($1, now(), $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        request.id,
        details.from,
        details.to,
        details.fromAddress,
        details.toAddress,
        details.volume,
        details.weight,
        details.contacts ? 'Иванов Иван' : '',
        details.contacts ? '9990000001' : '',
        details.contacts ? 'Петров Пётр' : '',
        details.contacts ? '9990000002' : '',
      ],
    );
    return request.id;
  };

  /** Адрес из подсказки DaData — так его пишет сегодняшняя форма (`resolved` + ФИАС, ADR 0006). */
  const dadata = (fias: string) => JSON.stringify({ source: 'resolved', fiasId: fias });
  /** Адрес, выбранный записью справочника объектов (ADR 0069). */
  const atObject = JSON.stringify({ source: 'object', refId: object.id });

  const working = await freight('confirmed', {
    from: 'Карьер Сычёво',
    to: object.location,
    fromAddress: dadata('11111111-1111-4111-8111-111111111111'),
    toAddress: atObject,
    volume: 12.5,
    weight: null,
    contacts: true,
  });
  const closed = await freight('done', {
    from: 'Склад №4',
    to: 'Полигон Тимохово',
    fromAddress: dadata('22222222-2222-4222-8222-222222222222'),
    toAddress: dadata('33333333-3333-4333-8333-333333333333'),
    volume: null,
    weight: 8,
    contacts: true,
  });
  const archived = await freight(
    'cancelled',
    {
      from: 'База механизации',
      to: object.location,
      fromAddress: dadata('44444444-4444-4444-8444-444444444444'),
      toAddress: atObject,
      volume: 3,
      weight: null,
      contacts: true,
    },
    true,
  );
  const papered = await freight('confirmed', {
    from: 'Бетонный узел',
    to: object.location,
    fromAddress: dadata('55555555-5555-4555-8555-555555555555'),
    toAddress: atObject,
    volume: 7,
    weight: 1.25,
    contacts: true,
  });
  // Заявка старше ADR 0006 и миграции 0062: адрес строкой без метаданных, контактов нет вовсе.
  // Сегодня такую не завести ни формой, ни ручкой — а в базе их четыре из пяти с половиной сотен.
  const legacy = await freight('confirmed', {
    from: 'ул. Полевая, 3',
    to: 'ул. Заводская, 12',
    fromAddress: null,
    toAddress: null,
    volume: 5,
    weight: null,
    contacts: false,
  });

  const linear = await one<{ id: string }>(
    `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
     VALUES ('special_equipment', $1, $2, 'confirmed', $3) RETURNING id`,
    [object.id, linearType.id, user.id],
  );
  await db.query(
    `INSERT INTO special_equipment_request_details (request_id, date_from, date_to,
                                                    responsible_name, responsible_phone)
     VALUES ($1, CURRENT_DATE + 700, CURRENT_DATE + 700, 'Сидоров Семён', '9990000003')`,
    [linear.id],
  );

  const route = await one<{ id: string; route_date: string }>(
    `INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, created_by, driver_person_id)
     VALUES ($1, CURRENT_DATE + 700, 'freight', $2, $3) RETURNING id, route_date`,
    [vehicle.id, user.id, person.id],
  );
  // Состав смешанный — ровно тот случай, ради которого §5.6 раскладывает строки по-разному: две
  // грузовые заявки дают по две точки, линейный день — одну.
  await db.query(
    `INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
     VALUES ($1, $2, 1, NULL), ($1, $3, 2, NULL), ($1, $4, 3, $5::date)`,
    [route.id, working, papered, linear.id, route.route_date],
  );

  /*
   * Выданный лист: печатается он из снимка `waybills.data`, а не из заявки, — и именно поэтому
   * снимок наполняется адресами ЗАЯВКИ на момент выписки. Разойдись он с ездкой после миграции —
   * тест это увидит, а бумага у заказчика на руках останется прежней.
   */
  const printed = {
    task_from: 'Бетонный узел',
    task_to: object.location,
    task_cargo: '7 м³',
    task2_line: object.location,
    driver_fio: 'Водителев Водитель Водителевич',
  };
  const waybill = await one<{ id: string }>(
    `INSERT INTO waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                           driver_person_id, issued_for_date, route_id, issued_by, data)
     SELECT $1, coalesce(max(number), 0) + 1, '4p', 'issued', $2, $3, $4, $5::date, $6, $7, $8::jsonb
     FROM waybills WHERE series_id = $1
     RETURNING id`,
    [
      series.id,
      organization.id,
      vehicle.id,
      person.id,
      route.route_date,
      route.id,
      user.id,
      JSON.stringify(printed),
    ],
  );
  // Талон выписан на строку задания: у грузовой заявки — первая строка (Р20), у линейного дня
  // строка есть, а ездки нет и не будет, и в счёт `waybill_trips` он не входит (§5.6).
  await db.query(
    `INSERT INTO waybill_requests (waybill_id, request_id, slot) VALUES ($1, $2, 1), ($1, $3, 2)`,
    [waybill.id, papered, linear.id],
  );

  return {
    working,
    closed,
    archived,
    papered,
    legacy,
    linear: linear.id,
    routeId: route.id,
    waybillId: waybill.id,
    objectLocation: object.location,
  };
}

// ── Снимки ────────────────────────────────────────────────────────────────────────────────────

async function detailsSnapshot(db: pg.Client): Promise<Map<string, LegacyDetails>> {
  const { rows } = await db.query<LegacyDetails>(`
    SELECT request_id::text AS request_id, loading_location, unloading_location,
           loading_address::text AS loading_address, unloading_address::text AS unloading_address,
           volume_m3::text AS volume_m3, weight_tons::text AS weight_tons,
           loading_responsible_name, loading_responsible_phone,
           unloading_responsible_name, unloading_responsible_phone
    FROM freight_transport_request_details`);
  return new Map(rows.map((r) => [r.request_id, r]));
}

/**
 * Отпечаток печатных данных всех листов сразу.
 *
 * Считается в базе, а не в тесте: снимков две с половиной тысячи и пять с лишним мегабайт, и
 * тащить их в память ради сравнения незачем. Отпечаток отвечает на вопрос «пересобиралось ли
 * хоть что-нибудь» целиком по журналу бланков, а не по одному листу сценария.
 */
async function printSnapshot(db: pg.Client): Promise<PrintDigest> {
  const { rows } = await db.query<PrintDigest>(`
    SELECT count(*)::text AS waybills,
           coalesce(sum(octet_length(data::text)), 0)::text AS bytes,
           coalesce(md5(string_agg(id::text || ':' || data::text, E'\\n' ORDER BY id)), '') AS digest
    FROM waybills`);
  return rows[0]!;
}

async function printedTask(db: pg.Client, waybillId: string): Promise<string> {
  const { rows } = await db.query<{ data: string }>(
    `SELECT data::text AS data FROM waybills WHERE id = $1`,
    [waybillId],
  );
  return rows[0]!.data;
}

// ── Подготовка: копия, откат, сценарии, снимки, накат ─────────────────────────────────────────

beforeAll(async () => {
  if (!DB_URL) return;
  const copyUrl = copyUrlOf(DB_URL);
  const copyName = databaseNameOf(copyUrl);

  const admin = new pg.Client({ connectionString: maintenanceUrlOf(DB_URL) });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${copyName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${copyName}`);
  } finally {
    await admin.end();
  }
  await copyDatabase(DB_URL, copyUrl);

  const db = new pg.Client({ connectionString: copyUrl });
  await db.connect();
  // До отката: скелеты соседей откат и роняют, а после него их уже не распознать — колонок ездок
  // в откаченной схеме нет.
  const skeletons = await dropSkeletonRequests(db, DB_URL);
  await rollbackBeforeCutover(db, copyUrl);

  const scenario = await seedLegacy(db);
  const detailsBefore = await detailsSnapshot(db);
  const printBefore = await printSnapshot(db);
  const printedTaskBefore = await printedTask(db, scenario.waybillId);
  const { rows: waybillRequestsBefore } = await db.query<{ request_id: string; slot: number }>(
    `SELECT request_id::text AS request_id, slot FROM waybill_requests
     WHERE waybill_id = $1 ORDER BY slot`,
    [scenario.waybillId],
  );

  /*
   * Заявка на грузоперевозку без строки деталей — до всякого другого наката.
   *
   * Проверяется здесь не сообщение, а решение: миграция обязана УПАСТЬ. Заглушка («заведём ездку с
   * пустыми адресами») сделала бы такую заявку неотличимой от нормальной, а восстановить её было бы
   * уже нечем — колонки-источники удаляет та же миграция.
   */
  const orphanRequest = await db.query<{ id: string }>(
    `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
     SELECT 'freight_transport', d.object_id, d.vehicle_type_id, 'new', d.created_by
     FROM vehicle_requests d WHERE d.id = $1 RETURNING id`,
    [scenario.working],
  );
  let orphanMessage = '';
  let orphanTrace = '';
  try {
    await applyMigrations(db);
  } catch (e) {
    orphanMessage = e instanceof Error ? e.message : String(e);
    orphanTrace = String(e);
  }
  const { rows: journalAfterOrphan } = await db.query<{ name: string }>(
    `SELECT name FROM _migrations WHERE name = $1`,
    [CUTOVER],
  );
  const { rows: tablesAfterOrphan } = await db.query<{ trips: string | null }>(
    `SELECT to_regclass('public.vehicle_request_trips')::text AS trips`,
  );
  const orphan = {
    message: orphanMessage,
    applied: journalAfterOrphan.length > 0,
    tripsTable: tablesAfterOrphan[0]!.trips,
    trace: orphanTrace,
  };
  await db.query(`DELETE FROM vehicle_requests WHERE id = $1`, [orphanRequest.rows[0]!.id]);

  const applied = await applyMigrations(db);

  const { rows: trips } = await db.query<MigratedTrip>(`
    SELECT request_id::text AS request_id, num, from_location, to_location,
           from_address::text AS from_address, to_address::text AS to_address,
           volume_m3::text AS volume_m3, weight_tons::text AS weight_tons,
           from_responsible_name, from_responsible_phone,
           to_responsible_name, to_responsible_phone
    FROM vehicle_request_trips ORDER BY request_id, num`);
  const tripsAfter = new Map<string, MigratedTrip[]>();
  for (const trip of trips) {
    const list = tripsAfter.get(trip.request_id) ?? [];
    list.push(trip);
    tripsAfter.set(trip.request_id, list);
  }

  const counts = await db.query<{
    trips: string;
    details: string;
    links: string;
    freight: string;
  }>(`
    SELECT (SELECT count(*) FROM vehicle_request_trips)::text AS trips,
           (SELECT count(*) FROM freight_transport_request_details)::text AS details,
           (SELECT count(*) FROM waybill_trips)::text AS links,
           (SELECT count(*) FROM waybill_requests wr
              JOIN vehicle_requests r ON r.id = wr.request_id
             WHERE r.request_type = 'freight_transport')::text AS freight`);

  const { rows: pointsAfter } = await db.query<{
    position: number;
    location: string;
    role: string;
    request_id: string;
  }>(
    `SELECT p.position, p.location, pt.role, pt.request_id::text AS request_id
     FROM vehicle_route_points p
     JOIN vehicle_route_point_trips pt ON pt.point_id = p.id
     WHERE p.route_id = $1 ORDER BY p.position, pt.position`,
    [scenario.routeId],
  );
  const { rows: waybillTripsAfter } = await db.query<{
    slot: number;
    request_id: string;
    num: number;
  }>(
    `SELECT wt.slot, t.request_id::text AS request_id, t.num
     FROM waybill_trips wt JOIN vehicle_request_trips t ON t.id = wt.trip_id
     WHERE wt.waybill_id = $1 ORDER BY wt.slot`,
    [scenario.waybillId],
  );

  ctx = {
    db,
    copyUrl,
    scenario,
    detailsBefore,
    printBefore,
    printedTaskBefore,
    waybillRequestsBefore,
    orphan,
    skeletons,
    applied,
    tripsAfter,
    tripCount: Number(counts.rows[0]!.trips),
    detailCount: Number(counts.rows[0]!.details),
    pointsAfter,
    waybillTripsAfter,
    waybillTripsTotal: Number(counts.rows[0]!.links),
    freightWaybillRequests: Number(counts.rows[0]!.freight),
    printAfter: await printSnapshot(db),
    printedTaskAfter: await printedTask(db, scenario.waybillId),
  };
}, 600_000);

afterAll(async () => {
  if (!ctx) return;
  await ctx.db.end();
  const admin = new pg.Client({ connectionString: maintenanceUrlOf(DB_URL!) });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseNameOf(ctx.copyUrl)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

/** Ездка заявки, о которой спрашивают: у каждой из сценарных она обязана быть ровно одна. */
function onlyTrip(requestId: string): MigratedTrip {
  const trips = ctx.tripsAfter.get(requestId) ?? [];
  expect(trips).toHaveLength(1);
  return trips[0]!;
}

/** Ездка против прежней строки деталей: поле в поле, включая «пусто» и «метаданных нет». */
function expectTripMatchesDetails(requestId: string): void {
  const before = ctx.detailsBefore.get(requestId);
  expect(before, 'снимок строки деталей до миграции').toBeTruthy();
  const trip = onlyTrip(requestId);
  expect({
    from: trip.from_location,
    to: trip.to_location,
    fromAddress: trip.from_address,
    toAddress: trip.to_address,
    volume: trip.volume_m3,
    weight: trip.weight_tons,
    fromName: trip.from_responsible_name,
    fromPhone: trip.from_responsible_phone,
    toName: trip.to_responsible_name,
    toPhone: trip.to_responsible_phone,
  }).toEqual({
    from: before!.loading_location,
    to: before!.unloading_location,
    fromAddress: before!.loading_address,
    toAddress: before!.unloading_address,
    volume: before!.volume_m3,
    weight: before!.weight_tons,
    fromName: before!.loading_responsible_name,
    fromPhone: before!.loading_responsible_phone,
    toName: before!.unloading_responsible_name,
    toPhone: before!.unloading_responsible_phone,
  });
  // Номер первой ездки — «ТС-N/1»: им заявка называется в листе и в истории, и другого у неё нет.
  expect(trip.num).toBe(1);
}

describe.skipIf(!DB_URL)('миграция накатывается на накопленное', () => {
  /** Обе миграции переработки — и ни одной чужой: копия отстала ровно на них. */
  it('накатываются ровно 0136 и 0146', () => {
    expect(ctx.applied).toEqual([CUTOVER, ROLE_POSITIONS]);
  });

  /**
   * Заявка на грузоперевозку без строки деталей роняет миграцию (§5.7).
   *
   * Предохранитель стоит ПЕРВЫМ действием файла — до создания таблиц, — и проверяется здесь именно
   * это: после отказа в базе не осталось ни записи журнала, ни половины схемы. Транзакция на файл
   * (`applyMigrations`) держит это физически, но цена ошибки такова, что подтвердить стоит: накат
   * «наполовину» означал бы, что повторный заход упадёт уже на `CREATE TABLE`, и разбираться с этим
   * пришлось бы в окне выката, при лежащих сервисах.
   */
  it('заявка без строки деталей роняет миграцию, а не создаёт заглушку', () => {
    expect(ctx.orphan.message, ctx.orphan.trace).toContain('без строки деталей');
    expect(ctx.orphan.applied, 'запись журнала после отказа').toBe(false);
    expect(ctx.orphan.tripsTable, 'таблица ездок после отказа').toBeNull();
  });

  /** Верификатор релиза (`.verify`, §5.6) — read-only и fail-closed: он и есть приёмка бэкфила. */
  it('верификатор релиза проходит на перенесённых данных', async () => {
    const env = { ...process.env, DATABASE_MIGRATION_URL: ctx.copyUrl, DATABASE_URL: ctx.copyUrl };
    delete env.PGSSLROOTCERT;
    const { code, out } = await run('pnpm', ['--silent', 'backfill:trips', '--check'], {
      cwd: apiDir,
      env,
    });
    expect(code, out).toBe(0);
  }, 120_000);
});

describe.skipIf(!DB_URL)('заявки переживают миграцию', () => {
  /**
   * Ездка на каждую строку деталей — счётом по всей базе, а не по сценарию.
   *
   * Тот же счёт стоит предохранителем внутри миграции, и повторяется он здесь не зря: там он
   * решает, применять ли файл, а тут — что накопленное действительно доехало. Провались он у
   * миграции, тест до этой строки бы не дошёл; сойдись он у миграции и разойдись здесь — значит
   * ездки завелись не тем заявкам.
   */
  it('у каждой грузовой заявки ровно одна ездка', () => {
    // Снятые скелеты — в сообщении: разойдись числа, первым делом спросят, что убрали с копии.
    const note = `скелетов снято с копии: ${ctx.skeletons.length}${
      ctx.skeletons.length > 0 ? ` (${ctx.skeletons.join(', ')})` : ''
    }`;
    expect(ctx.tripCount, note).toBe(ctx.detailCount);
    const wrong = [...ctx.tripsAfter].filter(([, trips]) => trips.length !== 1).map(([id]) => id);
    expect(wrong, 'заявки, у которых ездок не одна').toEqual([]);
    expect(ctx.tripsAfter.size, note).toBe(ctx.detailCount);
  });

  /**
   * Адреса, количество и контакты — те же, что были, у **всех** заявок базы.
   *
   * Сверка по снимку, а не по ожидаемым значениям: у накопленных заявок значения неизвестны и
   * никого не интересуют, вопрос ровно один — совпадают ли они с прежними.
   */
  it('адреса, количество и контакты доезжают без единого расхождения', () => {
    const diverged: string[] = [];
    for (const [requestId, before] of ctx.detailsBefore) {
      const trip = ctx.tripsAfter.get(requestId)?.[0];
      if (
        !trip ||
        trip.from_location !== before.loading_location ||
        trip.to_location !== before.unloading_location ||
        trip.from_address !== before.loading_address ||
        trip.to_address !== before.unloading_address ||
        trip.volume_m3 !== before.volume_m3 ||
        trip.weight_tons !== before.weight_tons ||
        trip.from_responsible_name !== before.loading_responsible_name ||
        trip.from_responsible_phone !== before.loading_responsible_phone ||
        trip.to_responsible_name !== before.unloading_responsible_name ||
        trip.to_responsible_phone !== before.unloading_responsible_phone
      ) {
        diverged.push(requestId);
      }
    }
    expect(diverged, 'заявки, у которых ездка разошлась со строкой деталей').toEqual([]);
  });

  it('заявка в работе: ездка с прежними адресами, количеством и контактами', () => {
    expectTripMatchesDetails(ctx.scenario.working);
  });

  it('закрытая заявка переносится наравне с работающей', () => {
    expectTripMatchesDetails(ctx.scenario.closed);
  });

  /**
   * Архивная заявка (`deleted_at`) — тот случай, где фильтр «только живые» был бы естественным и
   * неверным: её карточку открывают и печатают, а без ездки она стала бы пустой. Фильтра в бэкфиле
   * нет намеренно (§5.7), и проверяется здесь не только ездка, но и то, что архив остался архивом.
   */
  it('архивная заявка переносится, оставаясь архивной', async () => {
    expectTripMatchesDetails(ctx.scenario.archived);
    const { rows } = await ctx.db.query<{ deleted: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted FROM vehicle_requests WHERE id = $1`,
      [ctx.scenario.archived],
    );
    expect(rows[0]!.deleted).toBe(true);
  });

  it('заявка с выданным листом переносится, не трогая лист', () => {
    expectTripMatchesDetails(ctx.scenario.papered);
  });

  /**
   * Заявка старше ADR 0006 и миграции `0062`: адреса без метаданных, контакты пустой строкой.
   *
   * Счётом такая не ловится — это законное состояние, а не пропуск (§5.7), — и потому ей нужен
   * отдельный случай. Бэкфил обязан принести её КАК ЕСТЬ: не подставить `manual` в метаданные и не
   * выдумать ответственного. Правимость таких заявок дальше держит сервер (Р2а).
   */
  it('заявка без метаданных адреса и с пустым контактом доезжает как есть', () => {
    expectTripMatchesDetails(ctx.scenario.legacy);
    const trip = onlyTrip(ctx.scenario.legacy);
    expect(trip.from_address).toBeNull();
    expect(trip.to_address).toBeNull();
    expect(trip.from_responsible_name).toBe('');
    expect(trip.to_responsible_phone).toBe('');
  });

  /** У заказа техники ездок не бывает: линейная заявка их не получает (это же спрашивает верификатор). */
  it('линейная заявка ездок не получает', () => {
    expect(ctx.tripsAfter.get(ctx.scenario.linear)).toBeUndefined();
  });
});

describe.skipIf(!DB_URL)('собранный до релиза маршрут', () => {
  /**
   * Раскладка смешанного состава (§5.6): грузовая строка — две точки, линейный день — одна.
   *
   * Порядок объезда повторяет порядок строк состава, а внутри строки — «сначала грузим, потом
   * везём». Это и есть «порядок не меняется»: до миграции порядок задавала позиция строки состава,
   * после — позиция точки, и вторая обязана читаться как первая. Разойдись они — лист напечатал бы
   * заявки в другом порядке, то есть талоны достались бы не тем заказчикам (Р12, ADR 0068 п. 2).
   */
  it('две роли на грузовую строку, одна на линейный день, порядок прежний', () => {
    expect(ctx.pointsAfter.map((p) => `${p.position}:${p.location}[${p.role}]`)).toEqual([
      `1:Карьер Сычёво[load]`,
      `2:${ctx.scenario.objectLocation}[unload]`,
      `3:Бетонный узел[load]`,
      `4:${ctx.scenario.objectLocation}[unload]`,
      `5:${ctx.scenario.objectLocation}[work]`,
    ]);
    // Роли принадлежат своим заявкам: порядок мог бы совпасть и при перепутанных строках задания.
    expect(ctx.pointsAfter.map((p) => p.request_id)).toEqual([
      ctx.scenario.working,
      ctx.scenario.working,
      ctx.scenario.papered,
      ctx.scenario.papered,
      ctx.scenario.linear,
    ]);
  });

  /**
   * Подряд идущие одинаковые адреса не склеиваются (§5.6): две разгрузки на одном объекте и работа
   * линейного дня там же — три точки, а не одна. Бэкфил не принимает решений за диспетчера:
   * совмещение — явное действие человека (Р9а), и сделанное миграцией «за него» пришлось бы
   * разносить обратно вручную, не зная, что именно было склеено.
   */
  it('один и тот же адрес не склеивается в одну точку', () => {
    const atObject = ctx.pointsAfter.filter((p) => p.location === ctx.scenario.objectLocation);
    expect(atObject.map((p) => p.position)).toEqual([2, 4, 5]);
  });
});

describe.skipIf(!DB_URL)('выданные листы', () => {
  /**
   * Связь «лист ↔ ездка» у старых листов: тот же `slot`, та же единственная ездка заявки (§5.5).
   *
   * Линейная строка в счёт не входит и входить не может — ездки у дня нет и не будет, — поэтому
   * отбор бэкфила сужен видом заявки, а не «всеми талонами листа».
   */
  it('у старого листа появились строки waybill_trips с прежним slot', () => {
    expect(ctx.waybillRequestsBefore.map((r) => r.slot)).toEqual([1, 2]);
    expect(ctx.waybillTripsAfter).toEqual([{ slot: 1, request_id: ctx.scenario.papered, num: 1 }]);
  });

  /** Тот же счёт по всей базе: строка на каждый талон грузовой заявки — и ни одной сверх. */
  it('строк «лист ↔ ездка» ровно столько, сколько талонов грузовых заявок', () => {
    expect(ctx.waybillTripsTotal).toBe(ctx.freightWaybillRequests);
  });

  /**
   * ГЛАВНОЕ ЗДЕСЬ. Выданный лист печатается из снимка `waybills.data`, и миграция его не трогает —
   * значит бумага, лежащая у заказчика, и лист, распечатанный после выката, обязаны совпасть **байт
   * в байт**. Не «примерно те же адреса»: бланк строгой отчётности с номером серии — документ, а
   * не отчёт, и пересобранный из новых данных он перестал бы быть тем, что подписали.
   *
   * Сверяется весь журнал разом (число листов, объём и отпечаток), а не один лист сценария:
   * пересборка задела бы не тот лист, о котором тест знает, а любой.
   */
  it('снимок листа не пересобран: журнал бланков байт в байт прежний', () => {
    expect(ctx.printAfter).toEqual(ctx.printBefore);
    expect(ctx.printedTaskAfter).toBe(ctx.printedTaskBefore);
    // Отпечаток пустого журнала совпал бы сам собой — сверка обязана быть о чём-то.
    expect(Number(ctx.printBefore.waybills)).toBeGreaterThan(0);
    expect(Number(ctx.printBefore.bytes)).toBeGreaterThan(0);
  });
});
