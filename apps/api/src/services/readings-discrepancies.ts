import { asc, eq, inArray } from 'drizzle-orm';
import {
  discrepancyKindLabels,
  formatVehicleRouteNumber,
  waybillDisplayNumber,
  type DiscrepancyKind,
  type ReadingSourceKind,
  type ReportDiscrepancyDto,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  driverReportDiscrepancyResolutions,
  vehicleRoutes,
  waybills,
  waybillSeries,
  type DriverDailyReportItemRow,
} from '../db/schema';
import { sha256hex } from '../lib/crypto';
import type { SourceRef, Tx } from './readings-chain';

/**
 * The discrepancy rule of the readings module (ADR 0103, Р21): how a report item's snapshot is
 * compared with its live source, and whether a dispatcher's decision still resolves the difference.
 *
 * It lives apart from the report service because it has two readers: the report itself (reading,
 * acceptance and the resolution door) and the request shift table, which decides by it whether a
 * driver's reading is the request day's work (readings-shifts-merge plan §6.1). A second copy of
 * "is this item still its source" in the shift reader would drift from the garage silently, and
 * the site would sign a day the dispatcher sees as broken, or the other way round.
 */

/** Readers that need no lock: the shift table reads with the pool, the report under its locks. */
export type ReadingsReader = Tx | typeof db;

// ── Live sources (Р16, Р21) ──

/**
 * A source as the module sees it: what the item's snapshot is compared with. The fields are
 * generic on purpose — a discrepancy is computed the same way for a route and a waybill, and two
 * branches per comparison would drift at the first edit.
 */
export interface LiveSource {
  ref: SourceRef;
  label: string;
  /** Key of the initial shift numbering (Р15): compared as a string, ordered by the number. */
  orderKey: string;
  vehicleId: string;
  personId: string | null;
  /** Day of a route; `null` for a weekly waybill, whose time is its period. */
  date: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  /** The route exists, the waybill is not cancelled. */
  active: boolean;
}

export function sourceKey(ref: SourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** The number in a sort key is zero-padded: otherwise «Р-10» would sort before «Р-9». */
function orderKeyOf(group: string, num: number): string {
  return `${group}|${String(num).padStart(12, '0')}`;
}

export function itemRef(
  item: Pick<DriverDailyReportItemRow, 'sourceKind' | 'routeId' | 'waybillId'>,
): SourceRef {
  return item.sourceKind === 'route'
    ? { kind: 'route', id: item.routeId! }
    : { kind: 'esm2', id: item.waybillId! };
}

/** Whether the source covers the item's day: a route by its date, a waybill by its period. */
export function sourceCoversDate(source: LiveSource, date: string): boolean {
  if (source.date !== null) return source.date === date;
  if (source.periodFrom === null || source.periodTo === null) return false;
  return source.periodFrom <= date && date <= source.periodTo;
}

/**
 * The day an item moves to after its source: a route's own date; a weekly waybill has no day of its
 * own — its time is a period — and the item stays in the report's day.
 *
 * Written once for both the rebase itself (`rebaseItem`) and its prediction in a discrepancy: were
 * they to differ, the portal would name one day to the person and the server would move the item
 * to another, silently and with no red check.
 */
export function rebaseDateOf(source: LiveSource, itemDate: string): string {
  return source.date ?? itemDate;
}

export async function loadLiveSources(
  reader: ReadingsReader,
  refs: readonly SourceRef[],
): Promise<Map<string, LiveSource>> {
  const routeIds = [...new Set(refs.filter((r) => r.kind === 'route').map((r) => r.id))];
  const waybillIds = [...new Set(refs.filter((r) => r.kind === 'esm2').map((r) => r.id))];
  const live = new Map<string, LiveSource>();

  if (routeIds.length > 0) {
    const rows = await reader
      .select({
        id: vehicleRoutes.id,
        num: vehicleRoutes.num,
        vehicleId: vehicleRoutes.vehicleId,
        routeDate: vehicleRoutes.routeDate,
        driverPersonId: vehicleRoutes.driverPersonId,
      })
      .from(vehicleRoutes)
      .where(inArray(vehicleRoutes.id, routeIds));
    for (const row of rows) {
      const ref: SourceRef = { kind: 'route', id: row.id };
      live.set(sourceKey(ref), {
        ref,
        label: formatVehicleRouteNumber(row.num),
        orderKey: orderKeyOf('', row.num),
        vehicleId: row.vehicleId,
        personId: row.driverPersonId,
        date: row.routeDate,
        periodFrom: null,
        periodTo: null,
        // A deleted route has no row at all: the item holds it by `RESTRICT`, and "deleted" is
        // known by absence, not by a column.
        active: true,
      });
    }
  }

  if (waybillIds.length > 0) {
    const rows = await reader
      .select({
        id: waybills.id,
        number: waybills.number,
        formCode: waybills.formCode,
        status: waybills.status,
        vehicleId: waybills.vehicleId,
        driverPersonId: waybills.driverPersonId,
        periodFrom: waybills.periodFrom,
        periodTo: waybills.periodTo,
        seriesId: waybills.seriesId,
        prefix: waybillSeries.prefix,
        numberWidth: waybillSeries.numberWidth,
      })
      .from(waybills)
      .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
      .where(inArray(waybills.id, waybillIds));
    for (const row of rows) {
      // The canonical source (Р16): a 4-П or a form No. 3 has `route_id`, and its trip is already
      // represented by the route. Such a waybill is never a readings source — otherwise one trip
      // would get two cards in the form and two points in the chain.
      if (row.formCode !== 'esm2') continue;
      const ref: SourceRef = { kind: 'esm2', id: row.id };
      live.set(sourceKey(ref), {
        ref,
        label: `ЭСМ-2 № ${waybillDisplayNumber(row.prefix, row.number, row.numberWidth)}`,
        // Keyed by the series and number, not the label: a blank number is unique only in a series.
        orderKey: orderKeyOf(row.seriesId, row.number),
        vehicleId: row.vehicleId,
        personId: row.driverPersonId,
        date: null,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        active: row.status !== 'cancelled',
      });
    }
  }
  return live;
}

// ── Discrepancies (Р21) ──

/**
 * Discrepancies are not stored — decisions about them are. The live source is compared with the
 * snapshot on every read, and the decision journal answers only "is this resolution still valid".
 *
 * The fingerprint carries the algorithm version (`v1:`): the canonical form will change one day,
 * and without a version that would silently void every earlier decision. The separator is a
 * control character absent from IDs and dates: joined by an empty string, two different pairs of
 * values could give one hash, and a decision on one discrepancy would apply to another.
 */
function discrepancyFingerprint(
  kind: DiscrepancyKind,
  subject: string,
  parts: (string | null)[],
): string {
  return `v1:${sha256hex([kind, subject, ...parts.map((p) => p ?? '')].join('\u0001'))}`;
}

function discrepancySubject(d: {
  kind: DiscrepancyKind;
  itemId: string | null;
  sourceKind: ReadingSourceKind | null;
  sourceId: string | null;
}): string {
  return d.kind === 'missing_source' ? `${d.sourceKind}:${d.sourceId}` : `item:${d.itemId}`;
}

/** The worker and day an item would move to: the target report's key, even if it does not exist. */
export interface TargetRef {
  personId: string;
  date: string;
}

/** A discrepancy as found, before the decision journal and the rebase target are read. */
export type FoundDiscrepancy = Omit<
  ReportDiscrepancyDto,
  'resolved' | 'resolvedReason' | 'target'
> & {
  /** Where the item would move by a rebase; `null` for the kinds with nothing to move. */
  targetRef: TargetRef | null;
};

/** What the rule reads of an item: its snapshot of the source, vehicle and day. */
export type DiscrepancyItem = Pick<
  DriverDailyReportItemRow,
  'id' | 'sourceKind' | 'routeId' | 'waybillId' | 'vehicleId' | 'reportDate'
>;

/**
 * Every discrepancy of one report: the items against their live sources (`driver`, `vehicle`,
 * `date`, `source_state`) and the day's sources missing from it (`missing_source`). Pure: the live
 * sources are read by the caller, once for all the reports it looks at.
 *
 * `dayRefs` are the day's assignment entries; a reader that asks only about existing items (the
 * request shift table) passes none — a missing source never applies to an item that exists.
 */
export function findDiscrepancies(
  report: { personId: string },
  items: readonly DiscrepancyItem[],
  dayRefs: readonly SourceRef[],
  live: ReadonlyMap<string, LiveSource>,
): FoundDiscrepancy[] {
  const found: FoundDiscrepancy[] = [];

  for (const item of items) {
    const ref = itemRef(item);
    const source = live.get(sourceKey(ref));
    const label = source?.label ?? sourceKey(ref);
    if (!source || !source.active) {
      found.push({
        kind: 'source_state',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('source_state', `item:${item.id}`, [
          source ? 'cancelled' : 'deleted',
        ]),
        message: `${label}: ${discrepancyKindLabels.source_state}`,
        // No source, or a cancelled one: there is nothing to align the snapshot with.
        targetRef: null,
      });
      continue;
    }
    // The three movable kinds share one target — the one `rebaseItem` itself would choose: the
    // worker and day of the live source. A source without a worker has nowhere to move.
    const targetRef: TargetRef | null =
      source.personId === null
        ? null
        : { personId: source.personId, date: rebaseDateOf(source, item.reportDate) };
    if (source.personId !== report.personId) {
      found.push({
        kind: 'driver',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('driver', `item:${item.id}`, [
          source.personId,
          report.personId,
        ]),
        message: `${label}: ${discrepancyKindLabels.driver}`,
        targetRef,
      });
    }
    if (source.vehicleId !== item.vehicleId) {
      found.push({
        kind: 'vehicle',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('vehicle', `item:${item.id}`, [
          source.vehicleId,
          item.vehicleId,
        ]),
        message: `${label}: ${discrepancyKindLabels.vehicle}`,
        targetRef,
      });
    }
    if (!sourceCoversDate(source, item.reportDate)) {
      found.push({
        kind: 'date',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('date', `item:${item.id}`, [
          source.date,
          source.periodFrom,
          source.periodTo,
          item.reportDate,
        ]),
        message: `${label}: ${discrepancyKindLabels.date}`,
        targetRef,
      });
    }
  }

  // The day's composition: a source missing from the report. The fingerprint takes the whole
  // source — worker, vehicle, date (a period for a waybill) and state: a source "decided not to be
  // included" is another source after its vehicle or worker changes, and the old decision does not
  // apply to it.
  const present = new Set(items.map((i) => sourceKey(itemRef(i))));
  for (const ref of dayRefs) {
    const key = sourceKey(ref);
    if (present.has(key)) continue;
    const source = live.get(key);
    if (!source || !source.active) continue;
    found.push({
      kind: 'missing_source',
      itemId: null,
      sourceKind: ref.kind,
      sourceId: ref.id,
      fingerprint: discrepancyFingerprint('missing_source', key, [
        source.personId,
        source.vehicleId,
        source.date,
        source.periodFrom,
        source.periodTo,
        source.active ? 'active' : 'inactive',
      ]),
      message: `${source.label}: ${discrepancyKindLabels.missing_source}`,
      // A missing source has no item at all: a resolution adds one ("add the source"), not a
      // rebase.
      targetRef: null,
    });
  }
  return found;
}

/** The decision in force for each subject of one report. */
export type DiscrepancyDecisions = Map<
  string,
  { fingerprint: string; resolution: string; reason: string }
>;

/**
 * The decision in force for each subject, per report. The last one by `report_version_after`, not
 * by time: every journal write takes the report `FOR UPDATE` and moves its version, so the version
 * strictly grows and gives the causal order. `now()` would not do — in PostgreSQL it is the start
 * of the transaction, and two writes started at once would get one mark.
 */
export async function loadDecisions(
  reader: ReadingsReader,
  reportIds: readonly string[],
): Promise<Map<string, DiscrepancyDecisions>> {
  const byReport = new Map<string, DiscrepancyDecisions>();
  const ids = [...new Set(reportIds)];
  if (ids.length === 0) return byReport;
  const rows = await reader
    .select()
    .from(driverReportDiscrepancyResolutions)
    .where(inArray(driverReportDiscrepancyResolutions.reportId, ids))
    .orderBy(asc(driverReportDiscrepancyResolutions.reportVersionAfter));
  for (const row of rows) {
    const subject =
      row.kind === 'missing_source'
        ? `${row.routeId ? 'route' : 'esm2'}:${row.routeId ?? row.waybillId}`
        : `item:${row.itemId}`;
    let last = byReport.get(row.reportId);
    if (!last) byReport.set(row.reportId, (last = new Map()));
    last.set(`${row.kind}|${subject}`, {
      fingerprint: row.fingerprint,
      resolution: row.resolution,
      reason: row.reason,
    });
  }
  return byReport;
}

/**
 * Whether a found discrepancy is resolved: the LAST journal event about its subject has the same
 * fingerprint and a resolving outcome. `revoked` exists for this rule: there is no other way to
 * cancel a decision while the fingerprint stays the same.
 */
export function resolutionOf(
  d: FoundDiscrepancy,
  decisions: DiscrepancyDecisions | undefined,
): { resolved: boolean; resolvedReason: string } {
  const last = decisions?.get(`${d.kind}|${discrepancySubject(d)}`);
  const resolved =
    last !== undefined && last.fingerprint === d.fingerprint && last.resolution !== 'revoked';
  return { resolved, resolvedReason: resolved ? last.reason : '' };
}
