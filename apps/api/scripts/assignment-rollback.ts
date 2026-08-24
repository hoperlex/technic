import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import * as schema from '../src/db/schema';
// Доступ административного пути — общим модулем: правило «своими кредами и никогда прикладными»
// (П7) живёт в одном месте на все команды maintenance, включая эту.
import {
  APP_ROLE,
  buildMaintenancePool,
  maintenanceAccessLine,
  readMaintenanceIdentity,
  resolveMaintenanceAccess,
} from './maintenance-access';
import { readAssignmentMode } from '../src/services/assignment-mode';

/**
 * Обратный прогон истории назначения — этап 4, волна 4.2 плана `docs/assignment-periods-plan.md`
 * (Д3, Е4, Е5, §10 «Переключение источника истории и откат»).
 *
 * ЗАЧЕМ ОН. Массовый бэкфилл (`scripts/assignment-backfill.ts`) достраивает историю всем заявкам
 * популяции Р20. Это путь вперёд; здесь — путь назад, на случай, когда после выката выясняется,
 * что откатываться надо не forward-fix'ом, а возвращением модуля в состояние «истории нет». Прогон
 * удаляет строки истории и возвращает заявке `assignment_history_state = 'empty'` — то есть ровно
 * то состояние, в котором заявка была до бэкфилла.
 *
 * ЭТО НЕ «УДАЛИТЬ ВСЁ, ЧТО ЗАПИСАЛ БЭКФИЛЛ». Между бэкфиллом и откатом люди работают: диспетчер
 * отменяет строку, администратор чинит историю дверью ремонта, кто-то проводит коррекцию задним
 * числом. Стереть это значит стереть решение человека — а решение человека из бумаги не
 * выводится и после отката не восстанавливается ничем (§10, «Точка невозврата»). Поэтому прогон
 * удаляет историю не там, где «строки похожи на бэкфилл», а только там, где **вся заявка целиком**
 * не несёт ни одного человеческого следа. Предикат обратимости — сердце этого прогона, он выписан
 * ниже одним списком (`HOLDS`), и каждое его условие объяснено там же.
 *
 * ПОЧЕМУ ПРЕДИКАТ НА ЗАЯВКУ, А НЕ НА СТРОКУ (Д3). Прежняя редакция плана предлагала «удалить
 * строки `origin = 'backfill'` без потомков». Этот критерий стирал бы ровно то, ради чего написан:
 * отмена backfill-строки записывается **на ней самой** (`superseded_kind = 'cancelled'`,
 * `superseded_by_user`), потомка иного происхождения у неё нет — и «backfill без потомков»
 * означало бы «в том числе отменённая человеком». Кроме того, у решения хвоста вида `history_wins`
 * строк нет вовсе (Р31): по строкам его не увидеть никак. Единица обратимости поэтому — заявка.
 *
 * ПРОТОКОЛ ПРОТИВ ГОНКИ (Е4). Прогон идёт **после включения kill switch и drain** — при
 * `write_mode = normal` он отказывается работать вовсе, и это не перестраховка: под живой записью
 * отчёт врёт уже в момент печати. По каждой заявке в одной транзакции:
 *
 *   блокировка строки заявки (FOR UPDATE) → ПОВТОРНАЯ проверка полного предиката → удаление → empty
 *
 * Повторная проверка обязательна и при поднятом freeze. Между отбором страницы и транзакцией по
 * заявке проходит время, и решение человека успевает лечь: freeze мог быть снят соседом, дверь
 * могла идти мимо гейта административным путём (З3), а транзакция, начатая до freeze, законно
 * доигрывает своё. Блокировка строки заявки — та же самая, что берут все двери истории
 * (`lockRequestRow`, `FOR UPDATE OF vehicle_requests`), поэтому «успел» и «не успел» решает
 * PostgreSQL, а не порядок наших запросов: опоздавший ждёт на строке, а дождавшись, читает уже
 * закоммиченное решение и уходит в отчёт.
 *
 * ПОЧЕМУ ОТДЕЛЬНОГО DRAIN ЗДЕСЬ НЕТ (Е5). Счётчик активных писателей не заводится и по TTL не
 * чистится: истёкший heartbeat живой транзакции показал бы оператору ноль. Drain уже сделан самой
 * сменой режима — она берёт управляющую строку `UPDATE`, а каждая пишущая транзакция держит её
 * `FOR SHARE` первым запросом (Ж3), — и повторять его нечем и незачем. Прогон проверяет режим и
 * полагается на блокировку заявки, а не на счётчики.
 *
 * ЧЕГО ПРОГОН НЕ ДЕЛАЕТ:
 *
 * - **не трогает назначение и бумагу.** Удаляются строки истории и три колонки готовности у
 *   заявки — весь след бэкфилла и ничего кроме. `vehicle_request_assignments`, путевые листы и
 *   журнал коррекций остаются как есть: откат возвращает модуль к состоянию «истории нет», а не
 *   отменяет работу портала;
 * - **не пересобирает и не чинит.** Заявка, не прошедшая предикат, остаётся ровно такой, какой
 *   была, и попадает в отчёт с указанием, что именно её удержало. Разбирает человек;
 * - **не меняет режим модуля.** Заморозку включает и снимает `assignment:mode`; прогон её только
 *   читает и без неё не работает;
 * - **не чистит поколения теневого сравнения и `cutover_run_id`.** Это аудит: чем и когда было
 *   обосновано переключение, обязано пережить откат — §10 прямо требует, чтобы возврат в `legacy`
 *   ссылку не стирал. Расхождения поколения, снятые по заявкам, которых больше нет, читаются как
 *   есть: они описывают прошлое состояние базы, а не сегодняшнее.
 *
 * ОДНОПОТОЧНЫЙ — по той же причине, что и бэкфилл (спайк `docs/assignment-periods-spike.md` §4.3):
 * `W` одновременных писателей по общей строке дают `k`-му `k` попыток, и пул здесь `max: 1` —
 * часть контракта, а не настройка производительности.
 *
 * СЛЕД ПРОГОНА — ФАЙЛ ОТЧЁТА, а не таблица в базе. Своей таблицы у отката нет намеренно: она
 * означала бы миграцию, а откат обязан выкатываться тем же образом, что и всё остальное. Что и
 * когда удалено, доказывают `--report` и `--state`, которые оператор кладёт рядом с runbook'ом.
 *
 * ЧТО УМЕЕТ:
 *
 *   (без флагов)     dry-run: считает и печатает отчёт, не удаляя ни строки
 *   --apply          удаление: та же работа, но история стирается и заявка становится `empty`
 *   --state=ПУТЬ     файл состояния прогона; с ним прерванный прогон продолжается с места обрыва
 *   --limit=N        обработать не больше N заявок (замер и пробный прогон)
 *   --report=ПУТЬ    полный отчёт в файл: на экран идёт только выжимка
 *   --restart        начать заново, забыв сохранённое состояние
 *   --progress=N     печатать строку хода каждые N заявок (0 — молча)
 *   --max-failures=N оборвать прогон после N отказов подряд по заявкам (по умолчанию 20)
 *
 * Коды возврата: 0 — откачено всё, удержанных нет; 3 — прогон закончен, но есть удержанные заявки
 * (их обязан разобрать человек); 4 — модуль не заморожен либо чтение уже переключено на историю:
 * прогон не начинался; 1 — прогон не закончен; 2 — ошибка в аргументах.
 *
 * Локально (dev-база, прикладного `DATABASE_URL` в окружении нет):
 *
 *   DATABASE_MAINTENANCE_URL=postgres://technic:technic@127.0.0.1:5433/technic \
 *     pnpm --filter @technic/api assignment:rollback --report=/tmp/rollback.txt
 *
 * На площадке — тем же профилем инструментов, что и дверь режима:
 *
 *   assignment:mode set --write=history_frozen --actor=… --reason='откат истории' --build=<sha>
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools \
 *     run --rm assignment-rollback --apply --state=/var/lib/technic/rollback.json
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** Прогон закончен, но остались заявки, которые обязан разобрать человек. */
const EXIT_HELD = 3;
/** Прогон не начинался: модуль не заморожен либо чтение уже идёт из истории. */
const EXIT_NOT_FROZEN = 4;

/** Сколько удержанных заявок печатать на экран: полный список идёт в `--report`. */
const SAMPLE_LIMIT = 20;
/** Сколько строк объяснения показывать по одной заявке: остальное человек увидит в базе. */
const EXPLAIN_LIMIT = 3;
/** Размер страницы выборки. Работа идёт по одной заявке, страницами берутся только их номера. */
const PAGE_SIZE = 500;
/** Повторов транзакции заявки при конфликте сериализации. */
const RETRY_LIMIT = 3;
/** Версия формата файла состояния: чужой формат лучше отвергнуть, чем прочитать наполовину. */
const STATE_VERSION = 1;
/**
 * Как часто состояние сбрасывается на диск. Не «после каждой заявки» по той же причине, что у
 * бэкфилла: файл несёт весь отчёт об удержанных и растёт вместе с ним, а запись его на каждой
 * заявке делает прогон квадратичным. Прерванный прогон переделывает не больше сотни заявок, и
 * переделка безобидна — откаченная заявка в выборку уже не попадает.
 */
const STATE_FLUSH_EVERY = 100;

class UsageError extends Error {}

// ───────────────────────────────── разбор аргументов ─────────────────────────────────

type Flags = Map<string, string>;

const KNOWN_FLAGS = new Set([
  'apply',
  'state',
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

type Handle = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Handle['transaction']>[0]>[0];
type Reader = Handle | Tx;

// ═════════════════════════ ПРЕДИКАТ ОБРАТИМОСТИ ═════════════════════════
//
// Заявка обратима тогда и только тогда, когда НЕ выполнено ни одно из условий удержания ниже.
// Условия перечислены списком, а не написаны одним выражением, ровно затем, чтобы предикат и
// объяснение «что именно её удержало» строились из ОДНОГО источника: выражение для `WHERE`
// собирается из `condition`, а строки отчёта — из `explain` тех же самых записей. Разъехаться им
// негде, и добавить условие, забыв про отчёт, тоже нельзя.
//
// Общее правило чтения списка: каждое условие ловит СВОЙ способ, которым в заявке появляется
// человеческое решение. Пересечения между условиями есть и они намеренны — след решения обязан
// быть виден и тогда, когда одна из колонок не заполнена.

/** Что именно удержало заявку: вид, заголовок для счётчика и строки для человека. */
interface Hold {
  kind: string;
  /** Короткая подпись для таблицы причин. */
  title: string;
  /** Условие удержания: TRUE — заявку откатывать нельзя. `ref` — ссылка на идентификатор заявки. */
  condition: (ref: SQL) => SQL;
  /** Строки объяснения для отчёта: кто, что и когда. Пусто — условие не сработало. */
  explain: (reader: Reader, requestId: string) => Promise<string[]>;
}

/** Дата и время по-московски: отчёт читает человек, а не машина. */
const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function when(value: Date | string | null): string {
  if (value === null) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${moscow.format(date)} МСК`;
}

/** Строки объяснения одним запросом: у каждого условия своя выборка, но общий вид результата. */
async function rows<T extends Record<string, unknown>>(reader: Reader, query: SQL): Promise<T[]> {
  // Приведение — из-за `Assume<T, QueryResultRow>` в сигнатуре drizzle: тот же приём, что у
  // соседних прогонов, форму строки здесь задаёт запрос, а не вывод типов.
  return [...(await reader.execute<T>(query)).rows] as unknown as T[];
}

const CHANGES = sql`vehicle_request_assignment_changes`;

/**
 * Условия удержания — по одному на каждый способ, которым в истории заявки появляется человек.
 *
 * Порядок в списке — порядок разбора для человека: сначала то, что говорит «решение принято и
 * записано», потом то, что говорит «решение принято, а строк у него нет».
 */
const HOLDS: readonly Hold[] = [
  {
    kind: 'human_row',
    title: 'строку истории вписал человек',
    /*
     * ЧТО ЛОВИТ. Строку, у которой назван автор. `created_by IS NULL` — это подпись бэкфилла и
     * только его: и массовый прогон, и ленивый зовут ядро записи с `actorUserId: null` именно
     * затем, чтобы не называть автором решения того, кто его не принимал. Любая дверь истории —
     * команда машиниста, коррекция назначения, смена техники, ремонт, решение хвоста — пишет
     * `created_by` своего исполнителя.
     *
     * ПОЧЕМУ БЕЗ НЕГО ОТКАТ СОТРЁТ РЕШЕНИЕ. Это самый прямой случай: человек назвал машиниста на
     * отрезок, которого в бумаге нет. Из бумаги эта строка не выводится ничем, и после удаления
     * повторный бэкфилл её не вернёт — он честно напишет `unknown`.
     *
     * Считаются и погашенные строки тоже (`superseded_at` здесь не спрашивается): погашенная
     * строка человека — это два решения, а не ноль.
     */
    condition: (ref) =>
      sql`EXISTS (SELECT 1 FROM ${CHANGES} c WHERE c.request_id = ${ref} AND c.created_by IS NOT NULL)`,
    explain: async (reader, id) =>
      (
        await rows<{ d: string; dimension: string; origin: string; who: string }>(
          reader,
          sql`SELECT c.effective_date::text AS d, c.dimension, c.origin,
                     coalesce(u.full_name, u.email, c.created_by::text) AS who
                FROM ${CHANGES} c
                LEFT JOIN users u ON u.id = c.created_by
               WHERE c.request_id = ${id}::uuid AND c.created_by IS NOT NULL
               ORDER BY c.effective_date, c.dimension`,
        )
      ).map(
        (row) => `строку от ${row.d} (${row.dimension}, ${row.origin}) вписал(а) ${row.who}`,
      ),
  },
  {
    kind: 'foreign_origin',
    title: 'строка не бэкфилльного происхождения',
    /*
     * ЧТО ЛОВИТ. Строку с любым `origin`, кроме `backfill`: `assignment`, `reassignment`,
     * `machinist_change`, `tail_resolution`, `known_fill`, `unknown_remainder`.
     *
     * ЗАЧЕМ ОН, ЕСЛИ ЕСТЬ ПРЕДЫДУЩИЙ. Условия отвечают на разные вопросы: `created_by` — «кто
     * решил», `origin` — «какая дверь записала». Сегодня они совпадают, и это совпадение
     * держится дисциплиной пяти дверей, а не схемой: `created_by` разрешено быть NULL, и
     * шестая дверь, забывшая исполнителя (или строка, вписанная руками в psql при разборе
     * аварии), прошла бы первое условие насквозь. Здесь же цена ошибки — стёртое решение,
     * поэтому провенанс спрашивается двумя независимыми колонками.
     *
     * ОТДЕЛЬНО ПРО `known_fill` И `unknown_remainder` (Ю2, Ш4). Это заполнение `unknown`:
     * человек назвал машиниста там, где история его не знала, а сервер дописал границу остатка.
     * По составу такая пара неотличима от обычной смены машиниста — различает их только
     * `origin`, и потерять эту пару значит вернуть известного человека обратно в «не знаем».
     */
    condition: (ref) =>
      sql`EXISTS (SELECT 1 FROM ${CHANGES} c WHERE c.request_id = ${ref} AND c.origin <> 'backfill')`,
    explain: async (reader, id) =>
      (
        await rows<{ d: string; dimension: string; origin: string }>(
          reader,
          sql`SELECT c.effective_date::text AS d, c.dimension, c.origin
                FROM ${CHANGES} c
               WHERE c.request_id = ${id}::uuid AND c.origin <> 'backfill'
               ORDER BY c.effective_date, c.dimension`,
        )
      ).map((row) => `строка от ${row.d} (${row.dimension}) с origin «${row.origin}»`),
  },
  {
    kind: 'correction_row',
    title: 'строка рождена операцией журнала коррекций',
    /*
     * ЧТО ЛОВИТ. Строку с `correction_id`: она появилась внутри операции журнала коррекций —
     * то есть задним числом и с обоснованием, которое кто-то писал руками.
     *
     * ПОЧЕМУ БЕЗ НЕГО ОТКАТ СОТРЁТ РЕШЕНИЕ. Журнал коррекций переживёт удаление истории: ссылка
     * `correction_id` стоит с `ON DELETE RESTRICT` в сторону `waybill_corrections`, а не наоборот.
     * Стерев строку, мы оставили бы в журнале запись «такого-то числа исправили состав по такой-то
     * причине», за которой в истории не стоит ничего. Это хуже, чем потерянная строка: это
     * обоснование без предмета, и через полгода по нему не восстановить, что именно исправляли.
     */
    condition: (ref) =>
      sql`EXISTS (SELECT 1 FROM ${CHANGES} c WHERE c.request_id = ${ref} AND c.correction_id IS NOT NULL)`,
    explain: async (reader, id) =>
      (
        await rows<{ d: string; kind: string; at: Date; who: string; reason: string }>(
          reader,
          sql`SELECT c.effective_date::text AS d, w.kind, w.created_at AS at,
                     coalesce(u.full_name, u.email, w.actor_user_id::text) AS who, w.reason
                FROM ${CHANGES} c
                JOIN waybill_corrections w ON w.id = c.correction_id
                LEFT JOIN users u ON u.id = w.actor_user_id
               WHERE c.request_id = ${id}::uuid
               ORDER BY c.effective_date`,
        )
      ).map(
        (row) =>
          `строка от ${row.d} рождена операцией «${row.kind}» ${when(row.at)}, ${row.who}: ${row.reason}`,
      ),
  },
  {
    kind: 'superseded',
    title: 'строку погасил человек (отмена или замена)',
    /*
     * ГЛАВНОЕ УСЛОВИЕ СПИСКА (Д3). Отмена backfill-строки хранится НА НЕЙ САМОЙ: `superseded_at`,
     * `superseded_by_user`, `superseded_kind = 'cancelled'`. Ни новой строки, ни потомка у такой
     * отмены нет — и критерий «удалить `origin = 'backfill'` без потомков», который стоял в
     * прежней редакции плана, стирал бы именно её. Диспетчер сказал «этой смены машиниста не
     * было», а откат вернул бы её обратно — молча и без следа.
     *
     * СПРАШИВАЕТСЯ `superseded_at`, А НЕ `superseded_by_user`. Схема связывает три колонки
     * погашения одним CHECK'ом, так что сегодня это одно и то же. Но условие обязано ловить факт
     * «строка погашена» независимо от того, заполнено ли имя: погашение без автора — это
     * повреждение данных, и откатывать такую заявку тем более нельзя.
     */
    condition: (ref) =>
      sql`EXISTS (SELECT 1 FROM ${CHANGES} c WHERE c.request_id = ${ref} AND c.superseded_at IS NOT NULL)`,
    explain: async (reader, id) =>
      (
        await rows<{ d: string; dimension: string; kind: string; at: Date; who: string }>(
          reader,
          sql`SELECT c.effective_date::text AS d, c.dimension,
                     coalesce(c.superseded_kind, '?') AS kind, c.superseded_at AS at,
                     coalesce(u.full_name, u.email, c.superseded_by_user::text, '(автор не назван)') AS who
                FROM ${CHANGES} c
                LEFT JOIN users u ON u.id = c.superseded_by_user
               WHERE c.request_id = ${id}::uuid AND c.superseded_at IS NOT NULL
               ORDER BY c.superseded_at`,
        )
      ).map(
        (row) =>
          `строку от ${row.d} (${row.dimension}) ${row.kind === 'cancelled' ? 'отменил(а)' : 'заменил(а)'} ` +
          `${row.who} ${when(row.at)} (${row.kind})`,
      ),
  },
  {
    kind: 'supersedes',
    title: 'строка заменяет чужое решение',
    /*
     * ЧТО ЛОВИТ. Строку-наследницу: `supersedes_change_id` назван, значит она встала на место
     * другой. Бэкфилл наследниц не пишет вовсе — он вставляет историю там, где её нет, и цели для
     * замены у него не бывает.
     *
     * ЗАЧЕМ ОН ОТДЕЛЬНО ОТ `superseded`. То условие смотрит на предка, это — на потомка. Разница
     * не теоретическая: замена и заменяемая строка живут в одной заявке, но условие «есть
     * погашенная» проверяет прошлое решения, а «есть наследница» — его результат. Если однажды
     * появится путь, вписывающий наследницу без гашения предка (ошибка в новой двери), первое
     * условие промолчит, а это удержит заявку.
     */
    condition: (ref) =>
      sql`EXISTS (SELECT 1 FROM ${CHANGES} c WHERE c.request_id = ${ref} AND c.supersedes_change_id IS NOT NULL)`,
    explain: async (reader, id) =>
      (
        await rows<{ d: string; dimension: string; origin: string }>(
          reader,
          sql`SELECT c.effective_date::text AS d, c.dimension, c.origin
                FROM ${CHANGES} c
               WHERE c.request_id = ${id}::uuid AND c.supersedes_change_id IS NOT NULL
               ORDER BY c.effective_date`,
        )
      ).map(
        (row) => `строка от ${row.d} (${row.dimension}, ${row.origin}) заменяет прежнюю строку`,
      ),
  },
  {
    kind: 'operation',
    title: 'операция «crew» или «assignment_tail» задела заявку',
    /*
     * ЕДИНСТВЕННОЕ УСЛОВИЕ, КОТОРОЕ СМОТРИТ НЕ НА СТРОКИ. И оно не запасное: у решения хвоста вида
     * `history_wins` (Р31) строк истории НЕТ ВООБЩЕ — `tail_decision` меняет только назначение и
     * ставки, а в истории не появляется ни одной записи (`assignment-effects.ts`: «решение хвоста
     * любого вида, включая безстрочное»). Человек разобрал расхождение хвоста, назвал причину и
     * получил запись в журнале коррекций — а по строкам истории этой заявки не отличить от
     * нетронутой. Все пять условий выше промолчат, и заявка уехала бы в откат.
     *
     * ПОЧЕМУ ТОЛЬКО `crew` И `assignment_tail`, А НЕ ЛЮБАЯ СВЯЗЬ. Прежняя редакция Д3 требует
     * «ни одной связи в `vehicle_request_corrections`». Это шире, чем нужно, и вредно: в той же
     * таблице лежат `route`, `transfer`, `esm2`, `cancel`, `issue`, `request_date`, `weekly` —
     * коррекции бумаги, часть которых старше самого модуля истории. Они истории не пишут; их след
     * в ней, если он есть, — это либо строка с `correction_id` (условие выше), либо гашение с
     * автором (условие выше). Требовать «ни одной связи» значило бы объявить необратимой каждую
     * заявку, которой когда-либо правили срок задним числом, — и оператор получил бы отчёт, в
     * котором удержано всё подряд, а разобрать его нечем. Виды операций истории (Р32) названы
     * здесь поимённо, потому что именно они означают принятое решение о составе.
     */
    condition: (ref) =>
      sql`EXISTS (SELECT 1
                    FROM vehicle_request_corrections l
                    JOIN waybill_corrections w ON w.id = l.correction_id
                   WHERE l.request_id = ${ref} AND w.kind IN ('crew', 'assignment_tail'))`,
    explain: async (reader, id) =>
      (
        await rows<{ kind: string; at: Date; who: string; reason: string }>(
          reader,
          sql`SELECT w.kind, w.created_at AS at,
                     coalesce(u.full_name, u.email, w.actor_user_id::text) AS who, w.reason
                FROM vehicle_request_corrections l
                JOIN waybill_corrections w ON w.id = l.correction_id
                LEFT JOIN users u ON u.id = w.actor_user_id
               WHERE l.request_id = ${id}::uuid AND w.kind IN ('crew', 'assignment_tail')
               ORDER BY w.created_at`,
        )
      ).map(
        (row) => `операция «${row.kind}» ${when(row.at)}, ${row.who}: ${row.reason}`,
      ),
  },
];

/**
 * Сам предикат: заявка обратима, если не сработало ни одно условие удержания.
 *
 * Собирается из того же списка, из которого печатается отчёт, и передаётся ссылкой на колонку
 * (`r.id` при отборе) или на литерал (`'…'::uuid` при повторной проверке). Двух текстов предиката
 * не существует — есть один, применённый дважды.
 */
function reversible(ref: SQL): SQL {
  // Скобки вокруг всей цепочки обязательны: `NOT` в SQL связывает сильнее `AND`, и выражение
  // `NOT <предикат>` без них превратилось бы в «не первое условие И все остальные», то есть в
  // тихо неверный ответ там, где предикат отрицают (счёт удержанных в таблице популяции).
  return sql`(${sql.join(
    HOLDS.map((hold) => sql`NOT ${hold.condition(ref)}`),
    sql` AND `,
  )})`;
}

/** Повторная проверка под блокировкой — тем же выражением, что и отбор. */
async function isReversible(reader: Reader, requestId: string): Promise<boolean> {
  const [row] = await rows<{ ok: boolean }>(
    reader,
    sql`SELECT ${reversible(sql`${requestId}::uuid`)} AS ok`,
  );
  if (!row) throw new Error(`База не ответила на проверку обратимости заявки ${requestId}`);
  return row.ok;
}

/** Чем именно удержана заявка: виды и строки для человека. Зовётся только по неудачной проверке. */
async function explainHolds(
  reader: Reader,
  requestId: string,
): Promise<{ kinds: string[]; detail: string[] }> {
  const kinds: string[] = [];
  const detail: string[] = [];
  for (const hold of HOLDS) {
    const lines = await hold.explain(reader, requestId);
    if (lines.length === 0) continue;
    kinds.push(hold.kind);
    for (const line of lines.slice(0, EXPLAIN_LIMIT)) detail.push(line);
    if (lines.length > EXPLAIN_LIMIT) {
      detail.push(`… и ещё ${lines.length - EXPLAIN_LIMIT} того же вида (${hold.title})`);
    }
  }
  return { kinds, detail };
}

/**
 * След истории у заявки: строки, состояние или и то и другое.
 *
 * Популяция отката — не популяция бэкфилла (Р20). Тот брал заказы спецтехники в работе и
 * выполненные; здесь спрашивается только «есть ли что откатывать». Причина простая: строка
 * истории, оказавшаяся у заявки вне Р20 (сменился статус, заявку восстановили из архива, данные
 * поправили руками), после отката по узкой популяции осталась бы сиротой — и следующий прогон её
 * бы уже не увидел. Откат обязан убирать за собой всё, а не только ожидаемое.
 */
const FOOTPRINT = sql`(r.assignment_history_state <> 'empty'
   OR EXISTS (SELECT 1 FROM ${CHANGES} c WHERE c.request_id = r.id))`;

// ───────────────────────────────── состояние прогона ─────────────────────────────────

/** Заявка, которую откат не тронул, и почему. */
interface HeldRow {
  num: number;
  /** Где сработал предикат: при отборе или при повторной проверке под блокировкой (гонка). */
  stage: 'select' | 'recheck';
  kinds: string[];
  detail: string[];
}

/** Заявка, на которой прогон упал: разбирается человеком, а не прячется в счётчик. */
interface FailedRow {
  num: number;
  detail: string;
}

interface Counters {
  processed: number;
  rolledBack: number;
  rowsDeleted: number;
  held: number;
  /** Из них удержанных ПОВТОРНОЙ проверкой: решение легло между отбором и удалением. */
  heldOnRecheck: number;
  failed: number;
}

interface RunState {
  version: number;
  mode: 'dry-run' | 'apply';
  startedAt: string;
  finishedAt: string | null;
  /** Идентификатор последней учтённой заявки. Он же порядок обхода и точка возобновления. */
  cursor: string | null;
  counters: Counters;
  holdCounts: Record<string, number>;
  held: HeldRow[];
  failures: FailedRow[];
  elapsedMs: number;
}

function freshState(mode: RunState['mode']): RunState {
  return {
    version: STATE_VERSION,
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cursor: null,
    counters: {
      processed: 0,
      rolledBack: 0,
      rowsDeleted: 0,
      held: 0,
      heldOnRecheck: 0,
      failed: 0,
    },
    holdCounts: {},
    held: [],
    failures: [],
    elapsedMs: 0,
  };
}

/**
 * Прочитать сохранённое состояние — и отвергнуть чужое. Проверки две: версия формата (файл от
 * другой сборки) и режим (продолжение удаления под видом dry-run и наоборот). Дня расчёта у
 * отката нет — он ничего не считает на дату, — поэтому третьей проверки бэкфилла здесь нет.
 */
function readState(path: string, mode: RunState['mode']): RunState | null {
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
  return state;
}

function writeState(path: string, state: RunState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// ───────────────────────────────── выборка популяции ─────────────────────────────────

interface Population {
  withHistory: number;
  materialized: number;
  ready: number;
  reversible: number;
  held: number;
  changeRows: number;
  /** Индексная подпись — требование `execute<T>`: строка результата приходит записью колонок. */
  [column: string]: number;
}

async function readPopulation(db: Handle): Promise<Population> {
  const [row] = await rows<Population>(
    db,
    sql`SELECT count(*) FILTER (WHERE ${FOOTPRINT})::int AS "withHistory",
               count(*) FILTER (WHERE r.assignment_history_state = 'materialized')::int AS materialized,
               count(*) FILTER (WHERE r.assignment_history_state = 'ready')::int AS ready,
               count(*) FILTER (WHERE ${FOOTPRINT} AND ${reversible(sql`r.id`)})::int AS reversible,
               count(*) FILTER (WHERE ${FOOTPRINT} AND NOT ${reversible(sql`r.id`)})::int AS held,
               (SELECT count(*)::int FROM ${CHANGES}) AS "changeRows"
          FROM vehicle_requests r`,
  );
  if (!row) throw new Error('База не ответила на подсчёт популяции');
  return row;
}

/**
 * Очередная страница заявок со следом истории — вместе с ПЕРВОЙ проверкой предиката.
 *
 * Проверка здесь нужна не ради экономии: заявка, удержанная уже на отборе, не требует блокировки
 * вовсе — открывать транзакцию и запирать строку ради того, чтобы прочитать то же самое, значит
 * останавливать чужую работу без пользы. Вторую проверку это не заменяет ничем: между этим
 * запросом и транзакцией по заявке проходит время, и настоящий ответ даёт только она.
 *
 * Порядок по `id` — он же курсор возобновления: устойчив к любым правкам данных, в отличие от
 * порядка по номеру или по дате.
 */
async function nextPage(
  db: Handle,
  after: string | null,
  limit: number,
): Promise<{ id: string; num: number; reversible: boolean }[]> {
  return rows<{ id: string; num: number; reversible: boolean }>(
    db,
    sql`SELECT r.id, r.num, ${reversible(sql`r.id`)} AS reversible
          FROM vehicle_requests r
         WHERE ${FOOTPRINT}
           ${after === null ? sql`` : sql`AND r.id > ${after}::uuid`}
         ORDER BY r.id
         LIMIT ${limit}`,
  );
}

// ───────────────────────────────── обработка одной заявки ─────────────────────────────────

type Outcome =
  | { kind: 'rolled'; rows: number }
  | { kind: 'held'; stage: HeldRow['stage']; kinds: string[]; detail: string[] };

/**
 * Одна заявка — одна транзакция, и порядок внутри неё нормативный (Е4).
 *
 * 1. **Блокировка строки заявки первой операцией.** Та же самая, что берут все двери истории
 *    (`lockRequestRow`): `FOR UPDATE` по `vehicle_requests`. Берётся своим запросом, а не через
 *    сам `lockRequestRow`: тот живёт в `services/vehicle-routes.ts`, который тянет прикладной пул,
 *    а прогон обязан работать без портального окружения (Ю23). Канонический порядок захвата —
 *    заявка первой — соблюдается: при конфликте отказ приходит на первом же запросе.
 * 2. **Повторная проверка полного предиката** — уже под блокировкой и уже новым снимком: в
 *    READ COMMITTED каждый запрос видит закоммиченное к его началу, а `FOR UPDATE` дождался того,
 *    кто держал строку. Именно здесь ловится решение, легшее между отбором и удалением.
 * 3. **Удаление** — одним `DELETE` по заявке. Одним, а не по строкам: `supersedes_change_id`
 *    ссылается внутрь той же таблицы, и удаление предка раньше потомка прошло бы только потому,
 *    что FK проверяется в конце ОПЕРАТОРА. Разбив удаление на несколько, мы получили бы отказ на
 *    цепочке замен.
 * 4. **Состояние `empty`** — вместе с датой проверки и меткой загрязнения: `CHECK` заявки требует
 *    «`empty` тогда и только тогда, когда дня расчёта нет», а `dirty` у заявки без истории не
 *    значит ничего.
 *
 * В dry-run вместо блокировки объявляется `READ ONLY`: «прогон ничего не пишет» держит база, а не
 * дисциплина. Цена честности — вторая проверка в dry-run идёт без блокировки и потому ничего не
 * доказывает; отчёт об этом говорит прямо.
 */
async function processOne(db: Handle, requestId: string, apply: boolean): Promise<Outcome> {
  return db.transaction(async (tx) => {
    if (apply) {
      await tx.execute(sql`SELECT id FROM vehicle_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    } else {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
    }

    if (!(await isReversible(tx, requestId))) {
      const holds = await explainHolds(tx, requestId);
      if (holds.kinds.length === 0) {
        // Предикат отказал, а объяснить отказ нечем — значит список условий и список объяснений
        // разошлись. Это внутренняя ошибка прогона, и молчать о ней нельзя: оператор увидел бы
        // «удержано» без единой причины.
        holds.kinds.push('unexplained');
        holds.detail.push('предикат удержал заявку, но ни одно условие не дало объяснения');
      }
      return { kind: 'held', stage: apply ? 'recheck' : 'select', ...holds };
    }

    if (!apply) {
      const [row] = await rows<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM ${CHANGES} c WHERE c.request_id = ${requestId}::uuid`,
      );
      return { kind: 'rolled', rows: row?.n ?? 0 };
    }

    const deleted = await tx.execute(
      sql`DELETE FROM ${CHANGES} WHERE request_id = ${requestId}::uuid`,
    );
    await tx.execute(sql`UPDATE vehicle_requests
                            SET assignment_history_state = 'empty',
                                assignment_history_validated_on = NULL,
                                assignment_history_dirty = false
                          WHERE id = ${requestId}::uuid`);
    return { kind: 'rolled', rows: deleted.rowCount ?? 0 };
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

const HOLD_TITLE: Record<string, string> = Object.fromEntries([
  ...HOLDS.map((hold) => [hold.kind, hold.title]),
  ['unexplained', 'предикат удержал без объяснения (ошибка прогона)'],
]);

function recordHeld(state: RunState, num: number, outcome: Extract<Outcome, { kind: 'held' }>) {
  state.counters.held += 1;
  if (outcome.stage === 'recheck') state.counters.heldOnRecheck += 1;
  for (const kind of outcome.kinds) {
    state.holdCounts[kind] = (state.holdCounts[kind] ?? 0) + 1;
  }
  state.held.push({ num, stage: outcome.stage, kinds: outcome.kinds, detail: outcome.detail });
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

  lines.push(`${'След истории в базе'.padEnd(38)}${pad('до прогона', 10)}${pad('после', 10)}`);
  const row = (title: string, before: number, after: number): void => {
    lines.push(`  ${title.padEnd(36)}${pad(before, 10)}${pad(after, 10)}`);
  };
  row('заявок с историей', population.before.withHistory, population.after.withHistory);
  row('  из них обратимых', population.before.reversible, population.after.reversible);
  row('  из них удержанных', population.before.held, population.after.held);
  row('в состоянии ready', population.before.ready, population.after.ready);
  row('в состоянии materialized', population.before.materialized, population.after.materialized);
  row('строк истории всего', population.before.changeRows, population.after.changeRows);
  lines.push('');

  const perSecond = state.elapsedMs > 0 ? (c.processed / (state.elapsedMs / 1000)).toFixed(1) : '—';
  const line = (title: string, value: number | string): void => {
    lines.push(`  ${title.padEnd(38)}${pad(value, 8)}`);
  };
  lines.push('Итог прогона');
  line('обработано заявок', c.processed);
  line(state.mode === 'apply' ? 'откачено в empty' : 'откатилось бы', c.rolledBack);
  line(
    state.mode === 'apply' ? 'строк истории удалено' : 'строк истории удалилось',
    c.rowsDeleted,
  );
  line('удержано предикатом', c.held);
  line('  из них повторной проверкой', c.heldOnRecheck);
  line('отказов на заявках', c.failed);
  lines.push(
    `  ${'время'.padEnd(38)}${pad(duration(state.elapsedMs), 8)}  (${perSecond} заявок/с)`,
  );
  lines.push('');

  const holdKinds = Object.entries(state.holdCounts).sort((a, b) => b[1] - a[1]);
  if (holdKinds.length > 0) {
    lines.push('Что удерживало (считается по заявкам; у одной заявки причин бывает несколько)');
    for (const [kind, count] of holdKinds) {
      lines.push(`  ${(HOLD_TITLE[kind] ?? kind).padEnd(46)}${pad(count, 6)}`);
    }
    lines.push('');
  }

  if (state.failures.length > 0) {
    lines.push(`ОТКАЗЫ — разбирает человек: ${state.failures.length}`);
    const shown = full ? state.failures : state.failures.slice(0, SAMPLE_LIMIT);
    for (const item of shown) lines.push(`  ТС-${item.num}: ${item.detail}`);
    if (shown.length < state.failures.length) {
      lines.push(`  … и ещё ${state.failures.length - shown.length} (полный список — в --report)`);
    }
    lines.push('');
  }

  if (state.held.length === 0) {
    lines.push('УДЕРЖАННЫЕ ЗАЯВКИ: ни одной — человеческих следов в истории нет.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    `УДЕРЖАННЫЕ ЗАЯВКИ — историю сохраняем, разбирает человек: ${state.held.length} шт.`,
  );
  if (state.mode !== 'apply') {
    lines.push(
      '  (dry-run: повторная проверка шла без блокировки строки заявки и потому ничего не',
      '   доказывает — настоящий ответ даёт только прогон с --apply под замороженным модулем)',
    );
  }
  // Гонки идут первыми: заявка, решение по которой легло между отбором и удалением, — это то
  // самое, ради чего повторная проверка написана, и оператор обязан увидеть её, а не искать.
  const sorted = [...state.held].sort(
    (a, b) => (a.stage === b.stage ? a.num - b.num : a.stage === 'recheck' ? -1 : 1),
  );
  const shown = full ? sorted : sorted.slice(0, SAMPLE_LIMIT);
  for (const item of shown) {
    const race =
      item.stage === 'recheck' ? '  ← решение легло между отбором и удалением (гонка)' : '';
    lines.push(`  ТС-${item.num}${race}`);
    for (const detail of item.detail) lines.push(`      ${detail}`);
  }
  if (shown.length < sorted.length) {
    lines.push(`  … и ещё ${sorted.length - shown.length} (полный список — в --report)`);
  }
  return `${lines.join('\n')}\n`;
}

const HELP =
  'Обратный прогон истории назначения (этап 4, волна 4.2 плана assignment-periods).\n' +
  '  без флагов — dry-run (ничего не удаляется); --apply — удаление истории и возврат в empty.\n' +
  '  --state=ПУТЬ  файл возобновления      --limit=N     предел заявок\n' +
  '  --report=ПУТЬ полный отчёт в файл     --restart     забыть состояние\n' +
  '  --progress=N  строка хода каждые N    --max-failures=N оборвать после N отказов подряд\n' +
  '  Прогон работает только под замороженным модулем: сначала\n' +
  '    assignment:mode set --write=history_frozen --actor=… --reason=… --build=…\n' +
  '  Коды возврата: 0 — чисто, 3 — есть удержанные, 4 — модуль не заморожен, 1 — прогон не\n' +
  '  закончен, 2 — аргументы.\n';

// ───────────────────────────────── прогон ─────────────────────────────────

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (boolFlag(flags, 'help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const apply = boolFlag(flags, 'apply');
  const mode: RunState['mode'] = apply ? 'apply' : 'dry-run';
  const statePath = flags.get('state')?.trim() || null;
  const reportPath = flags.get('report')?.trim() || null;
  const limit = intFlag(flags, 'limit', 0);
  const progressEvery = intFlag(flags, 'progress', 200);
  const maxFailures = intFlag(flags, 'max-failures', 20);

  const access = resolveMaintenanceAccess();
  const pool = buildMaintenancePool(access);

  try {
    const identity = await readMaintenanceIdentity(pool);
    const db = drizzle(pool, { schema, casing: 'snake_case' });
    const [where] = await rows<{ database: string }>(db, sql`SELECT current_database() AS database`);

    /*
     * Удаление истории прикладными кредами не открывается — та же проверка, что у двери режима
     * (П7), и по той же причине: граница заведена ровно затем, чтобы разрушающий путь не был
     * доступен тому, кто ходит в базу от лица портала. Читать (dry-run) можно чем угодно.
     */
    if (apply && access.sharedWithApp) {
      throw new Error(
        `Откат отменён: ${access.source} совпадает с прикладным DATABASE_URL. ` +
          'Удаление истории не открывается кредами приложения (П7).',
      );
    }
    if (apply && identity.currentUser === APP_ROLE) {
      throw new Error(
        `Откат отменён: соединение открыто прикладной ролью ${APP_ROLE}. ` +
          'Административный путь ходит своей ролью.',
      );
    }

    /*
     * ГЛАВНАЯ ПРЕДПОСЫЛКА (Е4). Откат под живой записью бессмысленен в обе стороны: заявка,
     * признанная обратимой, получает решение человека через секунду после проверки, а отчёт
     * устаревает раньше, чем допечатается. Отказ, а не предупреждение: dry-run под `normal` —
     * это цифры, которым нельзя верить, и «посмотреть заранее» ими не сделать.
     */
    const moduleMode = await readAssignmentMode(db);
    if (moduleMode.writeMode === 'normal') {
      process.stderr.write(
        'Обратный прогон не начинался: модуль периодов назначения не заморожен ' +
          `(write_mode = ${moduleMode.writeMode}). Откат идёт после kill switch и drain (Е4):\n` +
          '  assignment:mode set --write=history_frozen --actor=… --reason=… --build=<sha>\n',
      );
      return EXIT_NOT_FROZEN;
    }
    /*
     * И вторая предпосылка, которой в плане нет, а нужна она не меньше: при `read_mode = history`
     * портал берёт «кто и на чём работал» из этих самых строк. Удалить их под включённым чтением
     * значит не откатить модуль, а стереть данные у работающего портала. Чтение возвращают
     * дверью режима — и только потом откатывают историю.
     */
    if (moduleMode.readMode !== 'legacy') {
      process.stderr.write(
        'Обратный прогон не начинался: чтение идёт из истории ' +
          `(read_mode = ${moduleMode.readMode}), и удаление строк оставило бы портал без данных.\n` +
          '  Сначала assignment:mode set --read=legacy …, потом откат.\n',
      );
      return EXIT_NOT_FROZEN;
    }

    const stored = statePath && !boolFlag(flags, 'restart') ? readState(statePath, mode) : null;
    const state = stored ?? freshState(mode);
    const before = await readPopulation(db);
    const headerOf = (): string[] => [
      `Обратный прогон истории назначения — ${apply ? 'УДАЛЕНИЕ' : 'dry-run (ничего не удаляется)'}`,
      `База: ${where?.database ?? '?'}, доступ ${maintenanceAccessLine(access, identity)}`,
      `Режим модуля: запись ${moduleMode.writeMode}, чтение ${moduleMode.readMode}` +
        ' — заморозка для отката обязательна (Е4), в отличие от прочих maintenance-команд',
      limit > 0 ? `Предел прогона — ${limit} заявок` : 'Предел прогона не задан: идём по всей базе',
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
      return state.held.length > 0 ? EXIT_HELD : 0;
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
      // Страница обязана начинаться строго за курсором: не сдвинувшийся курсор даёт не отказ, а
      // вечный прогон по одной и той же странице — у этой ошибки нет внешних признаков.
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
        try {
          if (!request.reversible) {
            // Первая проверка сказала «нет»: блокировать строку незачем, объяснение читается
            // без транзакции — заявку мы не трогаем ни при каком исходе.
            const holds = await explainHolds(db, request.id);
            recordHeld(state, request.num, { kind: 'held', stage: 'select', ...holds });
          } else {
            const outcome = await withRetry(() => processOne(db, request.id, apply));
            if (outcome.kind === 'held') {
              recordHeld(state, request.num, outcome);
            } else {
              state.counters.rolledBack += 1;
              state.counters.rowsDeleted += outcome.rows;
            }
          }
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          state.counters.failed += 1;
          // Отказ — не удержание: он идёт своим счётчиком и своим разделом отчёта. Смешав его с
          // причинами предиката, мы получили бы таблицу, в которой поломка выглядит решением.
          state.failures.push({
            num: request.num,
            detail: `откат не выполнен: ${(error as Error).message}`,
          });
        }

        state.counters.processed += 1;
        // Курсор двигается после учёта заявки — включая ту, что упала: иначе возобновлённый
        // прогон вечно упирался бы в одну и ту же неисправную заявку.
        state.cursor = request.id;
        done += 1;
        state.elapsedMs = baseElapsed + (Date.now() - startedAt);
        if (statePath && state.counters.processed % STATE_FLUSH_EVERY === 0) {
          writeState(statePath, state);
        }
        if (progressEvery > 0 && state.counters.processed % progressEvery === 0) {
          process.stdout.write(
            `  … ${state.counters.processed}: откачено ${state.counters.rolledBack}, ` +
              `удержано ${state.counters.held}, ${duration(state.elapsedMs)}\n`,
          );
        }
        if (consecutiveFailures >= maxFailures) {
          throw new Error(
            `Подряд ${consecutiveFailures} отказов по заявкам — прогон остановлен: это похоже не на ` +
              'данные, а на общую поломку. Разберите последние строки отчёта.',
          );
        }
      }
    }

    state.elapsedMs = baseElapsed + (Date.now() - startedAt);
    if (!stoppedByLimit) state.finishedAt = new Date().toISOString();
    if (statePath) writeState(statePath, state);

    const after = await readPopulation(db);
    // Шапка на экране уже напечатана перед работой; в файле она нужна — там кроме отчёта нет
    // ничего, и через месяц по нему придётся понять, чем и по какой базе прогон шёл.
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
    return state.held.length > 0 || state.failures.length > 0 ? EXIT_HELD : 0;
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
