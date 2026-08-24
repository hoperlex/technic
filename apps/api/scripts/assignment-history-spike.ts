import { generateKeyPairSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  esm2Periods,
  shiftDateKey,
  weekStartKey,
  type Esm2Period,
  type VehicleOwnership,
} from '@technic/contracts';
// Настоящие свёртка и план бумаги (волны 1.1 и 1.2). Импорт статический: оба модуля чистые — ни
// конфига, ни базы, ни env при загрузке, — в отличие от `waybill-esm2.ts` в §3, который читает
// конфиг при импорте и потому подтягивается динамически.
import {
  type AssignmentChangeRow,
  assignmentSegments,
} from '../src/services/assignment-history';
import { esm2SheetPlan } from '../src/services/esm2-plan';

/**
 * Нагрузочный спайк периодов назначения — этап 1 плана `docs/assignment-periods-plan.md`.
 *
 * Зачем. План принял два решения по интуиции, и оба стоят денег: оценку трудоёмкости этапа 3
 * («самый тяжёлый, 10–15 дней») и уровень изоляции `REPEATABLE READ` с протоколом повторов и
 * отказом 503 после трёх `40001` (Б5, В4, §14c). Спайк меряет то, на чём эти решения стоят:
 * сколько строк истории живёт у многолетней заявки, во что обходится их чтение и свёртка, во что
 * обходится построение плана листов и как часто конкуренция действительно даёт `40001`.
 *
 * ЧТО ДЕЛАЕТ С БАЗОЙ. Пишет: заводит свою таблицу `vehicle_request_assignment_changes` **копией
 * DDL из §6 плана** и набивает её синтетикой. Миграции здесь нет и быть не может: номера миграций
 * берутся непосредственно перед выкатом (Г5 плана), и файл в `drizzle/` занял бы номер, который
 * параллельные потоки уже дважды уводили. Поэтому таблица создаётся прямо отсюда, и запускать
 * скрипт можно **только на выделенной базе**, а не на боевой и не на общей тестовой.
 *
 * Синтетика владеет своими строками и переписывает их при каждом запуске: заявки помечены
 * `comment = 'ap-spike'`, и всё, что найдено по этой метке, перед прогоном удаляется. Чужого
 * скрипт не трогает.
 *
 * Использование:
 *
 *   psql -h 127.0.0.1 -p 5433 -U technic -d postgres -c 'create database ap_spike'
 *   psql ... -d ap_spike -c 'create extension if not exists citext' \
 *                        -c 'create extension if not exists pg_trgm'
 *   DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/ap_spike \
 *     pnpm --filter @technic/api exec tsx src/db/migrate.ts apply
 *   DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/ap_spike \
 *     pnpm --filter @technic/api exec tsx scripts/assignment-history-spike.ts
 *
 * Ручки (env): `SPIKE_FILL_STAGES` — уровни наполнения фона через запятую (число заявок),
 * `SPIKE_TRIALS` — число прогонов каждого сценария конкуренции, `SPIKE_REPEAT` — число повторов
 * каждого замера времени.
 */

/*
 * `date` из pg приходит объектом `Date` в часовом поясе процесса, и свёртка сравнивала бы уже не
 * ключи дней. Прикладной код живёт на ключах `YYYY-MM-DD` (drizzle отдаёт `date` строкой), и здесь
 * нужно то же самое: OID 1082 — это `date`.
 */
pg.types.setTypeParser(1082, (value: string) => value);

// ───────────────────────────── параметры прогона ─────────────────────────────

/**
 * Срок многолетней заявки: три года ровно, от понедельника до воскресенья — 1085 дней, 155 недель.
 * Взят так, чтобы «сегодня» (август 2026) попадало внутрь: у сверки тогда работают обе ветви —
 * отработанные недели, которые трогать нельзя, и предстоящие, которые она вправе переписать.
 */
const TERM_FROM = '2025-01-06';
const TERM_TO = '2027-12-26';

/**
 * Частота замен из задания: машинист — раз в 2–3 недели, машина — раз в два месяца. Числа не
 * круглые намеренно: шаг 17 и 61 день гоняет замены по всем дням недели, а не сажает их на
 * понедельник, где они не режут ни одного листа.
 */
const DRIVER_EVERY_DAYS = 17;
const VEHICLE_EVERY_DAYS = 61;

/** Каждое N-е изменение было один раз исправлено: это и есть погашенные строки (Р3, Р10). */
const CORRECTED_EVERY = 8;

/** Уровни наполнения фона: столько «прочих» заявок с историей лежит в таблице к моменту замера. */
const FILL_STAGES = (process.env.SPIKE_FILL_STAGES ?? '3000,10000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Строк истории у фоновой заявки: средняя заявка живёт месяцами, а не годами. */
const BACKGROUND_ROWS = 30;

/** Сколько раз повторяется каждый замер времени; берётся медиана. */
const REPEAT = Number(process.env.SPIKE_REPEAT ?? 200);

/** Сколько прогонов у каждого сценария конкуренции. */
const TRIALS = Number(process.env.SPIKE_TRIALS ?? 40);

/**
 * Потолок повторов из В4: «три неудачных `40001` подряд — 503». Читается это двояко (три попытки
 * или четыре), поэтому скрипт кладёт потолок повыше и печатает **гистограмму** попыток: по ней
 * читается любой из двух вариантов.
 */
const MAX_ATTEMPTS = 8;

/** Сколько писателей одновременно правят одну заявку — прямая проверка потолка повторов. */
const WRITER_COUNTS = [2, 3, 4, 6, 8];

const MARKER = 'ap-spike';

// ───────────────────────────── подключение ─────────────────────────────

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Не задан DATABASE_URL: спайку нужна ОТДЕЛЬНАЯ база (см. шапку файла)');
  return url;
}

/**
 * Отдельный клиент на каждый вызов: сценариям конкуренции нужно несколько **разных** соединений,
 * иначе транзакции выстроятся в очередь на одном и конкуренции не получится вовсе.
 *
 * `sslmode` из строки вычищается по той же причине, что и в `src/db/migration-client.ts`:
 * node-postgres его не читает, и оставленный в URL параметр молча ничего не включает.
 */
function buildClient(): pg.Client {
  const url = new URL(databaseUrl());
  url.searchParams.delete('sslmode');
  return new pg.Client({ connectionString: url.toString(), ssl: false });
}

async function connected(): Promise<pg.Client> {
  const client = buildClient();
  await client.connect();
  return client;
}

// ───────────────────────────── схема из §6 плана ─────────────────────────────

/**
 * DDL истории — копия §6 плана, слово в слово, включая все CHECK'и и частичные индексы. Индексы
 * вынесены отдельными командами: замер «с индексом и без него» их снимает и возвращает.
 */
const HISTORY_DDL = `
create table if not exists vehicle_request_assignment_changes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references vehicle_requests(id) on delete cascade,
  effective_date date not null,
  dimension text not null check (dimension in ('vehicle', 'driver')),
  vehicle_id uuid references vehicles(id) on delete restrict,
  driver_person_id uuid references persons(id) on delete restrict,
  driver_state text check (driver_state in ('set', 'cleared', 'unknown')),
  origin text not null
    check (origin in ('assignment', 'reassignment', 'machinist_change', 'backfill',
                      'tail_resolution', 'known_fill', 'unknown_remainder')),
  change_group_id uuid not null default gen_random_uuid(),
  correction_id uuid references waybill_corrections(id) on delete restrict,
  created_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  supersedes_change_id uuid,
  superseded_at timestamptz,
  superseded_by_user uuid references users(id) on delete restrict,
  superseded_kind text check (superseded_kind in ('replaced', 'cancelled')),
  constraint vehicle_request_assignment_changes_value_check check (
    (dimension = 'vehicle' and vehicle_id is not null and driver_person_id is null
      and driver_state is null)
    or (dimension = 'driver' and vehicle_id is null and driver_state is not null
      and (driver_state = 'set') = (driver_person_id is not null))
  ),
  constraint vehicle_request_assignment_changes_supersede_check check (
    (superseded_at is null and superseded_by_user is null and superseded_kind is null)
    or (superseded_at is not null and superseded_by_user is not null and superseded_kind is not null)
  ),
  constraint vehicle_request_assignment_changes_self_check
    check (supersedes_change_id is null or supersedes_change_id <> id),
  constraint vehicle_request_assignment_changes_unknown_check check (
    driver_state <> 'unknown'
    or (origin = 'backfill' and correction_id is null)
    or (origin = 'unknown_remainder' and correction_id is not null)
  ),
  constraint vehicle_request_assignment_changes_remainder_check check (
    origin <> 'unknown_remainder'
    or (dimension = 'driver' and driver_state = 'unknown' and correction_id is not null)
  ),
  constraint vehicle_request_assignment_changes_known_fill_check check (
    origin <> 'known_fill'
    or (dimension = 'driver' and driver_state = 'set'
        and driver_person_id is not null and correction_id is not null)
  ),
  constraint vehicle_request_assignment_changes_identity_unique
    unique (id, request_id, dimension, effective_date),
  constraint vehicle_request_assignment_changes_supersedes_fk
    foreign key (supersedes_change_id, request_id, dimension, effective_date)
    references vehicle_request_assignment_changes (id, request_id, dimension, effective_date)
);`;

const INDEX_DDL: Record<string, string> = {
  vehicle_request_assignment_changes_actual_unique: `
    create unique index if not exists vehicle_request_assignment_changes_actual_unique
      on vehicle_request_assignment_changes (request_id, dimension, effective_date)
      where superseded_at is null`,
  vehicle_request_assignment_changes_supersedes_unique: `
    create unique index if not exists vehicle_request_assignment_changes_supersedes_unique
      on vehicle_request_assignment_changes (supersedes_change_id)
      where supersedes_change_id is not null`,
  vehicle_request_assignment_changes_request_idx: `
    create index if not exists vehicle_request_assignment_changes_request_idx
      on vehicle_request_assignment_changes (request_id, effective_date)`,
  vehicle_request_assignment_changes_group_idx: `
    create index if not exists vehicle_request_assignment_changes_group_idx
      on vehicle_request_assignment_changes (request_id, change_group_id)`,
  vehicle_request_assignment_changes_group_dimension_unique: `
    create unique index if not exists vehicle_request_assignment_changes_group_dimension_unique
      on vehicle_request_assignment_changes (change_group_id, dimension)
      where superseded_at is null and origin <> 'unknown_remainder'`,
  vehicle_request_assignment_changes_group_remainder_unique: `
    create unique index if not exists vehicle_request_assignment_changes_group_remainder_unique
      on vehicle_request_assignment_changes (change_group_id)
      where superseded_at is null and origin = 'unknown_remainder'`,
};

async function ensureHistorySchema(client: pg.Client): Promise<void> {
  await client.query(HISTORY_DDL);
  for (const ddl of Object.values(INDEX_DDL)) await client.query(ddl);
}

// ───────────────────────────── справочники и заявки ─────────────────────────────

interface Fixture {
  userId: string;
  objectId: string;
  organizationId: string;
  vehicleTypeId: string;
  vehicleIds: string[];
  personIds: string[];
  seriesId: string;
  /** Многолетняя заявка, на которой меряется объём, выборка и сверка. */
  targetRequestId: string;
  /** Отдельная заявка под сценарии конкуренции: её историю каждый прогон переписывают заново. */
  concRequestId: string;
}

async function seed(client: pg.Client): Promise<Fixture> {
  // Свои строки — под метку: повторный запуск обязан начинать с чистого листа, а чужого не
  // касаться. `on delete cascade` у истории снимает её вместе с заявками; сама таблица истории
  // целиком принадлежит спайку, и её лучше усечь — иначе мёртвые версии прошлых прогонов раздуют
  // файл и завысят цену последовательного чтения, которую мы как раз и меряем.
  await client.query('truncate table vehicle_request_assignment_changes');
  await client.query(
    `delete from waybills where series_id in (select id from waybill_series where comment = $1)`,
    [MARKER],
  );
  await client.query(`delete from vehicle_requests where comment = $1`, [MARKER]);
  await client.query(`delete from vehicles where note = $1`, [MARKER]);
  await client.query(`delete from persons where comment = $1`, [MARKER]);
  await client.query(`delete from waybill_series where comment = $1`, [MARKER]);
  await client.query(`delete from users where email = $1`, ['ap-spike@example.invalid']);
  await client.query(`delete from organizations where comment = $1`, [MARKER]);
  await client.query(`delete from construction_objects where code = $1`, ['ap-spike']);

  const user = await one<{ id: string }>(
    client,
    `insert into users (email, password_hash, is_active, last_name, first_name)
     values ($1, 'x', true, 'Спайк', 'Периодов') returning id`,
    ['ap-spike@example.invalid'],
  );
  const org = await one<{ id: string }>(
    client,
    `insert into organizations (name, comment) values ('Спайк', $1) returning id`,
    [MARKER],
  );
  const site = await one<{ id: string }>(
    client,
    `insert into construction_objects (code, name) values ('ap-spike', 'Площадка спайка')
     returning id`,
  );
  const kind = await one<{ id: string }>(
    client,
    `insert into vehicle_kinds (code, name) values ('ap_spike_kind', 'Спайк')
     on conflict (code) do update set name = excluded.name returning id`,
  );
  const type = await one<{ id: string }>(
    client,
    `insert into vehicle_types (kind_id, code, name, waybill_form_code, is_linear)
     values ($1, 'ap_spike_type', 'Спайк ЭСМ-2', 'esm2', false)
     on conflict (code) do update set name = excluded.name returning id`,
    [kind.id],
  );

  const vehicleIds: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const row = await one<{ id: string }>(
      client,
      `insert into vehicles (vehicle_type_id, registration_number, ownership, note)
       values ($1, $2, 'own', $3) returning id`,
      [type.id, `АП${String(i).padStart(3, '0')}СП77`, MARKER],
    );
    vehicleIds.push(row.id);
  }
  const personIds: string[] = [];
  for (let i = 0; i < 48; i += 1) {
    const row = await one<{ id: string }>(
      client,
      `insert into persons (last_name, first_name, comment)
       values ($1, 'Машинист', $2) returning id`,
      [`Спайков${i}`, MARKER],
    );
    personIds.push(row.id);
  }
  const series = await one<{ id: string }>(
    client,
    `insert into waybill_series (code, name, prefix, next_number, comment)
     values ('ap_spike', 'Спайк', 'СП', 1, $1) returning id`,
    [MARKER],
  );

  const targetRequestId = await createRequest(client, {
    userId: user.id,
    objectId: site.id,
    typeId: type.id,
    dateFrom: TERM_FROM,
    dateTo: TERM_TO,
  });
  const concRequestId = await createRequest(client, {
    userId: user.id,
    objectId: site.id,
    typeId: type.id,
    dateFrom: TERM_FROM,
    dateTo: TERM_TO,
  });
  // Назначение нужно `buildEsm2SyncPlan`: он читает машину именно оттуда.
  for (const requestId of [targetRequestId, concRequestId]) {
    await client.query(
      `insert into vehicle_request_assignments (request_id, vehicle_id, vehicle_type_id, assigned_by)
       values ($1, $2, $3, $4)`,
      [requestId, vehicleIds[0], type.id, user.id],
    );
  }

  return {
    userId: user.id,
    objectId: site.id,
    organizationId: org.id,
    vehicleTypeId: type.id,
    vehicleIds,
    personIds,
    seriesId: series.id,
    targetRequestId,
    concRequestId,
  };
}

async function createRequest(
  client: pg.Client,
  p: { userId: string; objectId: string; typeId: string; dateFrom: string; dateTo: string },
): Promise<string> {
  const row = await one<{ id: string }>(
    client,
    `insert into vehicle_requests (request_type, vehicle_type_id, object_id, status, comment,
                                   created_by)
     values ('special_equipment', $1, $2, 'confirmed', $3, $4) returning id`,
    [p.typeId, p.objectId, MARKER, p.userId],
  );
  await client.query(
    `insert into special_equipment_request_details (request_id, date_from, date_to)
     values ($1, $2, $3)`,
    [row.id, p.dateFrom, p.dateTo],
  );
  return row.id;
}

// ───────────────────────────── генератор истории ─────────────────────────────

interface Change {
  effectiveDate: string;
  dimension: 'vehicle' | 'driver';
  vehicleId: string | null;
  driverPersonId: string | null;
  driverState: 'set' | 'cleared' | null;
  origin: string;
  /** Строка была один раз исправлена: в базе появится ещё и её погашенная предшественница. */
  corrected: boolean;
}

/**
 * История многолетней заявки: начальное назначение плюс замены с заданной частотой.
 *
 * Шкалы независимы (Р3): смена машиниста не порождает vehicle-строки и наоборот. Совпадение дат
 * между шкалами законно — частичный UNIQUE держит одну актуальную строку **на шкалу** и дату.
 */
function generateChanges(fx: Fixture, from: string, to: string): Change[] {
  const out: Change[] = [];
  let n = 0;
  out.push({
    effectiveDate: from,
    dimension: 'vehicle',
    vehicleId: fx.vehicleIds[0] ?? null,
    driverPersonId: null,
    driverState: null,
    origin: 'assignment',
    corrected: false,
  });
  out.push({
    effectiveDate: from,
    dimension: 'driver',
    vehicleId: null,
    driverPersonId: fx.personIds[0] ?? null,
    driverState: 'set',
    origin: 'assignment',
    corrected: false,
  });
  for (let d = VEHICLE_EVERY_DAYS, i = 1; ; d += VEHICLE_EVERY_DAYS, i += 1) {
    const date = shiftDateKey(from, d);
    if (date > to) break;
    n += 1;
    out.push({
      effectiveDate: date,
      dimension: 'vehicle',
      vehicleId: fx.vehicleIds[i % fx.vehicleIds.length] ?? null,
      driverPersonId: null,
      driverState: null,
      origin: 'reassignment',
      corrected: n % CORRECTED_EVERY === 0,
    });
  }
  for (let d = DRIVER_EVERY_DAYS, i = 1; ; d += DRIVER_EVERY_DAYS, i += 1) {
    const date = shiftDateKey(from, d);
    if (date > to) break;
    n += 1;
    out.push({
      effectiveDate: date,
      dimension: 'driver',
      vehicleId: null,
      driverPersonId: fx.personIds[i % fx.personIds.length] ?? null,
      driverState: 'set',
      origin: 'machinist_change',
      corrected: n % CORRECTED_EVERY === 0,
    });
  }
  out.sort((a, b) =>
    a.effectiveDate === b.effectiveDate
      ? a.dimension.localeCompare(b.dimension)
      : a.effectiveDate.localeCompare(b.effectiveDate),
  );
  return out;
}

/**
 * Кладёт историю в базу порядком, который план назвал единственно рабочим: `UPDATE` прежней строки
 * (гасим) → `INSERT` новой с `supersedes_change_id`. Исправленное изменение даёт две строки —
 * погашенную и действующую.
 */
async function insertChanges(
  client: pg.Client,
  fx: Fixture,
  requestId: string,
  changes: readonly Change[],
): Promise<void> {
  for (const c of changes) {
    const first = await one<{ id: string }>(
      client,
      `insert into vehicle_request_assignment_changes
         (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
          origin, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        requestId,
        c.effectiveDate,
        c.dimension,
        c.vehicleId,
        c.driverPersonId,
        c.driverState,
        c.origin,
        fx.userId,
      ],
    );
    if (!c.corrected) continue;
    await client.query(
      `update vehicle_request_assignment_changes
          set superseded_at = now(), superseded_by_user = $2, superseded_kind = 'replaced'
        where id = $1`,
      [first.id, fx.userId],
    );
    await client.query(
      `insert into vehicle_request_assignment_changes
         (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
          origin, created_by, supersedes_change_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        requestId,
        c.effectiveDate,
        c.dimension,
        c.vehicleId,
        c.driverPersonId,
        c.driverState,
        c.origin,
        fx.userId,
        first.id,
      ],
    );
  }
}

/**
 * Фон: столько-то прочих заявок со своей историей. Без фона замер индекса ничего не значит —
 * последовательное чтение сотни строк дёшево при любом плане.
 */
async function fillBackground(client: pg.Client, fx: Fixture, requests: number): Promise<void> {
  await client.query(
    `with ins as (
       insert into vehicle_requests (request_type, vehicle_type_id, object_id, status, comment,
                                     created_by)
       select 'special_equipment', $1::uuid, $8::uuid, 'confirmed', $2, $3::uuid
         from generate_series(1, $4::int)
       returning id
     )
     insert into vehicle_request_assignment_changes
       (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
        origin, created_by)
     select ins.id,
            (date '2024-01-01' + (g * 11))::date,
            case when g % 5 = 0 then 'vehicle' else 'driver' end,
            case when g % 5 = 0 then $5::uuid else null end,
            case when g % 5 = 0 then null else $6::uuid end,
            case when g % 5 = 0 then null else 'set' end,
            case when g % 5 = 0 then 'reassignment' else 'machinist_change' end,
            $3::uuid
       from ins, generate_series(0, $7::int - 1) g`,
    [
      fx.vehicleTypeId,
      MARKER,
      fx.userId,
      requests,
      fx.vehicleIds[1],
      fx.personIds[1],
      BACKGROUND_ROWS,
      fx.objectId,
    ],
  );
  await client.query('analyze vehicle_request_assignment_changes');
}

// ───────────────────────────── свёртка и отрезки ─────────────────────────────

interface ActualRow {
  effective_date: string;
  dimension: 'vehicle' | 'driver';
  vehicle_id: string | null;
  driver_person_id: string | null;
  driver_state: string | null;
}

/**
 * Отрезки состава — то, что на этапе 3 станет `esm2SheetPlan`. Здесь это **макет**, а не будущая
 * реализация: он нужен ровно затем, чтобы посчитать, во сколько отрезков и листов разворачивается
 * история заявки, и сколько это стоит по времени.
 *
 * Правило разреза — Р6: любое изменение любой шкалы режет отрезок, а внутри отрезка неделя ещё
 * режется границей календарной недели (бланк — это неделя, семь строк впечатаны, Р5).
 */
function foldSegments(rows: readonly ActualRow[], from: string, to: string): Esm2Period[] {
  const cuts = new Set<string>([from]);
  for (const r of rows) if (r.effective_date > from && r.effective_date <= to) cuts.add(r.effective_date);
  const sorted = [...cuts].sort();
  const out: Esm2Period[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i]!;
    const next = sorted[i + 1];
    const end = next ? shiftDateKey(next, -1) : to;
    // Внутри отрезка бланк по-прежнему недельный: режем по воскресеньям.
    let cursor = start;
    while (cursor <= end) {
      const weekEnd = shiftDateKey(weekStartKey(cursor), 6);
      const stop = weekEnd < end ? weekEnd : end;
      out.push({ from: cursor, to: stop });
      cursor = shiftDateKey(stop, 1);
    }
  }
  return out;
}

/**
 * Тот же разрез **настоящими** функциями: свёртка `assignmentSegments` плюс план `esm2SheetPlan`.
 *
 * Макет выше оставлен рядом намеренно — ради сравнения: число 223 в отчёте спайка получено им, до
 * того как план листов существовал, и разойдись реализация с макетом, расход бланков строгой
 * отчётности в плане оценён неверно.
 *
 * `id`, `origin` и `changeGroupId` подставляются синтетические: выборка `Q_ACTUAL` их не читает
 * (она мерится по времени, и трогать её состав нельзя), а свёртке они безразличны — она смотрит
 * дату, шкалу, значение и погашенность. Погашенных строк здесь нет по самому условию выборки.
 */
function planSheets(rows: readonly ActualRow[], fx: Fixture, asOf: string) {
  const changes: AssignmentChangeRow[] = rows.map((r, index) => ({
    id: `spike-${index}`,
    effectiveDate: r.effective_date,
    dimension: r.dimension,
    vehicleId: r.vehicle_id,
    driverPersonId: r.driver_person_id,
    driverState: r.driver_state as AssignmentChangeRow['driverState'],
    origin: 'assignment',
    changeGroupId: `spike-${index}`,
    supersededAt: null,
  }));
  const term = { dateFrom: TERM_FROM, dateTo: TERM_TO };
  // Все машины спайка собственные: бланк ведёт портал, и `wanted` считается на весь срок (Р4).
  const ownershipByVehicle = new Map<string, VehicleOwnership>(
    fx.vehicleIds.map((id) => [id, 'own' as const]),
  );
  return esm2SheetPlan(assignmentSegments(changes, term), term, [], {
    ownershipByVehicle,
    today: asOf,
  });
}

/** Состояние на дату — «что действовало» по обеим шкалам; чистая свёртка, без базы. */
function foldOnDate(rows: readonly ActualRow[], date: string): Record<string, ActualRow | null> {
  const out: Record<string, ActualRow | null> = { vehicle: null, driver: null };
  for (const r of rows) {
    if (r.effective_date > date) continue;
    out[r.dimension] = r;
  }
  return out;
}

// ───────────────────────────── измерительная утварь ─────────────────────────────

interface Timing {
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

function stats(samples: number[]): Timing {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
  return { medianMs: at(0.5), p95Ms: at(0.95), maxMs: s[s.length - 1] ?? 0 };
}

async function timeIt(times: number, body: () => Promise<unknown>): Promise<Timing> {
  // Разогрев: первый вызов платит за разбор запроса и за холодный кеш, и в медиану ему не место.
  for (let i = 0; i < Math.min(5, times); i += 1) await body();
  const samples: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    await body();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

interface Explained {
  execMs: number;
  planMs: number;
  sharedHit: number;
  sharedRead: number;
  /** Как база достала строки: `Seq Scan`, `Index Scan using …` и т. п. */
  access: string;
  rows: number;
}

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function accessOf(node: PlanNode): string {
  const kids = node.Plans ?? [];
  if (kids.length > 0) {
    const inner = accessOf(kids[0]!);
    if (inner) return inner;
  }
  if (node['Node Type'].includes('Scan')) {
    return node['Index Name'] ? `${node['Node Type']} (${node['Index Name']})` : node['Node Type'];
  }
  return '';
}

async function explain(client: pg.Client, sql: string, params: unknown[]): Promise<Explained> {
  const res = await client.query(`explain (analyze, buffers, format json) ${sql}`, params);
  const row = res.rows[0] as Record<string, unknown>;
  const wrapper = (row['QUERY PLAN'] as Array<Record<string, unknown>>)[0]!;
  const plan = wrapper['Plan'] as PlanNode;
  return {
    execMs: wrapper['Execution Time'] as number,
    planMs: wrapper['Planning Time'] as number,
    sharedHit: (plan['Shared Hit Blocks'] as number | undefined) ?? 0,
    sharedRead: (plan['Shared Read Blocks'] as number | undefined) ?? 0,
    access: accessOf(plan) || plan['Node Type'],
    rows: (plan['Actual Rows'] as number | undefined) ?? 0,
  };
}

async function one<T>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const res = await client.query(sql, params);
  const row = res.rows[0] as T | undefined;
  if (row === undefined) throw new Error(`Запрос не вернул строк: ${sql.slice(0, 80)}`);
  return row;
}

// ───────────────────────────── замеры выборки ─────────────────────────────

/** Вся история заявки, включая погашенные строки: это экран ремонта и журнал (Р29). */
const Q_FULL = `
  select id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id, supersedes_change_id, superseded_at
    from vehicle_request_assignment_changes
   where request_id = $1
   order by effective_date, dimension, created_at`;

/** Действующая история: вход свёртки и `esm2SheetPlan`. */
const Q_ACTUAL = `
  select effective_date, dimension, vehicle_id, driver_person_id, driver_state
    from vehicle_request_assignment_changes
   where request_id = $1 and superseded_at is null
   order by effective_date, dimension`;

/** Свёртка на одну дату: «что действовало» по обеим шкалам. */
const Q_FOLD = `
  select distinct on (dimension)
         dimension, effective_date, vehicle_id, driver_person_id, driver_state
    from vehicle_request_assignment_changes
   where request_id = $1 and superseded_at is null and effective_date <= $2
   order by dimension, effective_date desc`;

/**
 * Наборы индексов для замера. «Без индекса» здесь означает «без единого индекса, ведущего по
 * `request_id`»: в §6 плана их **три** (`_request_idx`, `_actual_unique`, `_group_idx`), и снять
 * один из них — значит померить не отсутствие индекса, а замену одного другим.
 */
type IndexSet = 'все из §6' | 'без _request_idx' | 'без индексов по request_id';

async function setIndexes(client: pg.Client, set: IndexSet): Promise<void> {
  await client.query('drop index if exists vehicle_request_assignment_changes_request_idx');
  await client.query('drop index if exists vehicle_request_assignment_changes_actual_unique');
  await client.query('drop index if exists vehicle_request_assignment_changes_group_idx');
  if (set !== 'без индексов по request_id') {
    await client.query(INDEX_DDL['vehicle_request_assignment_changes_actual_unique']!);
    await client.query(INDEX_DDL['vehicle_request_assignment_changes_group_idx']!);
  }
  if (set === 'все из §6') {
    await client.query(INDEX_DDL['vehicle_request_assignment_changes_request_idx']!);
  }
  await client.query('analyze vehicle_request_assignment_changes');
}

interface QueryMeasure {
  label: string;
  indexes: IndexSet;
  timing: Timing;
  explained: Explained;
}

async function measureQueries(
  client: pg.Client,
  requestId: string,
  asOf: string,
): Promise<QueryMeasure[]> {
  const out: QueryMeasure[] = [];
  for (const indexes of [
    'все из §6',
    'без _request_idx',
    'без индексов по request_id',
  ] as IndexSet[]) {
    await setIndexes(client, indexes);
    const cases: Array<[string, string, unknown[]]> = [
      ['вся история заявки', Q_FULL, [requestId]],
      ['действующая история', Q_ACTUAL, [requestId]],
      ['свёртка на одну дату', Q_FOLD, [requestId, asOf]],
    ];
    for (const [label, sql, params] of cases) {
      out.push({
        label,
        indexes,
        timing: await timeIt(REPEAT, () => client.query(sql, params)),
        explained: await explain(client, sql, params),
      });
    }
  }
  await setIndexes(client, 'все из §6');
  return out;
}

// ───────────────────────────── замер сверки ЭСМ-2 ─────────────────────────────

interface Esm2Measure {
  weeklySheets: number;
  segments: number;
  existingSheets: number;
  buildPlanTiming: Timing;
  /** То же, но машиниста назвали другого: сверка перевыписывает всю оставшуюся бумагу. */
  buildPlanChangedTiming: Timing;
  changedCancel: number;
  changedIssue: number;
  /** Свёртка истории в отрезки, микросекунды на один вызов (замер пачкой по 100). */
  foldSegmentsUs: number;
  planCancel: number;
  planIssue: number;
}

/**
 * Сегодняшняя сверка — база сравнения. Меряется **настоящий** `buildEsm2SyncPlan` из
 * `src/services/waybill-esm2.ts` на настоящем drizzle: у него три чтения (`loadRequest`,
 * `activeSheets`, `lastMachinistOf`) и чистая функция `esm2SyncPlan` поверх. Конфиг приложения
 * читает env при импорте, поэтому импорт — динамический, уже после подстановки переменных: так же
 * это делают db-тесты.
 */
async function measureEsm2(fx: Fixture, actual: ActualRow[]): Promise<Esm2Measure> {
  const weekly = esm2Periods(TERM_FROM, TERM_TO);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'ap-spike-cookie-secret-0123456789';
  process.env.CSRF_SECRET ??= 'ap-spike-csrf-secret-0123456789';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'ap-spike';
  process.env.S3_ACCESS_KEY_ID ??= 'ap-spike';
  process.env.S3_SECRET_ACCESS_KEY ??= 'ap-spike-secret';
  process.env.LOG_LEVEL ??= 'error';

  const { db, closeDb } = await import('../src/db/client');
  const { buildEsm2SyncPlan } = await import('../src/services/waybill-esm2');
  try {
    const built = await buildEsm2SyncPlan(db, { requestId: fx.targetRequestId });
    if (!built) throw new Error('buildEsm2SyncPlan не нашёл заявку спайка');
    const timing = await timeIt(Math.min(REPEAT, 50), () =>
      buildEsm2SyncPlan(db, { requestId: fx.targetRequestId }),
    );
    // Второй замер — состояние «машиниста сменили»: план перестаёт быть пустым и перечисляет всю
    // предстоящую бумагу. Это и есть цена сверки после реального действия, а не в покое.
    const changedDriver = fx.personIds[5]!;
    const changed = await buildEsm2SyncPlan(db, {
      requestId: fx.targetRequestId,
      driverPersonId: changedDriver,
    });
    const changedTiming = await timeIt(Math.min(REPEAT, 50), () =>
      buildEsm2SyncPlan(db, { requestId: fx.targetRequestId, driverPersonId: changedDriver }),
    );
    const segments = foldSegments(actual, TERM_FROM, TERM_TO);
    // В памяти свёртка стоит микросекунды, и один вызов тонет в разрешении таймера: меряем пачкой.
    const foldTiming = await timeIt(20, async () => {
      for (let i = 0; i < 100; i += 1) foldSegments(actual, TERM_FROM, TERM_TO);
    });
    return {
      weeklySheets: weekly.length,
      segments: segments.length,
      existingSheets: built.input.existing.length,
      buildPlanTiming: timing,
      buildPlanChangedTiming: changedTiming,
      changedCancel: changed?.plan.cancel.length ?? 0,
      changedIssue: changed?.plan.issue.length ?? 0,
      foldSegmentsUs: (foldTiming.medianMs * 1000) / 100,
      planCancel: built.plan.cancel.length,
      planIssue: built.plan.issue.length,
    };
  } finally {
    await closeDb();
  }
}

/** Выписывает заявке недельные листы — тот объём бумаги, который сверка перебирает каждый раз. */
async function issueSheets(
  client: pg.Client,
  fx: Fixture,
  periods: readonly Esm2Period[],
): Promise<void> {
  await client.query(
    `insert into waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                           driver_person_id, issued_for_date, period_from, period_to,
                           source_request_id, issued_by)
     select $1, u.ord, 'esm2', 'issued', $2, $3, $4, u.f::date, u.f::date, u.t::date, $5, $6
       from unnest($7::text[], $8::text[]) with ordinality as u(f, t, ord)`,
    [
      fx.seriesId,
      fx.organizationId,
      fx.vehicleIds[0],
      fx.personIds[0],
      fx.targetRequestId,
      fx.userId,
      periods.map((p) => p.from),
      periods.map((p) => p.to),
    ],
  );
}

// ───────────────────────────── конкуренция ─────────────────────────────

type ErrorSpot = 'lock' | 'read' | 'supersede' | 'insert' | 'dirty' | 'commit' | 'series';

interface WriterResult {
  ok: boolean;
  /** Код ошибки, не являющейся `40001`: протокол повторов её не ловит, и она уедет наружу. */
  otherCode: string | null;
  attempts: number;
  /** Где именно транзакцию застал `40001` на каждой неудачной попытке. */
  spots: ErrorSpot[];
  totalMs: number;
  /** Сколько прожила первая неудачная попытка: это и есть выброшенная работа. */
  wastedMs: number | null;
}

interface WriterOptions {
  requestId: string;
  /** Уровень изоляции: сравниваем решение плана с сегодняшним поведением пула. */
  isolation: Isolation;
  /** Брать ли строку заявки первой операцией (`lockRequestRow`, порядок из этапа 2a плана). */
  lockRequest: boolean;
  /** Писать ли `assignment_history_dirty` — то есть менять ли саму строку заявки (К4 плана). */
  markDirty: boolean;
  /** Дата изменения: одна на всех — конфликт по одной строке; разные — по разным. */
  effectiveDate: string;
  personId: string;
  userId: string;
  /** Захватывать ли номер бланка в конце транзакции (модель `takeNextNumber`). */
  seriesId: string | null;
}

function errCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;
}

/**
 * Один писатель с протоколом повторов В4: `REPEATABLE READ`, при `40001` — повтор всей транзакции
 * **с повторным планированием** (историю читаем заново каждую попытку, как и требует план).
 */
async function runWriter(client: pg.Client, opts: WriterOptions): Promise<WriterResult> {
  const spots: ErrorSpot[] = [];
  const started = performance.now();
  let wastedMs: number | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStart = performance.now();
    let spot: ErrorSpot = 'lock';
    await client.query(`begin isolation level ${opts.isolation}`);
    try {
      if (opts.lockRequest) {
        await client.query('select id from vehicle_requests where id = $1 for update', [
          opts.requestId,
        ]);
      }
      spot = 'read';
      const hist = await client.query(Q_ACTUAL, [opts.requestId]);
      void hist.rowCount;
      spot = 'supersede';
      const target = await client.query(
        `select id from vehicle_request_assignment_changes
          where request_id = $1 and dimension = 'driver' and effective_date = $2
            and superseded_at is null`,
        [opts.requestId, opts.effectiveDate],
      );
      const targetId = (target.rows[0] as { id: string } | undefined)?.id;
      if (!targetId) throw new Error('Целевая строка истории не найдена — сценарий собран неверно');
      await client.query(
        `update vehicle_request_assignment_changes
            set superseded_at = now(), superseded_by_user = $2, superseded_kind = 'replaced'
          where id = $1`,
        [targetId, opts.userId],
      );
      spot = 'insert';
      await client.query(
        `insert into vehicle_request_assignment_changes
           (request_id, effective_date, dimension, driver_person_id, driver_state, origin,
            created_by, supersedes_change_id)
         values ($1, $2, 'driver', $3, 'set', 'machinist_change', $4, $5)`,
        [opts.requestId, opts.effectiveDate, opts.personId, opts.userId, targetId],
      );
      if (opts.seriesId) {
        spot = 'series';
        await client.query('select next_number from waybill_series where id = $1 for update', [
          opts.seriesId,
        ]);
        await client.query(
          'update waybill_series set next_number = next_number + 1 where id = $1',
          [opts.seriesId],
        );
      }
      if (opts.markDirty) {
        spot = 'dirty';
        await client.query('update vehicle_requests set updated_at = now() where id = $1', [
          opts.requestId,
        ]);
      }
      spot = 'commit';
      await client.query('commit');
      return {
        ok: true,
        otherCode: null,
        attempts: attempt,
        spots,
        totalMs: performance.now() - started,
        wastedMs,
      };
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      const code = errCode(e);
      if (code !== '40001') {
        /*
         * Не `40001` — и это отдельный результат, а не поломка стенда: в `READ COMMITTED` та же
         * гонка кончается не ошибкой сериализации, а нарушением частичного UNIQUE (23505), потому
         * что вторая транзакция дописывает актуальную строку на ту же дату по уже устаревшему
         * решению. Протокол повторов такую ошибку не ловит.
         */
        return {
          ok: false,
          otherCode: code ?? 'ошибка',
          attempts: attempt,
          spots,
          totalMs: performance.now() - started,
          wastedMs,
        };
      }
      spots.push(spot);
      if (wastedMs === null) wastedMs = performance.now() - attemptStart;
    }
  }
  return {
    ok: false,
    otherCode: null,
    attempts: MAX_ATTEMPTS,
    spots,
    totalMs: performance.now() - started,
    wastedMs,
  };
}

type Isolation = 'repeatable read' | 'read committed';

interface Scenario {
  label: string;
  isolation: Isolation;
  writers: number;
  lockRequest: boolean;
  markDirty: boolean;
  sameRow: boolean;
  series: boolean;
}

interface ScenarioResult {
  scenario: Scenario;
  trials: number;
  /** Доля прогонов, в которых хоть один писатель получил `40001`. */
  conflictTrials: number;
  /** Всего ошибок сериализации на все попытки всех писателей. */
  serializationErrors: number;
  /** Гистограмма: сколько писателей уложились в 1, 2, 3 … попытки. */
  attemptsHistogram: number[];
  /** Писателей, которым не хватило трёх попыток (то есть будущих 503). */
  overThree: number;
  writersTotal: number;
  /** Ошибки, которые протокол повторов не ловит: код → сколько раз. */
  otherErrors: Record<string, number>;
  spots: Record<string, number>;
  wasted: Timing | null;
}

/** Свежая история заявки конкуренции: у каждого писателя своя дата, если сценарий этого просит. */
async function resetConcurrencyHistory(
  client: pg.Client,
  fx: Fixture,
  dates: readonly string[],
): Promise<void> {
  await client.query('delete from vehicle_request_assignment_changes where request_id = $1', [
    fx.concRequestId,
  ]);
  for (const [i, date] of dates.entries()) {
    await client.query(
      `insert into vehicle_request_assignment_changes
         (request_id, effective_date, dimension, driver_person_id, driver_state, origin, created_by)
       values ($1, $2, 'driver', $3, 'set', 'machinist_change', $4)`,
      [fx.concRequestId, date, fx.personIds[i % fx.personIds.length], fx.userId],
    );
  }
}

async function runScenario(
  admin: pg.Client,
  clients: pg.Client[],
  fx: Fixture,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const dates = Array.from({ length: scenario.writers }, (_, i) =>
    scenario.sameRow ? TERM_FROM : shiftDateKey(TERM_FROM, i * 7),
  );
  const uniqueDates = [...new Set(dates)];
  const histogram: number[] = [];
  const spots: Record<string, number> = {};
  const otherErrors: Record<string, number> = {};
  const wasted: number[] = [];
  let conflictTrials = 0;
  let serializationErrors = 0;
  let overThree = 0;
  let writersTotal = 0;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    await resetConcurrencyHistory(admin, fx, uniqueDates);
    const results = await Promise.all(
      dates.map((date, i) =>
        runWriter(clients[i]!, {
          requestId: fx.concRequestId,
          isolation: scenario.isolation,
          lockRequest: scenario.lockRequest,
          markDirty: scenario.markDirty,
          effectiveDate: date,
          personId: fx.personIds[(i + 3) % fx.personIds.length]!,
          userId: fx.userId,
          seriesId: scenario.series ? fx.seriesId : null,
        }),
      ),
    );
    let conflicted = false;
    for (const r of results) {
      writersTotal += 1;
      histogram[r.attempts - 1] = (histogram[r.attempts - 1] ?? 0) + 1;
      serializationErrors += r.spots.length;
      if (r.spots.length > 0) conflicted = true;
      if (r.otherCode) otherErrors[r.otherCode] = (otherErrors[r.otherCode] ?? 0) + 1;
      if (r.attempts > 3 || (!r.ok && !r.otherCode)) overThree += 1;
      for (const s of r.spots) spots[s] = (spots[s] ?? 0) + 1;
      if (r.wastedMs !== null) wasted.push(r.wastedMs);
    }
    if (conflicted) conflictTrials += 1;
  }
  return {
    scenario,
    trials: TRIALS,
    conflictTrials,
    serializationErrors,
    attemptsHistogram: histogram,
    overThree,
    writersTotal,
    otherErrors,
    spots,
    wasted: wasted.length > 0 ? stats(wasted) : null,
  };
}

// ───────────────────────────── точечные пробы изоляции ─────────────────────────────

interface Probe {
  label: string;
  /** Что делает первая транзакция и коммитит. */
  first: (c: pg.Client, fx: Fixture) => Promise<void>;
  /** Что делает вторая — со снимком, взятым ДО коммита первой. */
  second: (c: pg.Client, fx: Fixture) => Promise<void>;
  expectation: string;
}

/**
 * Точечные пробы: каждая отвечает на один вопрос об изоляции, и ответ у неё детерминированный —
 * порядок задан явно, гонки нет. Ими проверяются механизмы, на которые план ссылается прямым
 * текстом: `FOR UPDATE` на строке заявки, `FOR SHARE` на управляющей строке (Ж3), поздний захват
 * счётчика номеров (В4), независимость строк истории.
 */
async function runProbes(fx: Fixture, admin: pg.Client): Promise<Array<Probe & { got: string }>> {
  const probes: Probe[] = [
    {
      label: 'Т1 изменила строку заявки → Т2 берёт её FOR UPDATE',
      first: async (c, f) =>
        void (await c.query('update vehicle_requests set updated_at = now() where id = $1', [
          f.concRequestId,
        ])),
      second: async (c, f) =>
        void (await c.query('select id from vehicle_requests where id = $1 for update', [
          f.concRequestId,
        ])),
      expectation: 'план ждёт 40001 (В4)',
    },
    {
      label: 'Т1 только взяла строку заявки FOR UPDATE (без записи) → Т2 берёт FOR UPDATE',
      first: async (c, f) =>
        void (await c.query('select id from vehicle_requests where id = $1 for update', [
          f.concRequestId,
        ])),
      second: async (c, f) =>
        void (await c.query('select id from vehicle_requests where id = $1 for update', [
          f.concRequestId,
        ])),
      expectation: 'проверяем, спасает ли «блокировка без записи»',
    },
    {
      label: 'Т1 изменила строку заявки → Т2 берёт её FOR SHARE (механизм Ж3)',
      first: async (c, f) =>
        void (await c.query('update vehicle_requests set updated_at = now() where id = $1', [
          f.concRequestId,
        ])),
      second: async (c, f) =>
        void (await c.query('select id from vehicle_requests where id = $1 for share', [
          f.concRequestId,
        ])),
      expectation: 'план ждёт 40001 (Ж3: freeze как drain)',
    },
    {
      label: 'Т1 и Т2 правят РАЗНЫЕ строки истории одной заявки',
      first: async (c, f) =>
        void (await c.query(
          `update vehicle_request_assignment_changes set created_at = now()
            where request_id = $1 and effective_date = $2`,
          [f.concRequestId, TERM_FROM],
        )),
      second: async (c, f) =>
        void (await c.query(
          `update vehicle_request_assignment_changes set created_at = now()
            where request_id = $1 and effective_date = $2`,
          [f.concRequestId, shiftDateKey(TERM_FROM, 7)],
        )),
      expectation: 'проверяем, даёт ли REPEATABLE READ конфликт на разных строках',
    },
    {
      label: 'Т1 и Т2 правят ОДНУ строку истории',
      first: async (c, f) =>
        void (await c.query(
          `update vehicle_request_assignment_changes set created_at = now()
            where request_id = $1 and effective_date = $2`,
          [f.concRequestId, TERM_FROM],
        )),
      second: async (c, f) =>
        void (await c.query(
          `update vehicle_request_assignment_changes set created_at = now()
            where request_id = $1 and effective_date = $2`,
          [f.concRequestId, TERM_FROM],
        )),
      expectation: 'план ждёт 40001',
    },
    {
      label: 'Т1 взяла номер бланка → Т2 берёт счётчик FOR UPDATE (поздний захват)',
      first: async (c, f) =>
        void (await c.query(
          'update waybill_series set next_number = next_number + 1 where id = $1',
          [f.seriesId],
        )),
      second: async (c, f) =>
        void (await c.query('select next_number from waybill_series where id = $1 for update', [
          f.seriesId,
        ])),
      expectation: 'план называет это самым вероятным источником 40001',
    },
  ];

  const out: Array<Probe & { got: string }> = [];
  const c1 = await connected();
  const c2 = await connected();
  try {
    for (const probe of probes) {
      await resetConcurrencyHistory(admin, fx, [TERM_FROM, shiftDateKey(TERM_FROM, 7)]);
      await c1.query('begin isolation level repeatable read');
      await c2.query('begin isolation level repeatable read');
      // Снимок в `REPEATABLE READ` берётся первым запросом, а не на BEGIN: без этого Т2 увидела бы
      // уже закоммиченное состояние и конфликта не было бы вовсе.
      await c2.query('select 1');
      await probe.first(c1, fx);
      await c1.query('commit');
      let got = 'без ошибки';
      try {
        await probe.second(c2, fx);
        await c2.query('commit');
      } catch (e) {
        const code = errCode(e);
        got = code === '40001' ? '40001' : `${code ?? 'ошибка'}`;
        await c2.query('rollback').catch(() => undefined);
      }
      out.push({ ...probe, got });
    }
  } finally {
    await c1.end();
    await c2.end();
  }
  return out;
}

// ───────────────────────────── печать отчёта ─────────────────────────────

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    '| ' + cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join(' | ') + ' |';
  return [line(header), '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|', ...rows.map(line)].join(
    '\n',
  );
}

// ───────────────────────────── прогон ─────────────────────────────

async function main(): Promise<void> {
  const admin = await connected();
  const asOf = '2026-08-20';
  try {
    await ensureHistorySchema(admin);
    const fx = await seed(admin);

    // 1. Объём.
    const changes = generateChanges(fx, TERM_FROM, TERM_TO);
    await insertChanges(admin, fx, fx.targetRequestId, changes);
    const weekly = esm2Periods(TERM_FROM, TERM_TO);
    await issueSheets(admin, fx, weekly);

    const counts = await one<{
      total: string;
      actual: string;
      superseded: string;
      vehicle_rows: string;
      driver_rows: string;
    }>(
      admin,
      `select count(*)::text total,
              count(*) filter (where superseded_at is null)::text actual,
              count(*) filter (where superseded_at is not null)::text superseded,
              count(*) filter (where dimension = 'vehicle')::text vehicle_rows,
              count(*) filter (where dimension = 'driver')::text driver_rows
         from vehicle_request_assignment_changes where request_id = $1`,
      [fx.targetRequestId],
    );

    const actualRes = await admin.query(Q_ACTUAL, [fx.targetRequestId]);
    const actual = actualRes.rows as ActualRow[];

    console.log('# Спайк периодов назначения\n');
    console.log(`Срок заявки: ${TERM_FROM} … ${TERM_TO}; «сегодня» замера — ${asOf}.`);
    console.log(
      `Частота замен: машинист раз в ${DRIVER_EVERY_DAYS} дней, машина раз в ${VEHICLE_EVERY_DAYS} дней;` +
        ` каждое ${CORRECTED_EVERY}-е изменение однажды исправлено.\n`,
    );

    console.log('## 1. Объём многолетней заявки\n');
    console.log(
      table(
        ['Величина', 'Значение'],
        [
          ['Дней в сроке', String(weekly.length > 0 ? daysBetween(TERM_FROM, TERM_TO) : 0)],
          ['Строк истории всего', counts.total],
          ['— действующих', counts.actual],
          ['— погашенных', counts.superseded],
          ['— шкала машины', counts.vehicle_rows],
          ['— шкала машиниста', counts.driver_rows],
          ['Недельных листов ЭСМ-2 (сегодняшняя модель)', String(weekly.length)],
          ['Отрезков-бланков при разрезе по Р6 (макет)', String(foldSegments(actual, TERM_FROM, TERM_TO).length)],
          [
            'Отрезков-бланков при разрезе по Р6 (настоящий `esm2SheetPlan`)',
            String(planSheets(actual, fx, asOf).wanted.length),
          ],
        ],
      ),
    );
    console.log();

    // 2. Стоимость выборки и свёртки на разных наполнениях.
    for (const stage of FILL_STAGES) {
      await fillBackground(admin, fx, stage);
      const size = await one<{ rows: string; bytes: string }>(
        admin,
        `select count(*)::text rows,
                pg_size_pretty(pg_total_relation_size('vehicle_request_assignment_changes')) bytes
           from vehicle_request_assignment_changes`,
      );
      console.log(
        `## 2. Выборка и свёртка при ${size.rows} строк в таблице (${size.bytes} с индексами)\n`,
      );
      const measures = await measureQueries(admin, fx.targetRequestId, asOf);
      console.log(
        table(
          ['Запрос', 'Индексы', 'медиана, мс', 'p95, мс', 'exec, мс', 'buffers hit/read', 'доступ'],
          measures.map((m) => [
            m.label,
            m.indexes,
            fmt(m.timing.medianMs),
            fmt(m.timing.p95Ms),
            fmt(m.explained.execMs),
            `${m.explained.sharedHit}/${m.explained.sharedRead}`,
            m.explained.access,
          ]),
        ),
      );
      console.log();
    }

    // 3. Сверка.
    const foldDateBatch = await timeIt(20, async () => {
      for (let i = 0; i < 100; i += 1) foldOnDate(actual, asOf);
    });
    const foldDateUs = (foldDateBatch.medianMs * 1000) / 100;
    const esm2 = await measureEsm2(fx, actual);
    console.log('## 3. Сверка листов на весь срок\n');
    console.log(
      table(
        ['Величина', 'Значение'],
        [
          ['Действующих листов у заявки', String(esm2.existingSheets)],
          ['Недель в сроке', String(esm2.weeklySheets)],
          ['Отрезков при разрезе (макет `esm2SheetPlan`)', String(esm2.segments)],
          ['`buildEsm2SyncPlan`, медиана', `${fmt(esm2.buildPlanTiming.medianMs)} мс`],
          ['`buildEsm2SyncPlan`, p95', `${fmt(esm2.buildPlanTiming.p95Ms)} мс`],
          ['План в покое: аннулировать / выписать', `${esm2.planCancel} / ${esm2.planIssue}`],
          ['`buildEsm2SyncPlan` после смены машиниста, медиана', `${fmt(esm2.buildPlanChangedTiming.medianMs)} мс`],
          ['То же, p95', `${fmt(esm2.buildPlanChangedTiming.p95Ms)} мс`],
          ['План после смены: аннулировать / выписать', `${esm2.changedCancel} / ${esm2.changedIssue}`],
          ['Свёртка истории в отрезки (в памяти)', `${fmt(esm2.foldSegmentsUs, 1)} мкс`],
          ['Свёртка на одну дату (в памяти)', `${fmt(foldDateUs, 1)} мкс`],
        ],
      ),
    );
    console.log();

    // 4. Конкуренция.
    console.log('## 4. Конкуренция: точечные пробы изоляции\n');
    const probes = await runProbes(fx, admin);
    console.log(
      table(
        ['Проба', 'Ожидание плана', 'Получено'],
        probes.map((p) => [p.label, p.expectation, p.got]),
      ),
    );
    console.log();

    const scenarios: Scenario[] = [];
    const rr: Isolation = 'repeatable read';
    for (const writers of WRITER_COUNTS) {
      scenarios.push(
        { label: 'одна строка, без блокировки заявки', isolation: rr, writers, lockRequest: false, markDirty: false, sameRow: true, series: false },
        { label: 'одна строка, блокировка + dirty', isolation: rr, writers, lockRequest: true, markDirty: true, sameRow: true, series: false },
        { label: 'разные строки, без блокировки', isolation: rr, writers, lockRequest: false, markDirty: false, sameRow: false, series: false },
        { label: 'разные строки, блокировка + dirty', isolation: rr, writers, lockRequest: true, markDirty: true, sameRow: false, series: false },
        { label: 'разные строки, блокировка без dirty', isolation: rr, writers, lockRequest: true, markDirty: false, sameRow: false, series: false },
        { label: 'разные строки, без блокировки + номер бланка', isolation: rr, writers, lockRequest: false, markDirty: false, sameRow: false, series: true },
      );
    }
    /*
     * Те же нагрузки в сегодняшней изоляции: пул уровня не задаёт, то есть двери работают в
     * `READ COMMITTED`. Это база сравнения — без неё непонятно, что решение плана добавляет и что
     * отнимает.
     */
    const rc: Isolation = 'read committed';
    for (const writers of [2, 4]) {
      scenarios.push(
        { label: 'READ COMMITTED: одна строка, без блокировки', isolation: rc, writers, lockRequest: false, markDirty: false, sameRow: true, series: false },
        { label: 'READ COMMITTED: одна строка, блокировка + dirty', isolation: rc, writers, lockRequest: true, markDirty: true, sameRow: true, series: false },
        { label: 'READ COMMITTED: разные строки + номер бланка', isolation: rc, writers, lockRequest: false, markDirty: false, sameRow: false, series: true },
      );
    }
    const clients: pg.Client[] = [];
    for (let i = 0; i < Math.max(...WRITER_COUNTS); i += 1) clients.push(await connected());
    const results: ScenarioResult[] = [];
    try {
      for (const scenario of scenarios) results.push(await runScenario(admin, clients, fx, scenario));
    } finally {
      for (const c of clients) await c.end();
    }

    console.log(`## 4. Конкуренция: гонки по ${TRIALS} прогонов на сценарий\n`);
    console.log(
      table(
        ['Сценарий', 'писателей', 'прогонов с 40001', 'всего 40001', 'попыток 1/2/3/4+', '>3 попыток', 'иные ошибки', 'где ловится', 'выброшено, мс (медиана)'],
        results.map((r) => {
          const h = r.attemptsHistogram;
          const four = h.slice(3).reduce((a, b) => a + (b ?? 0), 0);
          return [
            r.scenario.label,
            String(r.scenario.writers),
            `${r.conflictTrials}/${r.trials}`,
            String(r.serializationErrors),
            `${h[0] ?? 0}/${h[1] ?? 0}/${h[2] ?? 0}/${four}`,
            `${r.overThree}/${r.writersTotal}`,
            Object.entries(r.otherErrors)
              .map(([k, v]) => `${k}:${v}`)
              .join(' ') || '—',
            Object.entries(r.spots)
              .map(([k, v]) => `${k}:${v}`)
              .join(' ') || '—',
            r.wasted ? fmt(r.wasted.medianMs) : '—',
          ];
        }),
      ),
    );
    console.log();
    console.log('Готово. База спайка оставлена как есть.');
  } finally {
    await admin.end();
  }
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
