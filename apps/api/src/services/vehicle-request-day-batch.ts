import { and, asc, eq } from 'drizzle-orm';
import {
  BACKDATE_REASON_MESSAGE,
  DAY_BATCH_LIMIT,
  DAY_BATCH_SKIP_AMBIGUOUS_ROUTE,
  DAY_BATCH_SKIP_BACKDATED,
  DAY_BATCH_SKIP_BEYOND_LIMIT,
  DAY_BATCH_SKIP_FROZEN,
  DAY_BATCH_SKIP_NO_ROOM,
  DAY_BATCH_SKIP_PLANNED,
  canIssueWaybill,
  canJoinRoute,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRelocationPurpose,
  isRouteEditable,
  linearDaysBlocker,
  linearRouteJoinDay,
  moscowDateKeyOf,
  planDayBlocker,
  routeRequestCapacity,
  shiftDaysOf,
  type BackdateVerdict,
  type DayBatchApplyInput,
  type VehicleRequestDayBatchResultDto,
  type VehicleRequestDayBatchRowDto,
  type VehicleRequestDaysDto,
  type WaybillFormCode,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  constructionObjects,
  persons,
  vehicleRequests,
  vehicleRouteRequests,
  vehicleRoutes,
} from '../db/schema';
import { writeAudit } from '../lib/audit';
import { AppError, err } from '../lib/errors';
import { logger } from '../logger';
import { assignmentStateOn } from './assignment-history';
import { readActualChanges, readHistoryIsAuthoritative } from './assignment-read';
import { assertRoutePlacement, hasSiteLocation, placeLinearDay } from './route-points';
import {
  asDayRaceConflict,
  assertDayRouteVehicle,
  loadLinearRequest,
  loadRequestDays,
  lockLinearRequest,
  openDayRoute,
  type LinearRequestState,
} from './vehicle-request-days';
import { markCorrectionWaybill } from './vehicle-route-correction';
import {
  attachRequest,
  bumpRouteVersion,
  lockRoute,
  plannedDaysOfRequest,
  routeRequestCount,
  routeWaybill,
  type RouteRow,
} from './vehicle-routes';
import {
  CORRECTION_OPERATION_ID_REQUIRED,
  checkBackdate,
  correctionFingerprint,
  findCorrection,
  insertCorrection,
  linkCorrectionRequests,
  sameCorrectionOrThrow,
  saveCorrectionPayload,
  type CorrectionRecord,
} from './waybill-correction';
import {
  issueWarningsOf,
  issueWaybillForRoute,
  loadWaybillIssueContext,
  routeWaybillFormFor,
  warningsFingerprint,
  type RouteWaybillContext,
} from './waybill-issue';

/**
 * Day batch for a special-equipment request on a site: "issue a 4-П for the whole term"
 * ([ADR 0207](../../../../docs/adr/0207-vehicle-request-day-batch.md)).
 *
 * THE BATCH HAS NOT A SINGLE RULE OF ITS OWN. It walks the term day after day and on every day does
 * exactly what the per-day door (`POST /vehicle-requests/:id/days/:date/route`) and the per-route
 * waybill issue do: the same predicates (`planDayBlocker`, `canJoinRoute`, `canIssueWaybill`), the
 * same lock order (route first, request second), the same shared waybill issue point. A second set
 * of rules would drift away from the first one silently, and one and the same day would turn out
 * available or not depending on which button touched it.
 *
 * ONE EXCEPTION IS NAMED OUT LOUD — the warning handshake (§10): the batch computes it itself
 * (`issueDayWaybill`), and no human takes part in it. He reads the warnings in the per-day report,
 * after the paper is issued.
 *
 * WHAT THE BATCH DOES OWN — exactly four things, and every one of them is named by a decision of
 * the ADR:
 *
 * 1. **A portion, not the whole term** (§11). One click takes the first `DAY_BATCH_LIMIT` days of
 *    the term that do not stand in routes yet; the rest is picked up by clicking again — with its
 *    own operation key and its own row in the corrections journal (`portionOf`).
 * 2. **A transaction per day, not per batch** (§8). `takeNextNumber` holds the series row under
 *    `FOR UPDATE` until the transaction ends, and the `main` series is shared by every 4-П of the
 *    portal: one transaction over fifty waybills would stop paper issue across the whole portal for
 *    as long as the batch runs. The price paid is non-atomicity — a batch broken off midway leaves
 *    what is done done, and that is more right than rolling back paper already handed out.
 * 3. **A day's refusal does not bring the batch down** (§7). An expected obstacle (the day already
 *    in a route, the route frozen, two routes on the vehicle, no task rows left, the past without
 *    the right) leaves as a report row carrying the contract's ready text; everything else becomes
 *    `failed` with the refusal text. The loop goes on.
 * 4. **The correction operation row is lazy, one per batch** (§9). It is opened inside the
 *    transaction of the first past day THAT REACHED ISSUE: an operation without a single waybill
 *    would litter the corrections journal the same way the per-day door would litter it if it
 *    opened an operation for every day it places.
 *
 * THE VEHICLE COMES FROM THE ASSIGNMENT, NOT FROM THE BODY (§5) — and a separate one per day: the
 * request may have changed vehicles inside its term (`docs/assignment-periods-plan.md`, R3), and a
 * day must land on the unit that worked exactly that day. A free choice inside the batch would
 * spread the paper over two vehicles in a way no screen would ever show.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * An expected obstacle of a day travels as an exception, not as a returned value.
 *
 * The reason is that an obstacle is sometimes found AFTER the first write as well: the day's route
 * may already be created when the request under its lock says "this day has just been placed into
 * another route". Returning a value would leave such a route in the database empty and named
 * nowhere; a thrown exception rolls the day's transaction back whole, and nothing is left in the
 * database but a gap in the «Р-» sequence (ADR 0207, consequences: identity is not rolled back
 * together with the transaction).
 */
class DaySkip extends Error {
  constructor(
    readonly skipReason: string,
    /** The route that did not take the day: the report names it to the human. */
    readonly routeNumber?: string,
  ) {
    super(skipReason);
    this.name = 'DaySkip';
  }
}

/** How a day that reached its commit ended. */
interface DayDone {
  routeId: string;
  routeNumber: string;
  /** The day's waybill; `null` when the batch was called without issue (`issueWaybills: false`). */
  waybill: { id: string; number: string } | null;
  /** The operation row, if this day opened or found it: only one per batch travels outwards. */
  correction: CorrectionRecord | null;
  backdated: boolean;
}

export interface DayBatchParams {
  requestId: string;
  /** The subject: backdating rights are asked of him, and audit events are signed by him. */
  actor: Principal;
  input: DayBatchApplyInput;
}

/**
 * Issue a 4-П for the whole term of the request.
 *
 * Returns the per-day report together with the new table of days: the card must show the new
 * picture at once, and by fetching it with a second request it risks showing a picture other than
 * the one the report was built from.
 */
export async function runVehicleRequestDayBatch(
  params: DayBatchParams,
): Promise<VehicleRequestDayBatchResultDto> {
  const { requestId, actor, input } = params;
  const reason = input.reason?.trim() ?? '';
  /*
   * Today in Moscow time — taken ONCE for the whole batch and passed down as a parameter.
   *
   * Fifty days do not pass in an instant, and a batch started at 23:59 would weigh the first half
   * of its days against one boundary of the past and the second half against another: the day that
   * is "today" would become a past day right in the middle of the work, would demand the correction
   * right and would end up skipped. One click must have one backdating boundary.
   */
  const today = moscowDateKeyOf(new Date());

  // ── Pre-check: everything able to refuse is asked BEFORE the first write ──

  const request = await loadLinearRequest(db, requestId);
  if (!request) throw err.notFound('Заявка не найдена');
  const blocker = linearDaysBlocker(request);
  if (blocker) throw err.unprocessable(blocker, { requestId: 'Дни недоступны' });

  const termDays = shiftDaysOf(request);
  /*
   * The portion of one click is measured BEFORE the first write and from a single read of the days
   * already planned.
   *
   * Reading them outside the loop and without a lock is deliberate: as a PROHIBITION these days are
   * re-read anyway by every day's transaction under the request lock (`assertDayPlannable`), while
   * here they are needed as the MEASURE of the portion, and the measure is taken once per click.
   * Should the picture drift while the batch runs, the day leaves as a skip in the report, not into
   * someone else's route.
   *
   * The transaction here serves only the signature of `plannedDaysOfRequest` — it writes nothing.
   */
  const { days, remaining } = portionOf(
    termDays,
    new Set(await db.transaction((tx) => plannedDaysOfRequest(tx, requestId))),
  );

  await assertObjectAddressable(requestId);
  await assertDriverAlive(input.driverPersonId);

  const vehicleByDay = await dayVehiclesOf(request, days);
  /*
   * A vehicle is checked ONCE per unit and before the loop (`assertDayRouteVehicle`). Inside the
   * loop that would mean reading the same row half a hundred times, and refusing in the middle of
   * routes already created, each of which has burnt its own «Р-» number out of the sequence.
   *
   * There is sometimes more than one unit: a request that changed vehicles inside its term works
   * the first half of the period with one and the second half with another, and both must be owned
   * and alive before the batch creates its first route. The transaction here serves only the
   * signature — it writes nothing.
   */
  const vehicleIds = [...new Set(vehicleByDay.values())];
  await db.transaction(async (tx) => {
    for (const vehicleId of vehicleIds) await assertDayRouteVehicle(tx, vehicleId);
  });

  const verdicts = new Map<string, BackdateVerdict>(
    days.map((date) => [
      date,
      checkBackdate({ effectiveDate: date, today, subject: actor, hasReason: reason !== '' }),
    ]),
  );
  /*
   * The reason is one per batch and is asked BEFORE the first write: what gets explained is not
   * each day separately but the decision to paper the past period at all. A refusal comes only
   * where the reason is the single thing missing (`code === 'reason'`): no right, or too deep in
   * the past, is an obstacle of particular days rather than of the whole batch, and such days are
   * skipped while the others go on.
   */
  if ([...verdicts.values()].some((v) => !v.ok && v.code === 'reason')) {
    throw err.unprocessable(BACKDATE_REASON_MESSAGE, { reason: 'Нужна причина' });
  }
  /*
   * The operation key is required exactly where the batch will open a corrections journal row and
   * burn numbered blanks with a past date: a retry after a dropped connection must continue the
   * former work instead of issuing a second stack. Today's and future paper is not a correction
   * operation and demands no key.
   */
  const willBackdate =
    input.issueWaybills && [...verdicts.values()].some((v) => v.ok && v.backdated);
  if (willBackdate && !input.operationId) {
    throw err.unprocessable(CORRECTION_OPERATION_ID_REQUIRED, {
      operationId: 'Не передан ключ операции',
    });
  }

  // ── The loop: its own transaction for every day ──

  const fingerprint = correctionFingerprint({ kind: 'day_batch', target: requestId, body: input });
  const rows: VehicleRequestDayBatchRowDto[] = [];
  /** The operation row is one per batch; the first past day reaching issue opens it. */
  let correction: CorrectionRecord | null = null;
  /** Waybills born with a past date: they are what the corrections journal operation explains. */
  const backdatedWaybills: { date: string; number: string; routeNumber: string }[] = [];

  for (const date of days) {
    const verdict = verdicts.get(date)!;
    if (!verdict.ok) {
      /*
       * The right and the depth are an obstacle of THIS day, not of the batch (ADR 0207 §7): the
       * other days of the term have nothing to do with the past and are issued as usual.
       *
       * Two refusals, not one: no right — it is granted the ordinary way, and the human has to go
       * to an administrator for that grant; too long ago — the right he has, and the depth is
       * lifted only by `waybills.correctBeyondLimit`, which is granted to nobody. One text for both
       * cases would send half the people to the wrong place. The `reason` refusal never reaches
       * here: the reason is asked before the loop, one per batch.
       */
      rows.push({
        date,
        outcome: 'skipped',
        reason: verdict.code === 'limit' ? DAY_BATCH_SKIP_BEYOND_LIMIT : DAY_BATCH_SKIP_BACKDATED,
      });
      continue;
    }
    const vehicleId = vehicleByDay.get(date)!;
    try {
      const done = await db.transaction((tx) =>
        runDay(tx, {
          request,
          date,
          vehicleId,
          actor,
          input,
          reason,
          backdated: verdict.backdated,
          fingerprint,
          // The operation found by an earlier day travels down: looking it up anew every day
          // would mean reading the corrections journal half a hundred times for the same row.
          correction,
        }),
      );
      if (done.correction) correction = done.correction;
      if (done.waybill) {
        rows.push({
          date,
          outcome: 'issued',
          routeNumber: done.routeNumber,
          waybillNumber: done.waybill.number,
        });
        if (done.backdated) {
          backdatedWaybills.push({
            date,
            number: done.waybill.number,
            routeNumber: done.routeNumber,
          });
        }
      } else {
        rows.push({ date, outcome: 'planned', routeNumber: done.routeNumber });
      }
      await auditDay(actor, requestId, date, done, reason);
    } catch (e) {
      if (e instanceof DaySkip) {
        rows.push({
          date,
          outcome: 'skipped',
          reason: e.skipReason,
          ...(e.routeNumber ? { routeNumber: e.routeNumber } : {}),
        });
        continue;
      }
      /*
       * `failed` is everything not recognised as an expected obstacle. The text of a domain refusal
       * (422/409/404) is written for a human and goes into the report as it is; an unforeseen
       * failure the report names in general words, leaving the analysis to the log — otherwise the
       * contents of the exception would travel into the report.
       */
      rows.push({ date, outcome: 'failed', reason: failureReasonOf(e) });
      logger.error(
        { requestId, date, operationId: input.operationId, err: e },
        'пачка дней заказа: сбой дня',
      );
    }
  }

  /*
   * The operation snapshot and its link to the request — AFTER the loop and in a short transaction
   * of its own.
   *
   * After, because "what exactly was done with a past date" becomes known only once everything is
   * done; in its own transaction, because the day transactions are committed by then and `db` is
   * not passed into these functions: a corrections journal row is only ever written from a
   * transaction.
   */
  if (correction) {
    const id = correction.id;
    await db.transaction(async (tx) => {
      await saveCorrectionPayload(tx, id, {
        request: { id: requestId, number: formatVehicleRequestNumber(request.num) },
        term: {
          dateFrom: request.dateFrom ?? null,
          dateTo: request.dateTo ?? null,
          // The length of the TERM, not of the portion: the snapshot explains which period was
          // papered with a past date, and "50" instead of "90" on a quarterly request would read
          // as a trimmed request term. What this very click did is listed below by name — waybills.
          days: termDays.length,
        },
        waybills: backdatedWaybills,
      });
      // The batch has one request but up to fifty waybills under the operation: the link is kept
      // to the request, and that is how the investigation card finds the operation.
      await linkCorrectionRequests(tx, id, [requestId]);
    });
  }

  return {
    days: await daysResponse(requestId, request, today),
    rows,
    planned: rows.filter((row) => row.outcome === 'planned').length,
    issued: rows.filter((row) => row.outcome === 'issued').length,
    skipped: rows.filter((row) => row.outcome === 'skipped').length,
    failed: rows.filter((row) => row.outcome === 'failed').length,
    // The remainder is counted from the picture BEFORE the click and means exactly "days this click
    // did not include": recounting it after the loop would return the portion's skipped days into
    // the remainder — a retry does nothing with them, and "press again" would become a lie.
    remaining,
  };
}

/**
 * THE PORTION OF ONE CLICK (ADR 0207, decision 11): the first `DAY_BATCH_LIMIT` days of the term
 * that do not stand in the request's routes yet, plus the remainder — how many unplanned days are
 * left outside the window.
 *
 * The limit stands on the portion, not on the term. Refusing the whole term would cut off from the
 * button the very case it was asked for — a quarterly request: ninety days would not pass in any
 * single click, and the dispatcher would be left with the «Дни работ» table and ninety visits of
 * three clicks each.
 *
 * ONLY UNPLANNED DAYS TAKE UP ROOM IN THE PORTION. A day already standing in a route the batch will
 * skip anyway (`DAY_BATCH_SKIP_PLANNED`), and were it counted as taken, the second click would
 * first run into half a hundred of its own yesterday's days and would never reach the tail of the
 * term — the button would be pressed endlessly while the paper stood still.
 *
 * THE WINDOW does take such a day in, and it does get a report row: the batch walked it and did
 * nothing — keeping silent would read as "it did". For the same sake the window is not cut at the
 * first unplanned day: when everything is planned already, the report must explain the empty work
 * instead of arriving empty.
 */
function portionOf(
  termDays: readonly string[],
  planned: ReadonlySet<string>,
): { days: string[]; remaining: number } {
  const days: string[] = [];
  let taken = 0;
  let remaining = 0;
  for (const date of termDays) {
    const pending = !planned.has(date);
    if (taken >= DAY_BATCH_LIMIT) {
      if (pending) remaining += 1;
      continue;
    }
    if (pending) taken += 1;
    days.push(date);
  }
  return { days, remaining };
}

// ── One day ──

interface DayContext {
  request: LinearRequestState;
  date: string;
  vehicleId: string;
  actor: Principal;
  input: DayBatchApplyInput;
  reason: string;
  /**
   * Whether this day runs with a past date — the verdict computed before the loop against the
   * shared "today" (`checkBackdate`). Recomputing it inside the transaction is neither possible nor
   * needed: one click never has a second "today", while the calendar does manage to cross midnight
   * while the batch runs.
   */
  backdated: boolean;
  fingerprint: string;
  correction: CorrectionRecord | null;
}

/**
 * One day of the batch — in its own transaction and in the same order the per-day door walks it:
 * pick a route → put the day into the composition → lay out the point → check the blank → bump the
 * version → (if asked) issue the waybill.
 *
 * The lock order is shared across the module: route first, request second. The reverse order right
 * here is what would deadlock against the request status change, which takes the same rows the
 * other way round.
 */
async function runDay(tx: Tx, ctx: DayContext): Promise<DayDone> {
  const { date, request, actor } = ctx;

  /*
   * The cheap check by the rule comes BEFORE any route is created: a new route takes its number
   * from a sequence, and a refusal on the term after it was created would burn a «Р-» for nothing.
   * Under the lock the check repeats in the same words — here it is about order, not about
   * correctness.
   */
  await assertDayPlannable(tx, request, date, await plannedDaysOfRequest(tx, request.id));

  const route = await pickDayRoute(tx, ctx);
  // The request comes after the route: the lock order is shared across the module.
  const state = await lockLinearRequest(tx, request.id);
  if (!state) throw err.notFound('Заявка не найдена');
  const plannedDays = await plannedDaysOfRequest(tx, request.id);
  await assertDayPlannable(tx, state, date, plannedDays);

  const routeNumber = formatVehicleRouteNumber(route.num);
  const waybill = await routeWaybill(tx, route.id);
  if (!isRouteEditable(waybill?.status ?? null))
    throw new DaySkip(DAY_BATCH_SKIP_FROZEN, routeNumber);
  if (route.routeDate !== date) {
    // The composite FK (migration 0127) keeps the composition row's day equal to the route's day:
    // a neighbouring day's route the database simply will not take, and an integrity failure must
    // not be what explains that to the human.
    throw err.unprocessable(
      `Маршрут ${routeNumber} заведён на ${route.routeDate}, а планируется день ${date}`,
      { routeId: 'Рейс другого дня' },
    );
  }

  /*
   * The route's blank is read once: it sets both the capacity of the composition (`canJoinRoute`)
   * and the capacity of the task rows (`assertRoutePlacement`). Inside one transaction the
   * directory does not change under us, while reading the same thing twice is an extra query on
   * each of fifty days.
   */
  const formCode = (
    await routeWaybillFormFor(tx, { purpose: route.purpose, vehicleId: route.vehicleId })
  ).formCode;

  const check = canJoinRoute(
    {
      requestType: state.requestType,
      isLinear: state.isLinear,
      status: state.status,
      deletedAt: state.deletedAt,
      day: linearRouteJoinDay(state, plannedDays),
      ownership: state.ownership,
    },
    {
      routeDate: route.routeDate,
      requestCount: await routeRequestCount(tx, route.id),
      purpose: route.purpose,
      formCode,
    },
  );
  if (!check.ok) throw err.unprocessable(check.reason, { routeId: check.reason });

  try {
    await attachRequest(tx, route.id, request.id, date);
  } catch (e) {
    // A race of two dispatchers: the unique index catches it, not the check above.
    throw asDayRaceConflict(e, date);
  }
  /*
   * The task point goes in the same transaction as the composition row: without it the day would
   * stand in the route but would not print — the waybill's task is assembled from points, not from
   * the composition.
   */
  await placeLinearDay(tx, route.id, request.id, date);
  // Capacity is checked after the layout: what has to be counted are the task rows (trips plus
  // linear days), and before the day is placed there is one fewer of them.
  await assertRoutePlacement(tx, { routeId: route.id, formCode });
  await bumpRouteVersion(tx, route.id, actor.id);

  if (!ctx.input.issueWaybills) {
    /*
     * No paper was asked for — the day only took its place in the route. The backdating does not
     * disappear because of that: placing a past day went through the same `backdateGuard`, and the
     * audit event must say so. Such a day has no row of its own in the corrections journal, by the
     * same rule that holds for the per-day door: it spends no numbered blank, and an operation
     * without a single waybill would litter the journal.
     */
    return {
      routeId: route.id,
      routeNumber,
      waybill: null,
      correction: null,
      backdated: ctx.backdated,
    };
  }
  return issueDayWaybill(tx, ctx, route, routeNumber, formCode);
}

/**
 * Why this day is not planned — with "an expected obstacle" told apart from "a failure".
 *
 * A day already taken is exactly what makes a batch retry safe: this very check cuts it off and
 * names it with the contract's ready text. The day's unique index is not what produces this skip —
 * it only guards the race of two dispatchers, and its breach becomes a failure row, not a skip.
 * Everything else `planDayBlocker` would return (the
 * request was taken out of work, the vehicle was withdrawn, the term was moved in the middle of the
 * batch) is not an obstacle of the day — it is a change of the request's state, and declaring that
 * with a silent skip is not allowed.
 */
async function assertDayPlannable(
  tx: Tx,
  subject: LinearRequestState,
  date: string,
  plannedDays: readonly string[],
): Promise<void> {
  if (plannedDays.includes(date)) {
    // The route is named: in a report of half a hundred rows "the day already stands in a route"
    // without a number does not say which one, and that is exactly where the dispatcher goes to
    // sort it out. The query is issued only on this branch — the branch that is the skip itself —
    // and not on every day of the batch.
    throw new DaySkip(DAY_BATCH_SKIP_PLANNED, await plannedDayRouteNumber(tx, subject.id, date));
  }
  const blocker = planDayBlocker(subject, date, plannedDays);
  if (blocker) throw err.unprocessable(blocker, { date: 'День недоступен' });
}

/**
 * The route the day already stands in. The composition row leads to the route by a composite key
 * (migration 0127), and a day without a route does not happen here by construction — the «Р-» of
 * such a day is always known.
 *
 * Almost always: `undefined` stays a legitimate answer to a race. The first pass of
 * `assertDayPlannable` runs before the request is locked, and between reading the planned days and
 * this query another transaction manages to take the day off its route. There is nothing to bring
 * the batch down with over that, and no reason to: the skip from such a day is right anyway, only
 * without the route's name.
 */
async function plannedDayRouteNumber(
  tx: Tx,
  requestId: string,
  date: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ num: vehicleRoutes.num })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRoutes, eq(vehicleRoutes.id, vehicleRouteRequests.routeId))
    .where(
      and(eq(vehicleRouteRequests.requestId, requestId), eq(vehicleRouteRequests.workDate, date)),
    );
  return row ? formatVehicleRouteNumber(row.num) : undefined;
}

/**
 * THE RULE FOR PICKING A DAY'S ROUTE is its own, because no ready query fits it.
 *
 * `GET /vehicle-routes/suggest` will not do: it hands the dispatcher everything the vehicle has on
 * the date, and a human chooses — by eye and without a lock. The batch has nobody to choose for it,
 * and another transaction lies between the read and the insert, so candidates are taken under
 * `FOR UPDATE` and the decision is made on rows that are already locked.
 *
 * The candidates are the freight routes of this vehicle on this date. A relocation is filtered out
 * before anything else and is no candidate at all: it has no composition by construction (it runs
 * under its own grounding request), and "the vehicle has two routes" would be untrue about it.
 *
 * Then three counts decide, and their order is exactly this:
 *
 *   not a single freight route       → the batch creates its own (`openDayRoute`);
 *   more than one eligible           → the day is skipped (`DAY_BATCH_SKIP_AMBIGUOUS_ROUTE`);
 *   exactly one eligible             → the day goes into it;
 *   routes exist, none eligible      → the first one's reason is named: frozen, or no room.
 *
 * That last line is no trifle. Were the batch to create a second route beside a frozen one, the
 * vehicle would hold two blanks for one day's work; were it to answer "zero candidates" where the
 * blank has run out of task rows, the dispatcher would never learn that there is nothing left to
 * pack the day with. The choice between two eligible routes (morning and evening is a legitimate
 * state) the batch does not take upon itself: get it wrong, and the day would travel into somebody
 * else's task, and that would be noticed at the printer.
 */
async function pickDayRoute(tx: Tx, ctx: DayContext): Promise<RouteRow> {
  const ids = await tx
    .select({ id: vehicleRoutes.id, purpose: vehicleRoutes.purpose })
    .from(vehicleRoutes)
    .where(and(eq(vehicleRoutes.vehicleId, ctx.vehicleId), eq(vehicleRoutes.routeDate, ctx.date)))
    .orderBy(asc(vehicleRoutes.id));

  const candidates: RouteRow[] = [];
  // The lock order is one for the whole module: routes are taken by ascending `id`, or two opposing
  // commands on the same routes will deadlock against each other.
  for (const row of ids) {
    if (isRelocationPurpose(row.purpose)) continue;
    candidates.push(await lockRoute(tx, row.id));
  }
  if (candidates.length === 0) {
    return openDayRoute(tx, {
      body: {
        // The vehicle comes from the assignment for this day (ADR 0207 §5), the driver is one for
        // the whole period (§6): there is no vehicle field in the window at all, and a person is
        // never filled in without being asked (ADR 0083).
        newRoute: { vehicleId: ctx.vehicleId, driverPersonId: ctx.input.driverPersonId },
      },
      date: ctx.date,
      actorId: ctx.actor.id,
    });
  }

  const eligible: RouteRow[] = [];
  let refusal: DaySkip | null = null;
  for (const candidate of candidates) {
    const number = formatVehicleRouteNumber(candidate.num);
    const waybill = await routeWaybill(tx, candidate.id);
    if (!isRouteEditable(waybill?.status ?? null)) {
      refusal ??= new DaySkip(DAY_BATCH_SKIP_FROZEN, number);
      continue;
    }
    const formCode = (
      await routeWaybillFormFor(tx, { purpose: candidate.purpose, vehicleId: candidate.vehicleId })
    ).formCode;
    if ((await routeRequestCount(tx, candidate.id)) >= routeRequestCapacity(formCode)) {
      refusal ??= new DaySkip(DAY_BATCH_SKIP_NO_ROOM, number);
      continue;
    }
    eligible.push(candidate);
  }
  if (eligible.length > 1) {
    throw new DaySkip(DAY_BATCH_SKIP_AMBIGUOUS_ROUTE, formatVehicleRouteNumber(eligible[0]!.num));
  }
  if (eligible.length === 0) throw refusal ?? new DaySkip(DAY_BATCH_SKIP_NO_ROOM);
  return eligible[0]!;
}

/**
 * The day's waybill: `lockRoute` → `canIssueWaybill` → `issueWaybillForRoute`.
 *
 * THE BATCH COMPUTES THE HANDSHAKE ITSELF (ADR 0207 §10). For a single issue the fingerprint of the
 * warning set is brought by a human — he has read them in the window; the batch has nowhere to
 * bring it from: there are up to fifty sets, and each one becomes known only under locks that are
 * already taken. So the server assembles the context, computes the set and fills its fingerprint
 * into `acknowledge` itself.
 *
 * THE PRICE IS NAMED OUTRIGHT: the batch has no human handshake at all. He confirms neither the
 * summary (it is not shown: the batch has no preview door) nor the set of each waybill — and learns
 * of the warnings from the per-day report, when the paper is already issued. `acknowledge` here
 * means not "the human has read it" but "the set was computed at issue", and in the waybill it
 * stays exactly what it was at birth. For a single issue the rule (ADR 0108 §21) does not change at
 * all.
 *
 * The context is read twice — here and inside `issueWaybillForRoute`. This is a read, not a write,
 * and the alternative to it is an "already computed set" field in the signature of the shared issue
 * point, that is, precisely the hole the handshake lives inside that point to close
 * (`waybill-issue.ts`, R21a).
 */
async function issueDayWaybill(
  tx: Tx,
  ctx: DayContext,
  locked: RouteRow,
  routeNumber: string,
  formCode: WaybillFormCode | null,
): Promise<DayDone> {
  // The route is re-read under the same lock: its version grew when the day was laid out, and the
  // route's details travel into the waybill context — taking them from a row read before the change
  // would mean printing the wrong thing.
  const route = await lockRoute(tx, locked.id);
  const backdated = ctx.backdated;

  /*
   * The composition is taken under `FOR UPDATE` of the request rows and by ascending `id` — the
   * same order in which waybill cancellation takes them (`waybill-locks.ts`). Two orders on the
   * same rows are a deadlock on the very first route where the ticket numbers do not run in the
   * order of the identifiers; the ticket position matters to the paper and is therefore sorted in
   * memory instead.
   */
  const composition = await tx
    .select({
      requestId: vehicleRouteRequests.requestId,
      position: vehicleRouteRequests.position,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    .where(eq(vehicleRouteRequests.routeId, route.id))
    .orderBy(asc(vehicleRequests.id))
    .for('update', { of: vehicleRequests });
  const rows = [...composition].sort((a, b) => a.position - b.position);

  const check = canIssueWaybill({
    purpose: route.purpose,
    driverPersonId: route.driverPersonId,
    // A blank without requests cannot happen in a batch by construction: the day has just entered
    // the composition of this very route.
    blankAllowed: false,
    formCode,
    requests: rows.map((row) => ({
      displayNumber: formatVehicleRequestNumber(row.num),
      status: row.status,
    })),
    sourceRequest: null,
    waybillStatus: (await routeWaybill(tx, route.id))?.status ?? null,
  });
  if (!check.ok) {
    throw err.unprocessable(
      check.blocking.length > 0 ? `${check.reason}: ${check.blocking.join(', ')}` : check.reason,
    );
  }

  const context: RouteWaybillContext = {
    routeId: route.id,
    routeNumber,
    purpose: route.purpose,
    vehicleId: route.vehicleId,
    routeDate: route.routeDate,
    driverPersonId: route.driverPersonId!,
    trip: {
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      trailer2Model: route.trailer2Model,
      trailer2RegNumber: route.trailer2RegNumber,
      garageNumber: route.garageNumber,
      communicationKind: route.communicationKind,
      transportationKind: route.transportationKind,
    },
    requests: rows.map((row) => ({ requestId: row.requestId, position: row.position })),
    relocation: null,
    acknowledge: null,
    actor: { id: ctx.actor.id },
  };
  const warnings = issueWarningsOf(await loadWaybillIssueContext(tx, context));
  const issued = await issueWaybillForRoute(tx, {
    ...context,
    // An empty set needs no handshake at all, and filling in the fingerprint of an empty list is
    // pointless: the shared issue point writes `clean` into the waybill — "checked, there were no
    // warnings".
    acknowledge: warnings.length > 0 ? { fingerprint: warningsFingerprint(warnings) } : null,
  });

  if (!backdated) {
    return { routeId: route.id, routeNumber, waybill: issued, correction: null, backdated };
  }
  /*
   * THE LAZY OPERATION ROW (ADR 0207 §9): it is opened right here — inside the transaction of the
   * first past day that reached issue — and not a minute earlier. Had the batch opened it before
   * the loop, the corrections journal would gain an operation on every click, including the click
   * where every past day turned out skipped and not a single number was burnt. By the same rule the
   * per-day door opens no operation at all: placing a day into a route spends no numbered blank.
   *
   * `runCorrection` does not fit here and is not used: it opens its OWN transaction around the
   * whole work, while the batch has its own transaction per day (§8). So the same three steps are
   * called by hand — but exactly the same functions: an INSERT of one's own into the corrections
   * journal is forbidden, and it says so there in plain words.
   */
  const correction = ctx.correction ?? (await openCorrection(tx, ctx));
  await markCorrectionWaybill(tx, {
    waybillId: issued.id,
    correctionId: correction.id,
    reason: ctx.reason,
    // There was nothing to replace: a past day's waybill is born not instead of another one, and is
    // explained by the reason while the reference stays empty
    // (`waybills_correction_issue_reason_check`).
    correctsWaybillId: null,
  });
  return { routeId: route.id, routeNumber, waybill: issued, correction, backdated };
}

/**
 * The operation row by the client's key: found — it is verified by the same two marks as every
 * other correction entrance (the author and the fingerprint of the body); not found — it is
 * inserted.
 *
 * A retry with the SAME body continues the work of the former batch: days already placed into
 * routes are cut off by `assertDayPlannable` and leave as skips, while the unfinished ones get finished
 * under the same operation. A retry with a DIFFERENT body runs into `sameCorrectionOrThrow` — and
 * that is the right outcome: the key answers only "a retry?", and a client that reused a uuid would
 * otherwise silently receive somebody else's work.
 */
async function openCorrection(tx: Tx, ctx: DayContext): Promise<CorrectionRecord> {
  const expected = { actorUserId: ctx.actor.id, fingerprint: ctx.fingerprint };
  const operationId = ctx.input.operationId!;
  const prior = await findCorrection(tx, operationId);
  if (prior) return sameCorrectionOrThrow(prior, expected);
  return insertCorrection(tx, {
    operationId,
    fingerprint: ctx.fingerprint,
    kind: 'day_batch',
    reason: ctx.reason,
    actorUserId: ctx.actor.id,
  });
}

// ── Pre-checks ──

/**
 * The request's object is addressable — asked before the first write.
 *
 * WHY BEFORE THE LOOP. `placeLinearDay` refuses a day without a site address (a route point
 * without a location cannot exist), and that refusal would arrive in the middle of the batch —
 * after the day's route has already been created and its «Р-» number burned, since the identity
 * sequence does not roll back with the transaction. The rule itself is not duplicated: both places
 * ask the same predicate, `hasSiteLocation` from `route-points.ts`.
 *
 * WHY IT IS A GUARD, NOT A BRANCH. By the schema the refusal is unreachable. An on-site order
 * always has an object (CHECK `vehicle_requests_customer_check` requires exactly one customer, and
 * `vehicle_requests_department_freight_check` gives departments freight only, which
 * `linearDaysBlocker` has already turned away), and an object's name is non-blank by the directory
 * form. The check stays for records written past the API — a seed, a migration, a manual fix —
 * where the alternative is a half-done batch. `notFound` is reachable only in a race with the
 * request's deletion after `loadLinearRequest` has read it.
 */
async function assertObjectAddressable(requestId: string): Promise<void> {
  const [row] = await db
    .select({
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  if (!hasSiteLocation(row)) {
    throw err.unprocessable(
      'У заявки не выбран объект — дням заказа неоткуда взять адрес площадки',
      { objectId: 'Нет объекта заявки' },
    );
  }
}

/**
 * The driver exists and is not withdrawn.
 *
 * Existence, not eligibility: eligibility is asked by the selection at waybill issue (ADR 0037 §6)
 * — the same place where it is checked for a single issue. What matters here is different: one
 * person covers the whole period, and "there is no such person" must sound before the batch creates
 * half a hundred routes referring to him.
 */
async function assertDriverAlive(driverPersonId: string): Promise<void> {
  const [driver] = await db
    .select({ deletedAt: persons.deletedAt })
    .from(persons)
    .where(eq(persons.id, driverPersonId));
  if (!driver || driver.deletedAt) throw err.badRequest('Водитель не найден');
}

/**
 * The vehicle of each day of the term — by the same rule its neighbours read it with
 * (`requestDayVehicleSql`, [assignment-read.ts](./assignment-read.ts)): in `history` mode the
 * answer is the last effective change of the vehicle timeline no later than the day, and where
 * there is no history — the assignment, exactly as in `legacy`.
 *
 * In the TS form of that same rule rather than as a SQL expression, for two reasons. First: there
 * are up to fifty days but only one question to the history — reading its rows once and folding
 * them in memory is cheaper than half a hundred correlated subqueries. Second:
 * `requestDayVehicleSql` lives in `WHERE` and in join conditions, while in the column list of a
 * single-table query drizzle loses the column qualification
 * (`office-equipment-sql-correlation.test.ts`). The real fold (`assignmentStateOn`) is that same
 * single carrier of the rule the SQL form refers to.
 */
async function dayVehiclesOf(
  request: LinearRequestState,
  days: readonly string[],
): Promise<Map<string, string>> {
  // The assignment is non-empty: without it `linearDaysBlocker` would not have let the batch
  // through ("no vehicle assigned to the request") — but as an answer to "what did the work" it is
  // a fallback all the same.
  const assigned = request.vehicleId;
  if (!assigned) throw err.unprocessable('На заявку не назначена техника — дни планировать нечем');

  const map = new Map(days.map((date) => [date, assigned]));
  if (!(await readHistoryIsAuthoritative())) return map;
  const changes = (await readActualChanges([request.id])).get(request.id) ?? [];
  if (changes.length === 0) return map;
  for (const date of days) {
    const state = assignmentStateOn(changes, date);
    if (state.vehicle) map.set(date, state.vehicle.vehicleId);
  }
  return map;
}

// ── The response and the audit log ──

/** The table of days after the batch — in the same shape the card's read hands it out. */
async function daysResponse(
  requestId: string,
  fallback: LinearRequestState,
  today: string,
): Promise<VehicleRequestDaysDto> {
  // The state is re-read: the batch ran half a hundred transactions, and answering with a table
  // built from the state before it would mean showing something other than what the report has just
  // been built about.
  const request = (await loadLinearRequest(db, requestId)) ?? fallback;
  return {
    items: await loadRequestDays(db, request),
    onDate: today,
    blocker: linearDaysBlocker(request),
  };
}

/**
 * The day's audit events — under the same names the single doors use, and AFTER the day's commit.
 *
 * The names are shared deliberately: the route composition changed and a blank number was handed
 * out — in the journal that must read the same way, no matter which door it came from. Backdating
 * is explained right in the event: placing a day has no row of its own in the corrections journal,
 * so "why was this day placed with a past date" is told here.
 */
async function auditDay(
  actor: Principal,
  requestId: string,
  date: string,
  done: DayDone,
  reason: string,
): Promise<void> {
  await writeAudit({
    actorUserId: actor.id,
    action: 'vehicle_route.attach',
    entityType: 'vehicle_route',
    entityId: done.routeId,
    metadata: { requestId, workDate: date, backdated: done.backdated, reason },
  });
  if (!done.waybill) return;
  await writeAudit({
    actorUserId: actor.id,
    action: 'waybill.issue',
    entityType: 'waybill',
    entityId: done.waybill.id,
    metadata: {
      number: done.waybill.number,
      routeId: done.routeId,
      blank: false,
      backdated: done.backdated,
      reason,
      correctionId: done.correction?.id ?? null,
    },
  });
}

/**
 * How the report explains a day that broke down.
 *
 * A domain refusal (422, 409, 404) is written for a human and reveals nothing extra — it goes into
 * the report as it is. Everything else is named in general words: the contents of an unforeseen
 * exception help nobody in the report, while the analysis lies in the log, by request and date.
 */
function failureReasonOf(e: unknown): string {
  if (e instanceof AppError && e.statusCode >= 400 && e.statusCode < 500) {
    return e.message || 'День не проведён';
  }
  return 'Сбой при обработке дня — попробуйте повторить пачку';
}
