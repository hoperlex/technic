import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  countsUnreviewedTicketPaper,
  REQUEST_TYPES,
  type RequestType,
  type WasteTicketBadgeDto,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  jobs,
  wasteRequests,
  wasteTicketPages,
  wasteTicketReviewState,
  wasteTickets,
  type WasteTicketReviewStateRow,
} from '../db/schema';
import { JOB_RECOGNIZE_WASTE_TICKET_FILE } from '../lib/jobs';
import { WASTE_TICKET_CHECKS_VERSION, wasteTicketChecks } from './waste-ticket-checks';
import {
  loadTicketCheckInputs,
  loadTicketCheckRequestRow,
  type DbExecutor,
  type TicketCheckRequestRow,
} from './waste-ticket-inputs';

// ── Состояние разбора талонов: материализация, инвалидация, чтение (план
// `docs/waste-ticket-auto-confirm-plan.md`, Р19–Р21) ──
//
// ЕДИНСТВЕННЫЙ ПИСАТЕЛЬ `waste_ticket_review_state`. Числа значка считает всё та же сверка
// (`wasteTicketChecks`), а здесь лежит только протокол их сохранения и порчи. Разложи этот
// протокол по одиннадцати мутациям разбора, воркеру и списку — и он разойдётся: кто-то напишет
// безусловно, кто-то забудет соседей, кто-то возьмёт строки состояния во встречном порядке и
// поймает дедлок на ровном месте.
//
// ЧТО ЗДЕСЬ ГЛАВНОЕ — ТРИ ПРАВИЛА, И ВСЕ ТРИ ПРО ГОНКИ.
//
// 1. ЛЮБАЯ ЗАПИСЬ УСЛОВНА ПО РЕВИЗИИ. Ревизия читается ДО расчёта, пишется — только если не
//    изменилась. Безусловный upsert был бы дырой ровно того размера, что нашло ревью плана:
//    мутация Б считает своё состояние, пока сосед А метит Б устаревшей, — и запись Б стёрла бы
//    пометку, оставив `stale = false` с числами, посчитанными по прежнему соседу.
//
// 2. ПРОИГРАВШИЙ ВЕДЁТ СЕБЯ ПО-РАЗНОМУ, СМОТРЯ КТО ОН. Мутация делает один повтор и, проиграв
//    второй раз, пишет `stale = true`: так операция заканчивается за ограниченное число шагов, а
//    числа чинит первое же чтение. Читатель (список) не пишет вовсе — он перечитывает победившую
//    строку и отдаёт её числа, если она свежая. Свой расчёт он показывает только при негодной
//    победившей строке: расчёт, начатый до чужой мутации, СТАРШЕ победившего, а не свежее.
//
// 3. СТРОКИ СОСТОЯНИЯ БЕРУТСЯ ПО ВОЗРАСТАНИЮ `request_id`, ПО ОДНОЙ. Две встречные мутации (А
//    пишет себя и метит Б, Б пишет себя и метит А) иначе дают дедлок уже не на номерах талонов, а
//    здесь. Приём тот же, что у `lockGrants`/`lockUsers` в `grant-catalog.ts`: цикл по одной
//    строке в отсортированном порядке, а не один `WHERE id = ANY(…)`, у которого порядок
//    блокировок задаёт план запроса.
//
// ОТСЮДА ПОРЯДОК ВЫЗОВА У МУТАЦИИ: сначала `markTicketReviewStale(tx, [своя, ...соседи])` — своя
// строка идёт В ОБЩЕМ РЯДУ, — и только потом `recomputeTicketReviewState(tx, своя)`. Пересчёт,
// поставленный раньше пометки соседей, взял бы свою строку вне ряда и вернул бы тот же дедлок.
//
// СТРОКА ЕСТЬ ТОЛЬКО У ЗАЯВКИ С БУМАГОЙ. Заявка без талонов, без строк распознавания и без
// приложенного файла состояния не получает, а потерявшая последнюю бумагу — его лишается:
// «разбирать нечего» и «всё разобрано» это разные ответы (значка нет против значка из нулей), и
// нули в списке сказали бы, что бумага разобрана, там, где её не приносили.
//
// ИСПОЛНИТЕЛЬ (`DbExecutor`) БЕРЁТСЯ У ЗАГРУЗЧИКА СВЕРКИ, а не объявляется здесь заново: пересчёт
// под замком обязан и читать, и писать одной транзакцией, и два одинаковых объявления рано или
// поздно разошлись бы в том, что считать транзакцией. Список и прогрев передают само соединение:
// замка у них нет и не должно быть, их защищает условная запись.

/**
 * Version of the stored FORM of the state — not the version of the check rules.
 *
 * It is raised when the meaning of the stored numbers changes: release B added `unreviewed_paper`,
 * release C added `confirmable`; version 2 (snow removal) counts snow paper, overlays live and dead
 * recognition jobs, counts a partially failed scan once per file and keeps a confirmed ticket with
 * an unanswered reread proposal pending. Without the bump a row written by the previous release
 * would stay `stale = false` with a matching fingerprint and read as current.
 *
 * Its own constant, not `WASTE_TICKET_CHECKS_VERSION`: that one is part of the fingerprint of
 * ACCEPTED discrepancies (`wasteTicketCheckFingerprint`), and raising it for the storage form would
 * silently revoke every acceptance people made.
 */
export const WASTE_TICKET_REVIEW_STATE_VERSION = 2;

/**
 * Отпечаток входа: версия формы, версия правил сверки и действующие допуски.
 *
 * Аргументов нет намеренно — значение одно на процесс. Предикат реестра сравнивает его в SQL
 * (`s.input_fingerprint <> $current`, Р21), и посчитанный «по заявке» он потребовал бы прочитать
 * заявку, чтобы решить, читать ли её строку состояния.
 *
 * Допуски берутся из конфигурации, а не из того, что сверка использовала фактически. Сегодня они
 * до неё не доезжают вовсе (`DEFAULT_WASTE_TICKET_TOLERANCES` совпадает со значениями по
 * умолчанию), и отпечаток «по конфигурации» это учитывает в безопасную сторону: правка `.env`
 * обесценит строки раньше, чем начнёт менять числа. Обратный выбор — считать по фактическим —
 * молча пропустил бы день, когда допуски наконец начнут читаться из конфигурации.
 */
export function reviewStateInputFingerprint(): string {
  const tolerances = config.ticketOcr.tolerances;
  const payload = JSON.stringify([
    WASTE_TICKET_REVIEW_STATE_VERSION,
    WASTE_TICKET_CHECKS_VERSION,
    tolerances.volumeM3,
    tolerances.volumePlanShare,
    tolerances.dateDays,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── Who has paper and who waits for review, in SQL (ADR 0155, R21) ──
//
// Two readers select requests in SQL rather than by running the checks: the "Требуют разбора"
// register and the warm-up script. Both must ask the SAME question the loader answers when it
// decides whether a request gets a badge at all (`loadTicketCheckInputs`), otherwise the script
// would skip requests the list badges, or the register would hide paper the card shows. The type
// list is derived from the contract predicate over `REQUEST_TYPES`, never written by hand: a hand
// list is exactly how snow would have been left out.

/** Request types whose attached ticket file counts as paper before recognition (ADR 0150). */
export const UNREVIEWED_PAPER_REQUEST_TYPES: readonly RequestType[] = REQUEST_TYPES.filter(
  countsUnreviewedTicketPaper,
);

/**
 * "The request has paper": a ticket (manual ones included), a recognition file row, or a live ticket
 * file attached to a type inside the unreviewed-paper boundary. Mirrors the loader's
 * no-badge rule; `requestId` and `requestType` are the outer query's columns.
 */
export function ticketPaperSql(requestId: SQLWrapper, requestType: SQLWrapper): SQL {
  const types = sql.join(
    UNREVIEWED_PAPER_REQUEST_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  return sql`(
    EXISTS (SELECT 1 FROM waste_tickets wt WHERE wt.request_id = ${requestId})
    OR EXISTS (SELECT 1 FROM waste_ticket_files wf WHERE wf.request_id = ${requestId})
    OR (
      ${requestType} IN (${types})
      AND EXISTS (SELECT 1 FROM request_files rf
                    JOIN files f ON f.id = rf.file_id
                   WHERE rf.request_id = ${requestId}
                     AND rf.kind = 'ticket' AND f.status = 'active')
    )
    OR ${recognitionJobSql(requestId, ['pending', 'running', 'failed', 'dead'])}
  )`;
}

/**
 * A recognition job in one of `statuses` for a ticket file still attached to the request — the
 * queue half of the overlay (`classifyTicketFile`). Any type: paper in flight or a dead latest
 * attempt holds review even where old unqueued receipts do not (ADR 0150 is about the past).
 * Pending and running jobs sit on the `jobs_due_idx` prefix, dead ones are rare.
 */
function recognitionJobSql(requestId: SQLWrapper, statuses: readonly string[]): SQL {
  const list = sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`EXISTS (
    SELECT 1 FROM jobs j
      JOIN request_files rjf ON rjf.request_id = ${requestId} AND rjf.kind = 'ticket'
                            AND rjf.file_id::text = j.payload->>'fileId'
     WHERE j.type = ${JOB_RECOGNIZE_WASTE_TICKET_FILE}
       AND j.status IN (${list})
       AND j.payload->>'requestId' = (${requestId})::text
  )`;
}

/**
 * The "Требуют разбора" register condition. It selects by the STORED review state (ADR 0155, R21):
 * a second SQL definition of "review is not finished" once drifted from the checks and silently
 * hid a request whose tickets were all confirmed but whose discrepancy was not accepted.
 *
 * The first three state conditions are about NOT KNOWING: no row yet, a neighbour marked it stale,
 * the rules or tolerances changed. Not knowing means showing: a false row in the register costs
 * less than hidden work.
 */
export function ticketReviewPendingSql(requestId: SQLWrapper, requestType: SQLWrapper): SQL {
  return sql`(
    ${ticketPaperSql(requestId, requestType)}
    AND (
      NOT EXISTS (SELECT 1 FROM waste_ticket_review_state s WHERE s.request_id = ${requestId})
      OR EXISTS (SELECT 1 FROM waste_ticket_review_state s
                  WHERE s.request_id = ${requestId}
                    AND (s.stale
                         OR s.input_fingerprint <> ${reviewStateInputFingerprint()}
                         OR s.errors > 0 OR s.pending_confirmation > 0
                         OR s.failures > 0 OR s.unreviewed_paper > 0))
      -- The live queue is read alongside the stored state: a row written before a rerun was
      -- queued (or by an older attempt finishing) must not hide the attempt still in flight.
      OR ${recognitionJobSql(requestId, ['pending', 'running'])}
    )
  )`;
}

/** Числа значка из сохранённой строки — ровно те же поля, что вернула бы сверка. */
function badgeOf(row: WasteTicketReviewStateRow): WasteTicketBadgeDto {
  return {
    errors: row.errors,
    warnings: row.warnings,
    pendingConfirmation: row.pendingConfirmation,
    failures: row.failures,
    unreviewedPaper: row.unreviewedPaper,
    confirmable: row.confirmable,
    confirmableFingerprint: row.confirmableFingerprint,
  };
}

/**
 * Годится ли строка в ответ человеку. Три условия — три способа не знать: пометка соседа, смена
 * правил или допусков и строка, заведённая пометкой и ни разу не посчитанная.
 */
function isFresh(row: WasteTicketReviewStateRow, fingerprint: string): boolean {
  return !row.stale && row.inputFingerprint === fingerprint && row.computedAt !== null;
}

async function readState(
  exec: DbExecutor,
  requestId: string,
): Promise<WasteTicketReviewStateRow | undefined> {
  const rows = await exec
    .select()
    .from(wasteTicketReviewState)
    .where(eq(wasteTicketReviewState.requestId, requestId))
    .limit(1);
  return rows[0];
}

/**
 * Значок заявки, посчитанный сверкой; `null` — бумаги у заявки нет (или заявки нет вовсе).
 *
 * Обе половины входа читаются исполнителем вызывающего: пересчёт под замком, прочитавший заявку
 * мимо транзакции, посчитал бы состояние по данным, которых в ней нет.
 */
async function computeReview(
  exec: DbExecutor,
  requestId: string,
): Promise<{ badge: WasteTicketBadgeDto; live: boolean } | null> {
  // Мягко удалённой заявки загрузчик не отдаёт, и это правильный ответ «состояния нет»: строку
  // такой заявки видит только восстановление, и первое же чтение после него посчитает её заново.
  const row = await loadTicketCheckRequestRow(requestId, exec);
  if (!row) return null;
  const bundle = (await loadTicketCheckInputs([row], { exec })).get(requestId);
  return bundle
    ? { badge: wasteTicketChecks(bundle.inputs).badge, live: bundle.liveRecognition }
    : null;
}

/**
 * The review badge of one request computed fresh — the terminal check's input (ADR 0135): it
 * never trusts the stored state and reads the recognition queue alongside the outcomes.
 *
 * Every query runs on `exec`. Under the request lock the caller passes its transaction: a read
 * through the pool would wait for a second connection while the first holds the lock, which with a
 * pool of one is a deadlock, and with any pool reads past the locked state.
 */
export async function computeTicketReviewBadge(
  exec: DbExecutor,
  requestId: string,
): Promise<WasteTicketBadgeDto | null> {
  return (await computeReview(exec, requestId))?.badge ?? null;
}

/** Пустая строка под будущую запись: `stale = true` и `revision = 0` — умолчания схемы. */
async function ensureRow(exec: DbExecutor, requestId: string): Promise<void> {
  await exec.insert(wasteTicketReviewState).values({ requestId }).onConflictDoNothing();
}

/** Записать числа, если строку с прочитанной ревизии никто не трогал. `false` — проиграли. */
async function writeBadge(
  exec: DbExecutor,
  requestId: string,
  revision: number,
  badge: WasteTicketBadgeDto,
  /**
   * Store the numbers as stale: they rest on a live recognition job, and the end of a job is not
   * always followed by a stale mark (a job skipped by a worker with recognition off, the gap
   * between the worker's result and its job status). Stale keeps the request in the register and
   * makes the next reader recompute instead of trusting numbers about a queue that moved on.
   */
  stale = false,
): Promise<boolean> {
  const written = await exec
    .update(wasteTicketReviewState)
    .set({
      errors: badge.errors,
      warnings: badge.warnings,
      pendingConfirmation: badge.pendingConfirmation,
      failures: badge.failures,
      unreviewedPaper: badge.unreviewedPaper,
      confirmable: badge.confirmable,
      confirmableFingerprint: badge.confirmableFingerprint,
      inputFingerprint: reviewStateInputFingerprint(),
      stale,
      revision: sql`${wasteTicketReviewState.revision} + 1`,
      computedAt: new Date(),
    })
    .where(
      and(
        eq(wasteTicketReviewState.requestId, requestId),
        eq(wasteTicketReviewState.revision, revision),
      ),
    )
    .returning({ requestId: wasteTicketReviewState.requestId });
  return written.length > 0;
}

/**
 * Убрать строку заявки, у которой бумаги больше нет, — тоже условно по ревизии.
 *
 * Именно убрать, а не записать нули: нули означают «всё разобрано», и список нарисовал бы разбор
 * там, где разбирать нечего. Отличать одно от другого отдельной колонкой значило бы хранить
 * «бумаги нет» дважды — здесь и в самих талонах с файлами, — и однажды они разошлись бы.
 */
async function dropState(exec: DbExecutor, requestId: string, revision: number): Promise<boolean> {
  const removed = await exec
    .delete(wasteTicketReviewState)
    .where(
      and(
        eq(wasteTicketReviewState.requestId, requestId),
        eq(wasteTicketReviewState.revision, revision),
      ),
    )
    .returning({ requestId: wasteTicketReviewState.requestId });
  return removed.length > 0;
}

/**
 * Пересчитать состояние одной заявки — единственный писатель чисел (Р19).
 *
 * Зовётся мутацией разбора под замком заявки, прогревом и чтением при промахе кэша. Один повтор
 * при проигрыше и `stale` после второго — не осторожность, а условие завершимости: мутация не
 * вправе крутиться в цикле, пока сосед метит её строку, а помеченная строка чинится первым
 * чтением.
 *
 * Порядок «сначала пометить ряд соседей вместе со своей строкой, потом пересчитать свою» —
 * требование вызывающего (см. шапку файла): здесь он не проверяется, потому что проверить его
 * можно только зная, кто соседи, а их знает мутация.
 */
export async function recomputeTicketReviewState(
  exec: DbExecutor,
  requestId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readState(exec, requestId);
    const review = await computeReview(exec, requestId);

    if (!review) {
      // Бумаги нет и строки нет — записывать нечего: заявка без бумаги в таблице не заводится.
      if (!before) return;
      if (await dropState(exec, requestId, before.revision)) return;
      continue;
    }
    if (!before) await ensureRow(exec, requestId);
    if (await writeBadge(exec, requestId, before?.revision ?? 0, review.badge, review.live)) return;
  }
  // Проиграли дважды — последнее слово пересчёта это пометка: честнее и устаревших чисел, и
  // молчания, а починит строку первое чтение. Строку, которую победитель убрал вместе с исчезнувшей
  // бумагой, пометка не воскрешает: `markTicketReviewStale` заводит её при отсутствии, поэтому
  // метится только существующая.
  if (await readState(exec, requestId)) await markTicketReviewStale(exec, [requestId]);
}

/**
 * Пометить состояние устаревшим — то, что делают все, кому пересчитать нечем: воркер
 * распознавания, мутация соседней заявки по номеру, правка адреса объекта (Р20).
 *
 * `INSERT … ON CONFLICT DO UPDATE`, а не `UPDATE`: у заявки, которую ещё ни разу не считали,
 * строки нет, и `UPDATE` по ней не сделал бы ничего — пометка потерялась бы там, где она нужнее
 * всего. Ревизия поднимается и здесь: по ней встречный пересчёт узнаёт, что его числа устарели, и
 * не затирает пометку.
 *
 * По одной строке в цикле и по возрастанию `request_id` — см. правило 3 в шапке файла. Один
 * запрос `WHERE id = ANY(…)` выглядел бы дешевле ровно до первой пары встречных мутаций.
 */
export async function markTicketReviewStale(
  exec: DbExecutor,
  requestIds: readonly string[],
): Promise<void> {
  for (const requestId of [...new Set(requestIds)].sort()) {
    await exec
      .insert(wasteTicketReviewState)
      .values({ requestId, stale: true })
      .onConflictDoUpdate({
        target: wasteTicketReviewState.requestId,
        set: {
          stale: true,
          revision: sql`${wasteTicketReviewState.revision} + 1`,
        },
      });
  }
}

/** Ключи, по которым ищутся соседи: старые и новые значения сразу (Р20). */
export interface TicketNeighbourKeys {
  /** Заявка-источник: её собственное состояние пересчитывается, а не метится. */
  requestId: string;
  numberKeys: readonly string[];
  numberFuzzies: readonly string[];
  pageShas: readonly string[];
}

const uniqueNonEmpty = (values: readonly string[]): string[] =>
  [...new Set(values)].filter((value) => value.length > 0);

/**
 * Чужие живые заявки, чьё состояние зависит от этой бумаги (Р20).
 *
 * Замечание о повторе живёт в заявке Б, а вызывает его талон заявки А — поэтому мутация А обязана
 * пометить Б, и ключи ей нужны по обоим значениям сразу: правка номера уводит бумагу от прежнего
 * соседа и приводит к новому.
 *
 * Ищутся НЕОТКЛОНЁННЫЕ талоны, а не одни подтверждённые. Сверка соседа считается по всем
 * неотклонённым (Р15): заявка с ещё не подтверждённым дублем предупреждение уже показывает — сузь
 * отбор до подтверждённых, и она не узнала бы о появившемся напротив соседе, а её предупреждение
 * не погасло бы после его исчезновения.
 *
 * Пустые ключи отбрасываются: пустой `number_key` есть у каждого талона без прочитанного номера, и
 * поиск по нему пометил бы половину базы.
 */
export async function neighbourRequestIds(
  exec: DbExecutor,
  params: TicketNeighbourKeys,
): Promise<string[]> {
  const keys = uniqueNonEmpty(params.numberKeys);
  const fuzzies = uniqueNonEmpty(params.numberFuzzies);
  const shas = uniqueNonEmpty(params.pageShas);
  if (keys.length === 0 && fuzzies.length === 0 && shas.length === 0) return [];

  const rows = await exec
    .selectDistinct({ requestId: wasteTickets.requestId })
    .from(wasteTickets)
    .innerJoin(wasteRequests, eq(wasteRequests.id, wasteTickets.requestId))
    .leftJoin(wasteTicketPages, eq(wasteTicketPages.id, wasteTickets.pageId))
    .where(
      and(
        ne(wasteTickets.requestId, params.requestId),
        ne(wasteTickets.status, 'dismissed'),
        sql`${wasteRequests.deletedAt} IS NULL`,
        or(
          keys.length ? inArray(wasteTickets.numberKey, keys) : undefined,
          fuzzies.length ? inArray(wasteTickets.numberFuzzy, fuzzies) : undefined,
          shas.length ? inArray(wasteTicketPages.pageSha256, shas) : undefined,
        ),
      ),
    );
  // Отсортированными — чтобы порядок пометки не зависел от плана запроса, а тест сравнивал список,
  // а не множество.
  return rows.map((row) => row.requestId).sort();
}

/**
 * Значки для страницы списка: сохранённые числа там, где они свежи, свой расчёт там, где нет
 * (Р19, Р21).
 *
 * Промах кэша не превращается в пустой значок и не выкидывает заявку из списка: незнание лечится
 * расчётом на месте — тем же самым, каким считает карточка. Цена промаха — та же пачка запросов,
 * что была до материализации, и платится она один раз: посчитанное тут же и сохраняется.
 *
 * Промахи считаются ОДНИМ вызовом загрузчика на всю страницу. Расчёт по заявке в цикле стоил бы
 * тридцати пачек запросов ради одной колонки — ровно того, ради чего загрузчик и сделан пакетным.
 *
 * Пишет условно и молча: проигравший читатель в базу не лезет (правило 2 в шапке), а победившую
 * строку перечитывает — расчёт, начатый до чужой мутации, старше её результата.
 */
export async function readOrRecomputeBadges(
  rows: readonly TicketCheckRequestRow[],
  exec: DbExecutor = db,
): Promise<Map<string, WasteTicketBadgeDto>> {
  const badges = new Map<string, WasteTicketBadgeDto>();
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return badges;

  const fingerprint = reviewStateInputFingerprint();
  const storedRows = await exec
    .select()
    .from(wasteTicketReviewState)
    .where(inArray(wasteTicketReviewState.requestId, ids));
  const stored = new Map(storedRows.map((row) => [row.requestId, row]));

  // The live queue is read alongside the stored rows (snow-removal plan, §3.2): a fresh row was
  // computed with no job in flight — numbers with one are stored stale — so a live job now means
  // the row predates it and an older outcome must not speak for paper being reread.
  const liveRows = await exec
    .selectDistinct({ requestId: sql<string>`${jobs.payload}->>'requestId'` })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, JOB_RECOGNIZE_WASTE_TICKET_FILE),
        inArray(jobs.status, ['pending', 'running']),
        inArray(sql`${jobs.payload}->>'requestId'`, ids),
      ),
    );
  const live = new Set(liveRows.map((row) => row.requestId));

  const misses: TicketCheckRequestRow[] = [];
  for (const row of rows) {
    const state = stored.get(row.id);
    if (state && isFresh(state, fingerprint) && !live.has(row.id)) {
      badges.set(row.id, badgeOf(state));
      continue;
    }
    misses.push(row);
  }
  if (misses.length === 0) return badges;

  const bundles = await loadTicketCheckInputs(misses, { exec });
  // По возрастанию `request_id` — по той же причине, по которой в этом порядке метят соседей:
  // читатель, которому передали транзакцию, копит те же блокировки, что и мутация.
  for (const row of [...misses].sort((a, b) => a.id.localeCompare(b.id))) {
    const known = stored.get(row.id);
    const bundle = bundles.get(row.id);

    if (!bundle) {
      // Бумаги у заявки нет: значка не будет, а оставшаяся строка — след исчезнувшей бумаги.
      if (known) await dropState(exec, row.id, known.revision);
      continue;
    }

    const badge = wasteTicketChecks(bundle.inputs).badge;
    badges.set(row.id, badge);
    if (!known) await ensureRow(exec, row.id);
    if (await writeBadge(exec, row.id, known?.revision ?? 0, badge, bundle.liveRecognition)) {
      continue;
    }

    // Проиграли. Числа победителя годятся человеку, только если он посчитал их по действующим
    // правилам; иначе показываем своё, но в базу не пишем — чинить строку будет тот, кто её испортил.
    const winner = await readState(exec, row.id);
    if (winner && isFresh(winner, fingerprint) && !bundle.liveRecognition) {
      badges.set(row.id, badgeOf(winner));
    }
  }
  return badges;
}
