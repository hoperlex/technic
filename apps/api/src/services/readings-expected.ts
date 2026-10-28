import { sql, type SQL } from 'drizzle-orm';
import type { db } from '../db/client';
import type { Tx } from './readings-chain';

/**
 * What the readings module expects from a vehicle and when a counter pair is continuous (plan
 * «Показания техники», Р26а, Р13а): the shared SQL fragments of every reader that asks.
 *
 * Apart from `readings-aggregate.ts` for one reason: the request day of the shift table
 * (`shift-driver-days.ts`, owner decision D16) asks the same continuity rule as the month aggregate,
 * and its pure rule tests load without an environment, while the aggregate brings the database
 * client at module load. Every type import here is erased.
 */

type Reader = Tx | typeof db;

/**
 * A request a route still serves: live (not archived) and not cancelled. An archived or cancelled
 * request stays in the composition as the route's history, but nobody drives for it. The same rule
 * answers the driver's task and the stops a reading captures (`servedRequests` in
 * `driver-assignment.ts`), the live composition of an expected route below and a request day's
 * shared route (`shift-driver-days.ts`); `request` is the alias of the `vehicle_requests` row.
 */
export function servedRequestSql(request: string): SQL {
  const q = sql.raw(request);
  return sql`(${q}.deleted_at IS NULL AND ${q}.status <> 'cancelled')`;
}

/**
 * The sentinel date of a route on the join of expectations and observations.
 *
 * `FULL JOIN` in PostgreSQL accepts only merge- or hash-joinable conditions, so the disjunction "by
 * the route OR by the waybill and its day" cannot be joined (checked on a live database: `FULL JOIN
 * is only supported with merge-joinable or hash-joinable join conditions`, Р32б). Both sides are
 * brought to one pair of equalities `(join_id, join_date)`: a waybill's day takes part in the key, a
 * route's does not, and an impossible date stands in for it on both sides. `-infinity` is chosen for
 * being impossible: any calendar sentinel would sooner or later be somebody's report day.
 *
 * The meaning does not change: the join is one to one anyway — `report_items_route_key` is unique by
 * `route_id`, `report_items_waybill_key` by `(waybill_id, report_date)`.
 */
const ROUTE_JOIN_DATE = sql`DATE '-infinity'`;

/**
 * What makes a route an expected shift (Р26а). One fragment for everyone who asks for expected
 * shifts — the fleet months and the intake registry (through `expectedRelationCte`), the maintenance
 * tail (`loadLastExpectedShiftDays`), the "not submitted" filter and the search for an unsubmitted
 * source (`readings-stats.ts`), the continuity of a counter pair (`counterPairBrokenSql`) — and
 * deliberately one: the rule "whom a reading is asked from" must be written exactly once. Were these
 * places to drift, the "mileage since maintenance is known only from below" highlight would light up
 * on shifts the statistics do not expect.
 *
 * The fragment expects the WHOLE `vehicle_routes` row under the alias `vr`: besides the key it needs
 * the vehicle and the day of the route. Every reader names it so, `readings-stats.ts` included, where
 * the alias is set by `alias(vehicleRoutes, 'vr')` for this fragment.
 */
export const EXPECTED_ROUTE_FILTER = sql`
       vr.driver_person_id IS NOT NULL
       /*
        * A valid waybill is required, and for THIS driver: the paper is personal, and a route
        * reassigned without reissuing its waybill is no task. The form of the waybill is not
        * checked: a route is closed by a 4-П or a form No. 3, and listing them here would make a
        * second place that says what closes a route.
        */
       AND EXISTS (SELECT 1
                     FROM waybills w
                    WHERE w.route_id = vr.id
                      AND w.status <> 'cancelled'
                      AND w.driver_person_id = vr.driver_person_id)
       /*
        * A live composition: a route left without a single served request is no task, there is
        * nothing to drive for. A relocation always stays: its task is not in the composition but in
        * "from/to".
        */
       AND (vr.purpose <> 'freight'
            OR EXISTS (SELECT 1
                         FROM vehicle_route_requests rr
                         JOIN vehicle_requests q ON q.id = rr.request_id
                        WHERE rr.route_id = vr.id
                          AND ${servedRequestSql('q')}))
       /*
        * Two papers for a day, one shift. For a special-equipment request on a site the portal
        * issues both the weekly ESM-2 and the daily 4-П for the same day of the same vehicle
        * (ADR 0207 §2 and §3): the customer accepted the double paper deliberately, double
        * accounting he did not. The vehicle worked one shift, its reading is one, and it is asked
        * for by the weekly waybill; the route of that day does not count as an expected shift.
        *
        * The route is suppressed, not the waybill: the weekly ESM-2 is the very report of the
        * vehicle's work on the site, the week is closed by it in accounting, while the daily blank
        * the dispatcher is free to cancel and reissue (ADR 0207 §2), and the shift expectation must
        * not travel after a paper that gets reissued. Were the portal to suppress neither, the
        * second would have nothing to close it: a report row is tied to exactly one source, either
        * a route or a waybill with a day, and one physically submitted shift closes exactly one
        * expectation. The other would hang unsubmitted for the whole term: the garage red every
        * day, data quality halved, and the service readings book with doubled rows.
        *
        * The condition is narrow: same request, same vehicle, same day. The day is taken from the
        * composition row, whose work_date physically equals the route's day
        * (vehicle_route_requests_route_date_fk) and is empty on a freight row. So a freight route
        * and a relocation inside an ESM-2 week stay expected shifts, as they were: a week on the
        * site does not cover their trip.
        *
        * The driver takes no part in the condition: the vehicle's shift is counted, not the
        * person's. When the week is reissued to a substitute machinist while the daily 4-П stay on
        * the former one, the reading is submitted by whoever the weekly waybill names. The driver
        * cabinet suppresses the card exactly the same way (driver-assignment.ts), and the two must
        * not drift: the report composition is assembled there.
        */
       AND NOT EXISTS (SELECT 1
                         FROM waybills ew
                         JOIN vehicle_route_requests err ON err.request_id = ew.source_request_id
                        WHERE ew.form_code = 'esm2'
                          AND ew.status <> 'cancelled'
                          AND ew.vehicle_id = vr.vehicle_id
                          AND ew.period_from <= vr.route_date
                          AND ew.period_to >= vr.route_date
                          AND err.route_id = vr.id
                          AND err.work_date = vr.route_date)`;

/**
 * What makes a weekly waybill a source of expected shifts (Р26а, Р34). The period bounds are not
 * part of the fragment: the fleet months and the maintenance tail have different ones, while "which
 * waybill asks for readings at all" is the same. The fragment expects the alias `w` on the waybill.
 */
export const EXPECTED_ESM2_FILTER = sql`
       w.form_code = 'esm2'
       AND w.status <> 'cancelled'
       AND w.period_from IS NOT NULL
       AND w.period_to IS NOT NULL`;

/**
 * `AND column IN (...)` over the given vehicles, or nothing for the whole fleet. An empty list is a
 * question about no vehicle and answers nothing, rather than an `IN ()` that does not parse.
 */
function vehicleScopeSql(column: string, vehicleIds: readonly string[] | undefined): SQL {
  if (vehicleIds === undefined) return sql``;
  if (vehicleIds.length === 0) return sql`AND false`;
  const list = sql.join(
    vehicleIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`AND ${sql.raw(column)} IN (${list})`;
}

/**
 * The common part of the queries that need **the expected shifts of a period together with their
 * report rows**: three CTEs — `expected`, `observed` and `relation`. A second rule of "what an
 * expected shift is" must not exist in the project, so the fragment is shared, not copied: the fleet
 * months (`readings-aggregate.ts`), the intake registry (`readings-intake.ts`) and the continuity of
 * a request day's pairs (`loadBrokenCounterPairs`) ask it, and were they to drift in a single
 * condition, the intake screen would demand readings for shifts the statistics do not expect.
 *
 * Returned **without** a leading `WITH`: the reader appends its own CTEs after a comma.
 *
 * The columns are the union of the readers' needs, which is cheaper than two similar fragments:
 * everything added beyond the fleet months (the source kind, the person, the report version, the
 * shift position) comes from tables already joined and adds no join.
 *
 * Three properties, each a decision taken:
 *
 * 1. **A full outer join without folding the coordinates** (Р26в, Р32): an expectation without a
 *    row is an unsubmitted shift, a row without an expectation is an already collected reading of a
 *    source that was reassigned or whose waybill was cancelled. Neither may be lost.
 * 2. **The join is a pair of equalities `(join_id, join_date)`**, not a disjunction (Р32б):
 *    `FULL JOIN` in PostgreSQL accepts only merge- or hash-joinable conditions.
 * 3. **`aligned` is wrapped in `coalesce(..., false)`** (Р32а): for a day nobody opened the
 *    comparison gives `NULL`, and three-valued logic would swallow exactly the case the mark exists
 *    for.
 *
 * `vehicleIds` narrows both projections to the vehicles a reader asks about — the continuity of a
 * request day's pairs, where only an expected row of those vehicles can answer and an observation
 * of another vehicle never aligns with it (`aligned` compares the vehicles). So the narrowing
 * changes no answer about those vehicles; the fleet readers pass none.
 */
export function expectedRelationCte(from: string, to: string, vehicleIds?: readonly string[]): SQL {
  return sql`
expected AS (
    /*
     * An expected source is the day's route (Р26а). The rule repeats the driver cabinet
     * (driver-assignment.ts), and on purpose: a divergence would mean asking the driver for
     * readings of shifts he does not see in his task. The selection itself is EXPECTED_ROUTE_FILTER:
     * the maintenance tail asks it too.
     */
    SELECT vr.id                     AS join_id,
           ${ROUTE_JOIN_DATE}        AS join_date,
           'route'::text             AS source_kind,
           vr.vehicle_id             AS exp_vehicle,
           vr.route_date             AS exp_date,
           vr.driver_person_id       AS exp_person,
           rep.id                    AS exp_report_id,
           rep.state::text           AS exp_state,
           rep.version               AS exp_report_version
      FROM vehicle_routes vr
      /*
       * The report of the EXPECTED person for this day, if it exists at all. Its state answers for
       * the quality: after a route is reassigned, the reading is expected from the new driver, and
       * the former one's accepted day has nothing to do with it.
       *
       * A voided report (Р27) is not the day's report: it has no rows — the move took them along
       * with the readings — and the day waits for a reading as if nobody had opened it. The quality
       * is not affected (IS DISTINCT FROM 'accepted' is true alike for 'voided' and for no state),
       * and the intake registry cannot attribute a row to a report that cannot be accepted.
       */
      LEFT JOIN driver_daily_reports rep
             ON rep.person_id = vr.driver_person_id
            AND rep.report_date = vr.route_date
            AND rep.state <> 'voided'
     WHERE vr.route_date BETWEEN ${from}::date AND ${to}::date
       ${vehicleScopeSql('vr.vehicle_id', vehicleIds)}
       AND ${EXPECTED_ROUTE_FILTER}
    UNION ALL
    /*
     * An expected source is a weekly ESM-2 laid out over EVERY calendar day it is in force (Р34).
     * Shifts are the days of the document, not trips: a week with two idle days still has seven
     * expected shifts. Not a choice of the statistics but the module's behavior — the cabinet shows
     * the task by the same rule.
     *
     * The bounds are the intersection with the period, and ::date is required: generate_series over
     * dates returns timestamps, and without the cast the day would go into the grouping as a
     * timestamp. The input is cast to a timestamp without a time zone, so the day does not depend on
     * the session's TimeZone.
     */
    SELECT w.id, gs.day::date, 'esm2'::text, w.vehicle_id, gs.day::date, w.driver_person_id,
           rep.id, rep.state::text, rep.version
      FROM waybills w
      CROSS JOIN LATERAL generate_series(greatest(w.period_from, ${from}::date)::timestamp,
                                         least(w.period_to, ${to}::date)::timestamp,
                                         interval '1 day') AS gs(day)
      LEFT JOIN driver_daily_reports rep
             ON rep.person_id = w.driver_person_id
            AND rep.report_date = gs.day::date
            AND rep.state <> 'voided'
     WHERE ${EXPECTED_ESM2_FILTER}
       ${vehicleScopeSql('w.vehicle_id', vehicleIds)}
       AND w.period_from <= ${to}::date
       AND w.period_to >= ${from}::date
),
observed AS (
    /*
     * Report rows of non-voided reports only (Р27). The selection is an INNER JOIN, not a condition
     * inside a LEFT JOIN: otherwise the row would stay in the set with an empty state, and a reading
     * of a voided report would get into both the sums and the quality.
     *
     * The period is asked of the snapshot's day: a number lives in its own month (Р4). A row whose
     * source was moved across the period bound stays here and is counted — collected data must not
     * be lost.
     */
    SELECT i.id                               AS item_id,
           coalesce(i.route_id, i.waybill_id) AS join_id,
           CASE WHEN i.route_id IS NOT NULL THEN ${ROUTE_JOIN_DATE} ELSE i.report_date END
                                              AS join_date,
           i.source_kind::text                AS source_kind,
           i.vehicle_id                       AS obs_vehicle,
           i.report_date                      AS obs_date,
           i.shift_order                      AS obs_shift_order,
           i.report_id                        AS obs_report_id,
           rep.person_id                      AS obs_person,
           rep.state::text                    AS obs_state,
           rep.version                        AS obs_report_version
      FROM driver_daily_report_items i
      JOIN driver_daily_reports rep ON rep.id = i.report_id AND rep.state <> 'voided'
     WHERE i.report_date BETWEEN ${from}::date AND ${to}::date
       ${vehicleScopeSql('i.vehicle_id', vehicleIds)}
),
relation AS (
    /*
     * A full join WITHOUT folding the coordinates (Р26в, Р32): an expectation without a row is an
     * unsubmitted shift, a row without an expectation is an already collected reading of a source
     * that was reassigned or whose waybill was cancelled. Neither may be lost; the difference
     * between them is what the intake sorts out.
     */
    SELECT join_id AS source_id,
           coalesce(e.source_kind, o.source_kind) AS source_kind,
           e.exp_vehicle,
           e.exp_date,
           e.exp_person,
           e.exp_report_id,
           e.exp_state,
           e.exp_report_version,
           o.item_id,
           o.obs_vehicle,
           o.obs_date,
           o.obs_shift_order,
           o.obs_report_id,
           o.obs_person,
           o.obs_state,
           o.obs_report_version,
           /*
            * Whether the coordinates met (Р32а). That a row of this source exists means nothing by
            * itself: a route moved from 10.08 to 11.08 has an item_id, but no number at the live
            * coordinate 11.08, and without the alignment mark the old reading would suppress the
            * demand to submit a reading for the new date.
            *
            * coalesce(..., false) is required, not decoration: for a day nobody opened
            * exp_report_id is empty, the comparison gives NULL, NOT NULL is NULL again, and
            * count(*) FILTER (WHERE missing) would NOT count such a row — three-valued logic would
            * swallow exactly the case the mark exists for. ITEM_NEEDS_ATTENTION in
            * readings-stats.ts is wrapped the same way.
            */
           coalesce(o.obs_report_id = e.exp_report_id
                    AND o.obs_vehicle = e.exp_vehicle
                    AND o.obs_date = e.exp_date, false) AS aligned
      FROM expected e
      FULL OUTER JOIN observed o USING (join_id, join_date)
)`;
}

/**
 * The relation with its readings attached: the `points` CTE, appended after `expectedRelationCte`.
 *
 * The reading is attached BEFORE the split into projections (Р32в): the numbers projection takes the
 * numbers, while `reading_id` and `kind` are needed by the quality as well — the "shift without a
 * number" mark and the continuity of a pair look at them. Kept inside the numbers projection, this
 * join would hide the readings from both.
 */
export const EXPECTED_POINTS_CTE = sql`
points AS (
    SELECT r.*,
           v.id                            AS reading_id,
           v.kind::text                    AS kind,
           v.odometer_km,
           v.engine_hours,
           v.fuel_filled_liters,
           /*
            * Tank levels (ADR 0163) are a level, not a flow: they are not summed over a period and
            * come here only for the shift's consumption (start + filled − end), which is not counted
            * at all without both ends.
            */
           v.fuel_start_liters,
           v.fuel_end_liters,
           v.previous_odometer_id,
           v.previous_engine_hours_id,
           v.odometer_anomaly::text        AS odometer_anomaly,
           v.engine_hours_anomaly::text    AS engine_hours_anomaly,
           /*
            * The anomaly confirmation is needed by the norm check (docs/fuel-norms-plan.md, Р10б):
            * an unconfirmed odometer jump gives a base of thousands of kilometres and a "saving"
            * near a hundred percent, while a confirmed one is a number the garage has accepted.
            */
           v.odometer_anomaly_confirmed_at,
           v.engine_hours_anomaly_confirmed_at
      FROM relation r
      LEFT JOIN vehicle_readings v ON v.item_id = r.item_id
)`;

/** The counter whose chain a pair belongs to: the odometer and the engine hours are independent. */
export type PairCounter = 'odometer' | 'engineHours';

const PAIR_COUNTER_COLUMN: Record<PairCounter, SQL> = {
  odometer: sql`q.odometer_km`,
  engineHours: sql`q.engine_hours`,
};

/**
 * Whether a counter pair is BROKEN (Р13а): an expected shift of the vehicle lies between the
 * predecessor snapshot and the current one without numbers. ONE definition for the month aggregate
 * (its fuel norm check, `readings-aggregate.ts`) and for a request day's one-click sign-off
 * (`shift-driver-days.ts`, D16). Reads the `points` CTE (`EXPECTED_POINTS_CTE`).
 *
 * A counter's difference is assigned along the readings chain: the predecessor is the last snapshot
 * WITH A NUMBER, not the previous shift. So one difference covers every unsubmitted shift before it:
 * 400 km against one tank would give a false 60% saving, and a request day would sign several days'
 * engine hours as one.
 *
 * It cannot be checked on the snapshot projection: a shift whose day nobody opened has no row in the
 * set at all — its "neighbouring row" and its "chain predecessor" coincide, and the gap looks
 * continuous. Hence the deliberate exception to "numbers by the snapshot coordinate": gaps are
 * searched among the EXPECTED shifts. A day with no expected shift — a weekend, a day off the site —
 * breaks nothing, however many calendar days lie between the snapshots.
 *
 * The interval is half-open: the predecessor's date exclusive, the shift's date inclusive. Hence the
 * asymmetry the plan names: an unsubmitted second shift of the same day breaks the pair, a second
 * shift of the predecessor's day does not; an expectation has no shift position.
 *
 * Strictness depends on the document (Р13б): a route's day of expectation means work, a weekly
 * ESM-2's means only that the waybill is in force, so it breaks only on a day whose report was
 * opened without numbers. Otherwise all the machinery on weekly waybills — everything normed in
 * l/h — would never be checked at all.
 */
export function counterPairBrokenSql(
  counter: PairCounter,
  pair: { vehicle: SQL; previousDate: SQL; date: SQL },
): SQL {
  return sql`EXISTS (
               SELECT 1 FROM points q
                WHERE q.exp_vehicle = ${pair.vehicle}
                  AND q.exp_date > ${pair.previousDate}
                  AND q.exp_date <= ${pair.date}
                  AND (NOT q.aligned OR q.reading_id IS NULL OR q.kind = 'no_data'
                       OR ${PAIR_COUNTER_COLUMN[counter]} IS NULL)
                  AND (q.source_kind = 'route' OR q.exp_report_id IS NOT NULL)
           )`;
}

/** A counter pair by its coordinates: the vehicle, the predecessor's day and the snapshot's day. */
export interface CounterPair {
  vehicleId: string;
  previousDate: string;
  date: string;
}

export function counterPairKey(pair: CounterPair): string {
  return `${pair.vehicleId}|${pair.previousDate}|${pair.date}`;
}

/**
 * The broken pairs among the given ones, by `counterPairKey`: one query for any number of pairs. A
 * pair within one day is continuous by the half-open interval and is not asked.
 *
 * The relation is read for the vehicles of the pairs only and for the days between the oldest
 * predecessor and the latest snapshot — the continuity of a pair depends on nothing else.
 */
export async function loadBrokenCounterPairs(
  reader: Reader,
  counter: PairCounter,
  pairs: readonly CounterPair[],
): Promise<Set<string>> {
  const asked = new Map<string, CounterPair>();
  for (const pair of pairs) {
    if (pair.previousDate < pair.date) asked.set(counterPairKey(pair), pair);
  }
  const broken = new Set<string>();
  if (asked.size === 0) return broken;
  const list = [...asked.values()];
  const from = list.reduce(
    (min, p) => (p.previousDate < min ? p.previousDate : min),
    list[0]!.date,
  );
  const to = list.reduce((max, p) => (p.date > max ? p.date : max), list[0]!.date);
  const vehicleIds = [...new Set(list.map((p) => p.vehicleId))];
  const values = sql.join(
    list.map((p) => sql`(${p.vehicleId}::uuid, ${p.previousDate}::date, ${p.date}::date)`),
    sql`, `,
  );
  const result = await reader.execute<{ vehicle_id: string; previous_date: string; d: string }>(sql`
WITH ${expectedRelationCte(from, to, vehicleIds)},
${EXPECTED_POINTS_CTE},
pairs (vehicle_id, previous_date, d) AS (VALUES ${values})
SELECT pr.vehicle_id::text    AS vehicle_id,
       pr.previous_date::text AS previous_date,
       pr.d::text             AS d
  FROM pairs pr
 WHERE ${counterPairBrokenSql(counter, {
   vehicle: sql`pr.vehicle_id`,
   previousDate: sql`pr.previous_date`,
   date: sql`pr.d`,
 })}`);
  for (const row of result.rows) {
    broken.add(
      counterPairKey({ vehicleId: row.vehicle_id, previousDate: row.previous_date, date: row.d }),
    );
  }
  return broken;
}
