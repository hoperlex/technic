import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { moscowDateKeyOf } from '@technic/contracts';
import * as schema from '../src/db/schema';
import {
  assignmentHistoryUnrestorableReason,
  computeAssignmentHistory,
  ensureAssignmentHistory,
  readAssignmentHistorySnapshot,
} from '../src/services/assignment-ensure';
import { readAssignmentMode } from '../src/services/assignment-mode';
import { ASSIGNMENT_READINESS_POPULATION } from '../src/services/assignment-readiness';
import type { AssignmentHistoryUnrestorable } from '../src/services/assignment-ensure';

/**
 * Массовый бэкфилл истории назначения — этап 4 плана `docs/assignment-periods-plan.md` (§6
 * «Бэкфилл», Г2, Р20, Р26–Р28, Р30, З3, Ю57).
 *
 * ЗАЧЕМ ОН. Ленивый бэкфилл (`assignment-ensure.ts`) достраивает историю заявки при первом
 * обращении к ней — командой машиниста, коррекцией, ремонтом или восстановлением из архива. Но
 * заявка, к которой никто не подходит, остаётся в состоянии `empty` навсегда (Ю57: линейная заявка
 * дверьми крю и коррекции не ходит вовсе), а переключение чтения этапа 5 требует готовности от
 * **всех** заявок предиката Р20. Этот прогон проходит базу и достраивает историю там, где для неё
 * есть опора, а невосстановимое показывает в отчёте — по номерам заявок и по причинам.
 *
 * ПРАВИЛ ВОССТАНОВЛЕНИЯ ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Скрипт зовёт ту же дверь, что и портал, —
 * `ensureAssignmentHistory`, — и не знает ни одного правила §6. Вторая копия правил разошлась бы с
 * первой, и тогда история, восстановленная прогоном, отличалась бы от истории той же заявки,
 * восстановленной дверью, — а различить их потом нечем: `origin` у обеих `backfill`.
 *
 * ЧЕГО ПРОГОН НЕ ДЕЛАЕТ, И ЭТО ГЛАВНОЕ:
 *
 * - **не пересобирает уже существующую историю.** В работу берутся только заявки в состоянии
 *   `empty`; заявка с историей (в том числе та, где человек отменил все backfill-строки и оставил
 *   пустую `materialized`) не трогается вовсе. Пересборка воскресила бы отменённое человеком
 *   решение — прямой запрет Д3;
 * - **не выдумывает недостающее.** Заявка без назначения, с двумя действующими листами на одну
 *   дату или с пересечением периодов остаётся `empty` и уходит в блокирующий отчёт. Эвристики
 *   («взять первый лист», «протянуть машиниста назад») сюда не добавляются ни при каких условиях:
 *   заявку без истории видно, а заявку с выдуманной историей — нет. Ту же честность прогон
 *   наследует и в границе Ф-узкое: голову срока, отработанную арендной техникой, он запишет
 *   машиной из назначения, потому что другой опоры нет, — это записано в плане и здесь не чинится;
 * - **не пересчитывает готовность у тех, кто уже готов.** Ревалидация под общий `asOf` — отдельный
 *   шаг cutover (Ж2), и делать её заодно значило бы трогать заявки, которых прогон не касается.
 *
 * ОДНОПОТОЧНЫЙ — ЭТО ИЗМЕРЕННОЕ РЕШЕНИЕ, А НЕ ОСТОРОЖНОСТЬ. Спайк
 * (`docs/assignment-periods-spike.md` §4.3) показал закон: при `W` одновременных писателях по
 * одной общей строке `k`-й проходит с `k`-й попытки, и при четырёх писателях четверть транзакций
 * не укладывается в три повтора. Общей строкой для портала является в том числе строка серии
 * бланков — одна на весь портал, — поэтому `W` считается по всему порталу, а не по заявке. Прогон
 * в несколько потоков сам себе сделал бы `W = число потоков` и начал бы получать отказы; пул здесь
 * `max: 1`, и это часть контракта, а не настройка производительности.
 *
 * ПОЧЕМУ ДВЕРЬ РЕЖИМА НЕ СПРАШИВАЕТСЯ. По З3 maintenance-путь (ревалидация, теневой прогон, смена
 * режима, обратный скрипт и этот бэкфилл) ходит мимо HTTP из административного процесса, и запись
 * ему разрешена в том числе при поднятом freeze — иначе cutover блокировал бы сам себя. Режим
 * читается и печатается в шапке отчёта, но гейтом не становится.
 *
 * ЧЕМ ХОДИТ В БАЗУ. Своим URL: `DATABASE_MAINTENANCE_URL`, а при его отсутствии —
 * `DATABASE_MIGRATION_URL`, ровно как административная дверь режима (`scripts/assignment-mode.ts`,
 * П7). Молчаливого отката на `DATABASE_URL` нет. Прикладной пул не импортируется намеренно (Ю23):
 * `src/db/client` тянет `src/config`, а тот валидирует **весь** env приложения, и прогон стал бы
 * заложником портальных секретов, которых у оператора в окне выката может не быть.
 *
 * ЧТО УМЕЕТ:
 *
 *   (без флагов)     dry-run: считает и печатает отчёт, не записывая ни строки
 *   --apply          запись: та же работа, но история материализуется
 *   --state=ПУТЬ     файл состояния прогона; с ним прерванный прогон продолжается с места обрыва
 *   --asof=ДАТА      день, на который считается валидность (по умолчанию сегодня, МСК)
 *   --limit=N        обработать не больше N заявок (замер и пробный прогон)
 *   --report=ПУТЬ    полный отчёт в файл: на экран идёт только выжимка
 *   --restart        начать заново, забыв сохранённое состояние
 *   --progress=N     печатать строку хода каждые N заявок (0 — молча)
 *   --max-failures=N оборвать прогон после N отказов подряд по заявкам (по умолчанию 20)
 *
 * Коды возврата: 0 — прогон закончен, разбирать нечего; 3 — прогон закончен, но есть блокирующие
 * строки (их обязан разобрать человек); 1 — прогон не закончен; 2 — ошибка в аргументах.
 *
 * Локально (dev-база, прикладного `DATABASE_URL` в окружении нет):
 *
 *   DATABASE_MAINTENANCE_URL=postgres://technic:technic@127.0.0.1:5433/technic \
 *     pnpm --filter @technic/api assignment:backfill --report=/tmp/backfill.txt
 *
 * На площадке — тем же профилем инструментов, что и дверь режима:
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools \
 *     run --rm assignment-backfill --apply --state=/var/lib/technic/backfill.json
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** Прогон закончен, но остались заявки, которые обязан разобрать человек. */
const EXIT_BLOCKING = 3;

/** Сколько блокирующих строк печатать на экран: полный список идёт в `--report`. */
const SAMPLE_LIMIT = 20;
/** Размер страницы выборки. Работа идёт по одной заявке, страницами берутся только их номера. */
const PAGE_SIZE = 500;
/** Повторов транзакции заявки при конфликте сериализации: прогон идёт рядом с живым порталом. */
const RETRY_LIMIT = 3;
/** Версия формата файла состояния: чужой формат лучше отвергнуть, чем прочитать наполовину. */
const STATE_VERSION = 1;
/**
 * Как часто состояние сбрасывается на диск.
 *
 * Не «после каждой заявки», и это измерено: файл состояния несёт **весь** блокирующий отчёт, то
 * есть растёт вместе с ним, — запись его на каждой заявке делает прогон квадратичным. На замере
 * 17 205 заявок с 1620 блокирующими строками цена страницы в 2000 заявок росла с 7 до 13 секунд
 * ровно по этой причине.
 *
 * Плата за редкий сброс названа честно: прерванный прогон переделывает не больше сотни заявок
 * (переделка безобидна — заявка с историей в выборку уже не попадает), но счётчик «стало ready» в
 * возобновлённом прогоне может недосчитать эту сотню: их состояние сменилось, и вторая выборка их
 * не видит. Точное число всегда даёт таблица популяции — она читается из базы, а не из счётчиков.
 */
const STATE_FLUSH_EVERY = 100;

class UsageError extends Error {}

// ───────────────────────────────── разбор аргументов ─────────────────────────────────

type Flags = Map<string, string>;

const KNOWN_FLAGS = new Set([
  'apply',
  'state',
  'asof',
  'limit',
  'report',
  'restart',
  'progress',
  'max-failures',
  'help',
]);

/** `--флаг=значение` и `--флаг` (то же, что `--флаг=1`). Позиционных аргументов у прогона нет. */
function parseArgs(argv: readonly string[]): Flags {
  const flags: Flags = new Map();
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      throw new UsageError(`Неожиданный аргумент: ${raw} (ожидались флаги вида --state=…)`);
    }
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw.slice(2) : raw.slice(2, eq);
    if (!KNOWN_FLAGS.has(name)) throw new UsageError(`Неизвестный флаг --${name}`);
    flags.set(name, eq < 0 ? '1' : raw.slice(eq + 1));
  }
  return flags;
}

function boolFlag(flags: Flags, name: string): boolean {
  const value = flags.get(name);
  return value !== undefined && value !== '0' && value !== 'false';
}

function intFlag(flags: Flags, name: string, fallback: number): number {
  const raw = flags.get(name)?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`--${name}=${raw}: ожидалось целое неотрицательное число`);
  }
  return value;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function dateFlag(flags: Flags, name: string): string | undefined {
  const raw = flags.get(name)?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (!DATE_RE.test(raw)) throw new UsageError(`--${name}=${raw}: ожидалась дата вида 2026-08-21`);
  return raw;
}

// ───────────────────────────────── соединение ─────────────────────────────────

type Access = { source: 'DATABASE_MAINTENANCE_URL' | 'DATABASE_MIGRATION_URL'; url: string };

/**
 * Выбор доступа — тот же порядок и тот же запрет, что у двери режима (П7): `DATABASE_URL` не
 * подставляется никогда. Прогон пишет историю всей базы, и открывать его прикладными кредами
 * значит вернуть ровно ту границу, ради которой административный контур заведён.
 */
function resolveAccess(): Access {
  const maintenance = process.env.DATABASE_MAINTENANCE_URL?.trim();
  const migration = process.env.DATABASE_MIGRATION_URL?.trim();
  if (maintenance) return { source: 'DATABASE_MAINTENANCE_URL', url: maintenance };
  if (migration) return { source: 'DATABASE_MIGRATION_URL', url: migration };
  throw new Error(
    'Массовый бэкфилл не ходит прикладными кредами: задайте DATABASE_MAINTENANCE_URL ' +
      'или, пока контур не разделён, DATABASE_MIGRATION_URL. DATABASE_URL здесь не используется ' +
      'намеренно — см. П7 плана assignment-periods.',
  );
}

/**
 * Пул на одно соединение. `max: 1` — не экономия, а требование однопоточности (спайк §4.3):
 * два соединения этого прогона стали бы двумя одновременными писателями портала.
 */
function buildPool(access: Access): pg.Pool {
  const caPath = process.env.PGSSLROOTCERT;
  const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
  const url = new URL(access.url);
  url.searchParams.delete('sslmode');
  return new pg.Pool({
    connectionString: url.toString(),
    max: 1,
    ssl: ca ? { ca, rejectUnauthorized: true } : false,
  });
}

type Handle = ReturnType<typeof drizzle<typeof schema>>;

// ───────────────────────────────── состояние прогона ─────────────────────────────────

/**
 * Строка, которую обязан разобрать человек.
 *
 * Видов по существу два, и различать их важно. `no_assignment`, `ambiguous_sheets` и
 * `overlapping_sheets` означают, что не записано ничего: заявка осталась `empty` и предикат
 * cutover её не пропустит. `blockers` означает, что история записана, но на изменяемых днях
 * собственного отрезка машиниста нет (§6 п. 6, Р16) — такую заявку доводит до `ready` дверь
 * ремонта (Р29). `failed` — неожиданный отказ самой двери; он тоже разбирается человеком, а не
 * прячется в счётчик.
 */
interface BlockingRow {
  num: number;
  kind: 'no_assignment' | 'ambiguous_sheets' | 'overlapping_sheets' | 'blockers' | 'failed';
  detail: string;
}

/** Расхождение хвоста (Р30) — предупреждение: заявка `ready`, разбирается обычными дверями. */
interface WarningRow {
  num: number;
  detail: string;
}

interface Counters {
  processed: number;
  ready: number;
  materialized: number;
  stillEmpty: number;
  rowsWritten: number;
  failed: number;
}

interface RunState {
  version: number;
  mode: 'dry-run' | 'apply';
  asOf: string;
  startedAt: string;
  finishedAt: string | null;
  /** Идентификатор последней учтённой заявки. Он же порядок обхода и точка возобновления. */
  cursor: string | null;
  counters: Counters;
  reasons: Record<string, number>;
  blocking: BlockingRow[];
  warnings: WarningRow[];
  /** Сколько времени потрачено всеми отрезками прогона суммарно, мс. */
  elapsedMs: number;
}

function freshState(mode: RunState['mode'], asOf: string): RunState {
  return {
    version: STATE_VERSION,
    mode,
    asOf,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cursor: null,
    counters: {
      processed: 0,
      ready: 0,
      materialized: 0,
      stillEmpty: 0,
      rowsWritten: 0,
      failed: 0,
    },
    reasons: {},
    blocking: [],
    warnings: [],
    elapsedMs: 0,
  };
}

/**
 * Прочитать сохранённое состояние — и отвергнуть чужое.
 *
 * Проверок три, и каждая закрывает свой способ получить бессмысленный отчёт: версия формата —
 * файл от другой сборки; режим — продолжение записи под видом dry-run (и наоборот); `asOf` —
 * продолжение вчерашнего прогона сегодня. Последнее не мелочь: состояние пишется вместе с
 * `assignment_history_validated_on`, и заявки второго дня получили бы вчерашнюю дату проверки, а
 * предикат cutover требует одного дня на всех (З2).
 */
function readState(path: string, mode: RunState['mode'], asOf: string): RunState | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const state = JSON.parse(raw) as RunState;
  if (state.version !== STATE_VERSION) {
    throw new Error(
      `Файл состояния ${path} записан форматом ${state.version}, а прогон понимает ${STATE_VERSION}: начните заново (--restart)`,
    );
  }
  if (state.mode !== mode) {
    throw new Error(
      `Файл состояния ${path} принадлежит прогону «${state.mode}», а запущен «${mode}»: возьмите другой файл либо --restart`,
    );
  }
  if (state.asOf !== asOf) {
    throw new Error(
      `Файл состояния ${path} считает валидность на ${state.asOf}, а прогон запущен на ${asOf}. ` +
        'Продолжать нельзя: заявки получили бы разные даты проверки, а cutover требует одной (З2). ' +
        `Либо повторите прежний день (--asof=${state.asOf}), либо начните заново (--restart).`,
    );
  }
  return state;
}

function writeState(path: string, state: RunState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// ───────────────────────────────── выборка популяции ─────────────────────────────────

/**
 * Предикат готовности Р20 с расширением Р28 — из общего модуля, а не своей копией.
 *
 * Он же считает готовность в сводке (`scripts/assignment-report.ts`) и в метриках `/metrics`.
 * Две копии предиката cutover означали бы, что «требуют готовности» у прогона и «требуют
 * готовности» у отчёта считаются по разным множествам заявок, — а различить это по числам нельзя.
 * Псевдонимы фиксированы модулем: `r` — `vehicle_requests`, `d` — детали спецтехники.
 */
const POPULATION = ASSIGNMENT_READINESS_POPULATION;

interface Population {
  total: number;
  empty: number;
  materialized: number;
  ready: number;
  [column: string]: number;
}

async function readPopulation(db: Handle): Promise<Population> {
  const [row] = (
    await db.execute<Population>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE r.assignment_history_state = 'empty')::int AS empty,
             count(*) FILTER (WHERE r.assignment_history_state = 'materialized')::int AS materialized,
             count(*) FILTER (WHERE r.assignment_history_state = 'ready')::int AS ready
        FROM vehicle_requests r
        JOIN special_equipment_request_details d ON d.request_id = r.id
       WHERE ${POPULATION}`)
  ).rows;
  if (!row) throw new Error('База не ответила на подсчёт популяции');
  return row;
}

/**
 * Очередная страница заявок к обработке — только те, у кого истории нет вовсе.
 *
 * Отбор по `empty` — это и есть запрет пересборки (Д3): заявка, у которой история появилась (или
 * была отменена человеком до пустоты, но состояние осталось `materialized`), в выборку не попадает
 * никогда. Порядок по `id` — он же курсор возобновления: устойчив к любым правкам данных, в
 * отличие от порядка по номеру или по дате.
 */
async function nextPage(
  db: Handle,
  after: string | null,
  limit: number,
): Promise<{ id: string; num: number }[]> {
  const rows = await db.execute<{ id: string; num: number }>(sql`
    SELECT r.id, r.num
      FROM vehicle_requests r
      JOIN special_equipment_request_details d ON d.request_id = r.id
     WHERE ${POPULATION}
       AND r.assignment_history_state = 'empty'
       ${after === null ? sql`` : sql`AND r.id > ${after}::uuid`}
     ORDER BY r.id
     LIMIT ${limit}`);
  return [...rows.rows];
}

// ───────────────────────────────── человеческие подписи ─────────────────────────────────

/** Листы для отчёта: «серия № номер». Uuid человеку не говорит ничего, а разбирать ему. */
async function labelSheets(db: Handle, ids: readonly string[]): Promise<string> {
  if (ids.length === 0) return '—';
  const rows = await db
    .select({ code: schema.waybillSeries.code, number: schema.waybills.number })
    .from(schema.waybills)
    .leftJoin(schema.waybillSeries, eq(schema.waybillSeries.id, schema.waybills.seriesId))
    .where(inArray(schema.waybills.id, [...ids]))
    .orderBy(asc(schema.waybills.number));
  return rows.map((row) => `${row.code ?? '?'} № ${row.number}`).join(', ');
}

/** Машина для отчёта: госномер, а при его отсутствии — инвентарный или гаражный. */
async function labelVehicle(db: Handle, id: string): Promise<string> {
  const [row] = await db
    .select({
      registrationNumber: schema.vehicles.registrationNumber,
      inventoryNumber: schema.vehicles.inventoryNumber,
      garageNumber: schema.vehicles.garageNumber,
    })
    .from(schema.vehicles)
    .where(eq(schema.vehicles.id, id));
  if (!row) return '(машина не найдена)';
  return (
    [row.registrationNumber, row.inventoryNumber, row.garageNumber].find(
      (value): value is string => typeof value === 'string' && value !== '',
    ) ?? '(без номера)'
  );
}

// ───────────────────────────────── обработка одной заявки ─────────────────────────────────

interface Outcome {
  state: 'empty' | 'materialized' | 'ready';
  unrestorable: readonly AssignmentHistoryUnrestorable[];
  blockers: readonly { date: string; kind: 'unknown' | 'cleared' }[];
  warnings: readonly { historyVehicleId: string; assignmentVehicleId: string }[];
  /** Строк истории: записанных (`--apply`) либо тех, что были бы записаны (dry-run). */
  written: number;
}

/**
 * Dry-run одной заявки: расчёт без единой записи, и это свойство держит **база**, а не дисциплина.
 *
 * Транзакция объявляется `READ ONLY` первым же запросом, поэтому случайная запись здесь упадёт
 * отказом PostgreSQL, а не уедет в базу. «Dry-run ничего не пишет» — главное свойство режима, и
 * проверяться оно должно чем-то, что нельзя забыть обновить вслед за кодом.
 *
 * Строку заявки dry-run намеренно **не** блокирует: писать ему нечего, а `FOR UPDATE` посреди
 * рабочего дня останавливал бы диспетчеров ради замера.
 */
async function planOne(db: Handle, requestId: string, asOf: string): Promise<Outcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const snapshot = await readAssignmentHistorySnapshot(tx, requestId);
    const computed = computeAssignmentHistory(snapshot, asOf);
    return {
      state: computed.state,
      unrestorable: computed.unrestorable,
      blockers: computed.blockers,
      warnings: computed.warnings,
      written: computed.mutations.length,
    };
  });
}

/**
 * Запись истории одной заявки — одна транзакция на заявку.
 *
 * Единица именно заявка: история заявки атомарна (пара строк одной группы гаснет вместе, Г2), а
 * пакет из сотни заявок в одной транзакции держал бы сотню блокировок строк и рушился бы целиком
 * из-за одной. Порядок захвата канонический — строка заявки первой операцией (этап 2a,
 * подтверждено спайком §4.3): при конфликте отказ приходит на первом же запросе, и выброшенной
 * работы ноль. Блокировка берётся здесь своим запросом, а не через `lockRequestRow`: тот живёт в
 * `services/vehicle-routes.ts`, который импортирует прикладной пул, — а прогон обязан работать без
 * портального окружения (Ю23).
 */
async function ensureOne(db: Handle, requestId: string, asOf: string): Promise<Outcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM vehicle_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    const ensured = await ensureAssignmentHistory(tx, { requestId, asOf });
    if (ensured.state === 'empty') {
      return {
        state: 'empty' as const,
        unrestorable: ensured.unrestorable,
        blockers: [],
        warnings: [],
        written: 0,
      };
    }
    return {
      state: ensured.state,
      unrestorable: [],
      blockers: ensured.blockers,
      warnings: ensured.warnings,
      written: ensured.materialized.length,
    };
  });
}

/** Конфликт сериализации или разорванный клинч: повторяется, всё остальное — отказ по существу. */
function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === '40001' || code === '40P01';
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= RETRY_LIMIT || !isRetryable(error)) throw error;
    }
  }
}

// ───────────────────────────────── учёт исхода ─────────────────────────────────

/** Короткие подписи причин для таблицы счётчиков; развёрнутые слова даёт сама дверь. */
const REASON_TITLE: Record<string, string> = {
  no_assignment: 'техника не назначена',
  ambiguous_sheets: 'два листа на одну дату',
  overlapping_sheets: 'периоды листов пересекаются',
  blockers: 'нет машиниста на изменяемых днях',
  failed: 'отказ двери истории',
};

/**
 * Учёт исхода одной заявки: счётчики, причины и строки отчёта.
 *
 * Подписи для человека (номера листов, госномер машины) разрешаются здесь же, а не при печати:
 * прогон возобновляемый, и отчёт после обрыва собирается из сохранённого файла, где uuid'ов уже
 * нет. Лишний запрос платится только за проблемную заявку.
 *
 * Слова причин берутся у `assignmentHistoryUnrestorableReason` — той же функции, которой
 * отказывают двери. Вторая формулировка тех же причин разошлась бы с первой ровно тогда, когда
 * человек читает отчёт и ищет заявку по знакомому тексту.
 */
async function record(
  db: Handle,
  state: RunState,
  request: { id: string; num: number },
  outcome: Outcome,
): Promise<void> {
  state.counters.rowsWritten += outcome.written;
  if (outcome.state === 'ready') state.counters.ready += 1;
  if (outcome.state === 'materialized') state.counters.materialized += 1;

  for (const warning of outcome.warnings) {
    state.warnings.push({
      num: request.num,
      detail:
        `хвост истории — ${await labelVehicle(db, warning.historyVehicleId)}, ` +
        `в назначении — ${await labelVehicle(db, warning.assignmentVehicleId)} (Р30)`,
    });
  }

  if (outcome.state === 'empty') {
    state.counters.stillEmpty += 1;
    for (const reason of outcome.unrestorable) {
      state.reasons[reason.kind] = (state.reasons[reason.kind] ?? 0) + 1;
      const sheets =
        reason.kind === 'ambiguous_sheets' || reason.kind === 'overlapping_sheets'
          ? `: ${await labelSheets(db, reason.waybillIds)}`
          : '';
      state.blocking.push({
        num: request.num,
        kind: reason.kind,
        detail: `${assignmentHistoryUnrestorableReason([reason])}${sheets}`,
      });
    }
    return;
  }

  if (outcome.state === 'materialized') {
    state.reasons.blockers = (state.reasons.blockers ?? 0) + 1;
    const dates = outcome.blockers.map((blocker) => blocker.date).sort();
    const kinds = [...new Set(outcome.blockers.map((blocker) => blocker.kind))].join(' и ');
    const span = dates.length > 0 ? `${dates[0]}…${dates[dates.length - 1]}` : '—';
    state.blocking.push({
      num: request.num,
      kind: 'blockers',
      detail:
        `нет машиниста на изменяемых днях: ${outcome.blockers.length} дн. (${span}), ` +
        `вид «${kinds}» — доводится дверью ремонта (Р29)`,
    });
  }
}

// ───────────────────────────────── отчёт ─────────────────────────────────

function pad(value: number | string, width: number): string {
  return String(value).padStart(width);
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

function renderReport(
  state: RunState,
  population: { before: Population; after: Population },
  header: readonly string[],
  full: boolean,
): string {
  const c = state.counters;
  const lines: string[] = header.length > 0 ? [...header, ''] : [];

  lines.push(
    `${'Популяция (Р20 + архивные Р28)'.padEnd(38)}${pad('до прогона', 10)}${pad('после', 10)}`,
  );
  const row = (title: string, before: number, after: number): void => {
    lines.push(`  ${title.padEnd(36)}${pad(before, 10)}${pad(after, 10)}`);
  };
  row('требуют готовности', population.before.total, population.after.total);
  row('в состоянии ready', population.before.ready, population.after.ready);
  row('в состоянии materialized', population.before.materialized, population.after.materialized);
  row('в состоянии empty', population.before.empty, population.after.empty);
  lines.push('');

  const perSecond = state.elapsedMs > 0 ? (c.processed / (state.elapsedMs / 1000)).toFixed(1) : '—';
  lines.push('Итог прогона');
  lines.push(`  обработано заявок                     ${pad(c.processed, 8)}`);
  lines.push(`  стало ready                           ${pad(c.ready, 8)}`);
  lines.push(`  стало materialized                    ${pad(c.materialized, 8)}`);
  lines.push(`  осталось empty (не восстановимо)      ${pad(c.stillEmpty, 8)}`);
  lines.push(`  отказов двери                         ${pad(c.failed, 8)}`);
  lines.push(
    `  строк истории ${state.mode === 'apply' ? 'записано' : 'было бы  '}               ${pad(c.rowsWritten, 8)}`,
  );
  lines.push(
    `  время                                 ${pad(duration(state.elapsedMs), 8)}  (${perSecond} заявок/с)`,
  );
  lines.push('');

  const reasons = Object.entries(state.reasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push('Причины (считаются по заявкам; у одной заявки причин бывает несколько)');
    for (const [kind, count] of reasons) {
      lines.push(`  ${(REASON_TITLE[kind] ?? kind).padEnd(38)}${pad(count, 8)}`);
    }
    lines.push('');
  }

  if (state.warnings.length > 0) {
    lines.push(`Предупреждения (Р30, разбираются обычными дверями): ${state.warnings.length}`);
    const shownWarnings = full ? state.warnings : state.warnings.slice(0, SAMPLE_LIMIT);
    for (const warning of shownWarnings) lines.push(`  ТС-${warning.num}: ${warning.detail}`);
    if (shownWarnings.length < state.warnings.length) {
      lines.push(
        `  … и ещё ${state.warnings.length - shownWarnings.length} (полный список — в --report)`,
      );
    }
    lines.push('');
  }

  if (state.blocking.length === 0) {
    lines.push('БЛОКИРУЮЩИЙ ОТЧЁТ: пусто — разбирать руками нечего.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`БЛОКИРУЮЩИЙ ОТЧЁТ — разбирает человек: ${state.blocking.length} строк`);
  const order: BlockingRow['kind'][] = [
    'failed',
    'ambiguous_sheets',
    'overlapping_sheets',
    'no_assignment',
    'blockers',
  ];
  const sorted = [...state.blocking].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.num - b.num,
  );
  const shown = full ? sorted : sorted.slice(0, SAMPLE_LIMIT);
  for (const item of shown) lines.push(`  ТС-${String(item.num).padEnd(8)}${item.detail}`);
  if (shown.length < sorted.length) {
    lines.push(`  … и ещё ${sorted.length - shown.length} (полный список — в --report)`);
  }
  return `${lines.join('\n')}\n`;
}

const HELP =
  'Массовый бэкфилл истории назначения (этап 4 плана assignment-periods).\n' +
  '  без флагов — dry-run (ничего не пишется); --apply — запись.\n' +
  '  --state=ПУТЬ  файл возобновления      --asof=ДАТА   день расчёта валидности\n' +
  '  --limit=N     предел заявок           --report=ПУТЬ полный отчёт в файл\n' +
  '  --restart     забыть состояние        --progress=N  строка хода каждые N заявок\n' +
  '  --max-failures=N  оборвать после N отказов подряд\n' +
  '  Коды возврата: 0 — чисто, 3 — есть блокирующие строки, 1 — прогон не закончен, 2 — аргументы.\n';

// ───────────────────────────────── прогон ─────────────────────────────────

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (boolFlag(flags, 'help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const apply = boolFlag(flags, 'apply');
  const mode: RunState['mode'] = apply ? 'apply' : 'dry-run';
  const asOf = dateFlag(flags, 'asof') ?? moscowDateKeyOf(new Date());
  const statePath = flags.get('state')?.trim() || null;
  const reportPath = flags.get('report')?.trim() || null;
  const limit = intFlag(flags, 'limit', 0);
  const progressEvery = intFlag(flags, 'progress', 200);
  const maxFailures = intFlag(flags, 'max-failures', 20);

  const access = resolveAccess();
  const pool = buildPool(access);
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  try {
    const [identity] = (
      await db.execute<{ role: string; database: string }>(
        sql`SELECT current_user AS role, current_database() AS database`,
      )
    ).rows;
    const moduleMode = await readAssignmentMode(db);
    const before = await readPopulation(db);

    const stored =
      statePath && !boolFlag(flags, 'restart') ? readState(statePath, mode, asOf) : null;
    const state = stored ?? freshState(mode, asOf);
    const headerOf = (): string[] => [
      `Массовый бэкфилл истории назначения — ${apply ? 'ЗАПИСЬ' : 'dry-run (ничего не пишется)'}`,
      `База: ${identity?.database ?? '?'}, роль ${identity?.role ?? '?'}, доступ ${access.source}`,
      `Режим модуля: запись ${moduleMode.writeMode}, чтение ${moduleMode.readMode}` +
        ' (maintenance-путь идёт мимо гейта по З3)',
      `Валидность считается на ${asOf}` + (limit > 0 ? `; предел прогона — ${limit} заявок` : ''),
      statePath
        ? `Состояние: ${statePath}` + (state.cursor ? ` (продолжение с ${state.cursor})` : '')
        : 'Состояние: не сохраняется (--state не задан) — прерванный прогон начнётся заново',
    ];

    if (state.finishedAt) {
      process.stdout.write(
        `Прогон по файлу ${statePath} завершён ${state.finishedAt} — работы нет. ` +
          'Для нового возьмите --restart или другой файл состояния.\n\n',
      );
      process.stdout.write(renderReport(state, { before, after: before }, headerOf(), false));
      return state.blocking.length > 0 ? EXIT_BLOCKING : 0;
    }

    process.stdout.write(`${headerOf().join('\n')}\n\n`);

    const startedAt = Date.now();
    const baseElapsed = state.elapsedMs;
    let consecutiveFailures = 0;
    let done = 0;
    let stoppedByLimit = false;

    pages: for (;;) {
      const page = await nextPage(db, state.cursor, PAGE_SIZE);
      if (page.length === 0) break;
      // Страница обязана начинаться строго за курсором. Проверка дешёвая и спасает от единственной
      // ошибки этого цикла, у которой нет внешних признаков: не сдвинувшийся курсор даёт не отказ,
      // а вечный прогон по одной и той же странице.
      if (state.cursor !== null && page[0]!.id <= state.cursor) {
        throw new Error(
          `Выборка вернула заявку ${page[0]!.id} не за курсором ${state.cursor}: прогон остановлен, чтобы не идти по кругу`,
        );
      }
      for (const request of page) {
        if (limit > 0 && done >= limit) {
          stoppedByLimit = true;
          break pages;
        }
        let outcome: Outcome | null = null;
        try {
          outcome = await withRetry(() =>
            apply ? ensureOne(db, request.id, asOf) : planOne(db, request.id, asOf),
          );
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          state.counters.failed += 1;
          state.reasons.failed = (state.reasons.failed ?? 0) + 1;
          state.blocking.push({
            num: request.num,
            kind: 'failed',
            detail: `отказ двери истории: ${(error as Error).message}`,
          });
        }

        if (outcome) await record(db, state, request, outcome);
        state.counters.processed += 1;
        // Курсор двигается после учёта заявки — включая ту, что упала: иначе возобновлённый прогон
        // вечно упирался бы в одну и ту же неисправную заявку.
        state.cursor = request.id;
        done += 1;
        state.elapsedMs = baseElapsed + (Date.now() - startedAt);
        if (statePath && state.counters.processed % STATE_FLUSH_EVERY === 0) {
          writeState(statePath, state);
        }

        if (progressEvery > 0 && state.counters.processed % progressEvery === 0) {
          process.stdout.write(
            `  … ${state.counters.processed}: ready ${state.counters.ready}, ` +
              `materialized ${state.counters.materialized}, empty ${state.counters.stillEmpty}, ` +
              `${duration(state.elapsedMs)}\n`,
          );
        }
        if (consecutiveFailures >= maxFailures) {
          throw new Error(
            `Подряд ${consecutiveFailures} отказов по заявкам — прогон остановлен: это похоже не на ` +
              'плохие данные, а на общую поломку. Разберите последние строки блокирующего отчёта.',
          );
        }
      }
    }

    state.elapsedMs = baseElapsed + (Date.now() - startedAt);
    if (!stoppedByLimit) state.finishedAt = new Date().toISOString();
    if (statePath) writeState(statePath, state);

    const after = await readPopulation(db);
    // Шапка на экране уже была напечатана перед работой — в итоговой выжимке она повторялась бы
    // через минуту после самой себя. В файле она нужна: там кроме отчёта нет ничего.
    process.stdout.write(renderReport(state, { before, after }, [], false));
    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, renderReport(state, { before, after }, headerOf(), true), 'utf8');
      process.stdout.write(`\nПолный отчёт: ${reportPath}\n`);
    }
    if (stoppedByLimit) {
      process.stdout.write(
        '\nПрогон остановлен пределом --limit: обработано не всё. ' +
          'Продолжение — тот же --state без --restart.\n',
      );
    }
    return state.blocking.length > 0 ? EXIT_BLOCKING : 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    process.stderr.write(`Прогон не закончен: ${(error as Error).message}\n`);
    process.exitCode = EXIT_FAILURE;
  });
