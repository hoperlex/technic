import { randomUUID } from 'node:crypto';
import type { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  canCancelWaybill,
  correctionFloorDateKey,
  moscowDateKeyOf,
  shiftDateKey,
  waybillDisplayNumber,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import * as schema from '../src/db/schema';
import { requestIsLinearSql } from '../src/db/linear-mode';
import { ensureAssignmentHistory } from '../src/services/assignment-ensure';
import { assignmentStateOn, type AssignmentRange } from '../src/services/assignment-history';
import { requireOpenDoor } from '../src/services/assignment-mode';
import {
  readAssignmentChanges,
  type AssignmentChangeRecord,
} from '../src/services/assignment-write';
// Types only: the module itself is loaded by name when a cure is written (see CORRECTION_MODULE).
import type * as CorrectionJournal from '../src/services/waybill-correction';

/**
 * Traces the repair door left on production before its defects were fixed — the report sections
 * and the healing of `assignment-drift` (ADR 0212, amendment of 29.09.2026).
 *
 * WHY A SEPARATE LIST NEXT TO THE DRIFT VERDICT. The drift verdict compares history with the
 * active paper and trusts the paper. Every trace below is a case where that trust is misplaced
 * because the paper itself was minted by a defective history command:
 *
 * - `leak` (defect D3) — a known fill addressed up to the last locked day wrote no
 *   `unknown_remainder`, so its `set` runs on into the mutable days; in `history` the command then
 *   printed blanks for those days. History and those blanks agree, so the drift verdict calls the
 *   request clean — and `--apply` on a neighbouring drift would spread the leaked person further;
 * - `cancelled_fill` (D4) — `cancel_fill` extinguished the fill but left its blanks active:
 *   history says «unknown», the paper keeps naming the person nobody vouches for any more;
 * - `orphan` (D5) — a fill burned (or trimmed) a sheet and issued nothing in its place: days of a
 *   worked week are left without a blank;
 * - `archived_repair` (D2) — a repair of an archived request without `restore` minted or burned
 *   blanks of a request nobody sees;
 * - `incidental_sheet` — the repair's executable paper plan ran without a scope, so any repair in
 *   `history` also printed blanks for days its command never touched: past days without a blank
 *   whose person history happened to know (against section 13 of the periods plan). The blank
 *   agrees with history, which is exactly why the drift verdict cannot see it.
 *
 * The drift repair is never applied to a request with any of these (the user's decision of
 * 29.09.2026): following the paper there would launder the defect into history.
 *
 * WHAT IS HEALED AND WHAT IS ONLY REPORTED. Two traces have an unambiguous cure, and the command
 * applies it on request:
 *
 * - `leak`: the missing `unknown_remainder` is returned on `fill.to + 1` into the fill's own group
 *   (so a later `cancel_fill` still finds a well-formed group), and the blanks the leaking
 *   operation issued for the leaked days are cancelled through the correction journal. The request
 *   then asks for an anchor — the second operation the fixed door asks for as well;
 * - `cancelled_fill`: the active blanks the cancelled fill issued are cancelled through the journal.
 *
 * Orphans, archived repairs and incidental blanks are reported with a hint for a dispatcher: the
 * cure there is a decision about people (who worked the orphaned days), about the archive, or about
 * whether a blank nobody asked for should stay in circulation — not a mechanical write. Anything
 * ambiguous — several fills in one operation, a blank straddling filled and leaked
 * days, a worked or signed blank, overlaps with another fill — stays in the report with its reason.
 *
 * WHY NOTHING HERE TRUSTS THE REPORT. The same `inspectTraces` runs in the dry run and inside the
 * healing transaction, under the request lock; the cure applied is recomputed there, never carried
 * over from what was printed.
 */

type Handle = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Handle['transaction']>[0]>[0];

/** The fix kinds `--fix` names; `drift` is the ADR 0212 repair itself. */
export const DRIFT_FIXES = ['drift', 'leak', 'fill-paper'] as const;
export type DriftFix = (typeof DRIFT_FIXES)[number];

export type TraceKind =
  'leak' | 'cancelled_fill' | 'orphan' | 'archived_repair' | 'incidental_sheet';

/** Door name in the journal fingerprint target: keeps these operations apart from the doors'. */
const JOURNAL_DOOR = 'assignment-drift';
export const HEAL_AUDIT_ACTION = 'assignment.drift_heal';

/** A sheet as the report names it: the printed number and what is printed on it. */
export interface TraceSheet {
  id: string;
  number: string;
  status: string;
  from: string;
  to: string;
  vehicleId: string;
  driverPersonId: string | null;
}

/** A journal operation of the repair door that wrote a fill, as the report names it. */
export interface TraceOperation {
  id: string;
  operationId: string;
  /** Moscow calendar day the operation ran — the day its "forward" paper is measured from. */
  day: string;
  /** Read mode at the moment of the operation: paper follows history only in `history`. */
  readMode: string;
}

export interface KnownFillSummary {
  from: string;
  to: string;
  personId: string;
}

export interface LeakTrace {
  kind: 'leak';
  requestId: string;
  operation: TraceOperation;
  fill: KnownFillSummary;
  changeGroupId: string;
  /** `fill.to + 1`: where the missing `unknown_remainder` belongs. */
  day: string;
  /** Last day the leaked `set` still governs: the next machinist row, or the end of the term. */
  through: string;
  /** Readiness the operation reported: `materialized → ready` with fills only is the telltale. */
  stateBefore: string | null;
  stateAfter: string | null;
  /** Active blanks the leaking operation issued for the leaked days — cancelled by the cure. */
  forward: TraceSheet[];
  /** Other active blanks on the leaked days: kept, the anchor's paper plan decides them later. */
  others: TraceSheet[];
  /** Why the cure is withheld; empty — the cure is unambiguous. */
  manual: string[];
}

export interface CancelledFillTrace {
  kind: 'cancelled_fill';
  requestId: string;
  operation: TraceOperation;
  fill: KnownFillSummary;
  changeGroupId: string;
  /** Each blank is its own unit: cancelling one does not depend on another. */
  sheets: { sheet: TraceSheet; manual: string | null }[];
}

export interface OrphanTrace {
  kind: 'orphan';
  requestId: string;
  operation: TraceOperation;
  fill: KnownFillSummary | null;
  sheet: TraceSheet;
  how: 'burned' | 'trimmed';
  /** Days of the lost period no active blank covers, split by whether they are still mutable. */
  uncovered: (AssignmentRange & { locked: boolean })[];
}

export interface ArchivedRepairTrace {
  kind: 'archived_repair';
  requestId: string;
  operation: TraceOperation;
  issued: TraceSheet[];
  burned: TraceSheet[];
  trimmed: TraceSheet[];
}

export interface IncidentalSheetTrace {
  kind: 'incidental_sheet';
  requestId: string;
  operation: TraceOperation;
  sheet: TraceSheet;
  /** Days of the blank outside the days the command changed (its own `paperScope`). */
  outside: AssignmentRange[];
}

export interface RequestTraces {
  requestId: string;
  num: number;
  archived: boolean;
  status: string;
  leaks: LeakTrace[];
  cancelledFills: CancelledFillTrace[];
  orphans: OrphanTrace[];
  archivedRepairs: ArchivedRepairTrace[];
  incidentalSheets: IncidentalSheetTrace[];
}

/** Which trace kinds a request carries — the drift repair is withheld when this is non-empty. */
export function traceKindsOf(traces: RequestTraces): TraceKind[] {
  const kinds: TraceKind[] = [];
  if (traces.leaks.length > 0) kinds.push('leak');
  // A cancelled fill whose blanks are all consistent with today's history leaves no trace; only
  // the sheets listed here are ones history no longer vouches for.
  if (traces.cancelledFills.some((trace) => trace.sheets.length > 0)) kinds.push('cancelled_fill');
  if (traces.orphans.length > 0) kinds.push('orphan');
  if (traces.archivedRepairs.length > 0) kinds.push('archived_repair');
  if (traces.incidentalSheets.length > 0) kinds.push('incidental_sheet');
  return kinds;
}

// ── Listing ──

/**
 * Requests that may carry a trace: every request that ever had a known fill, every request
 * repaired while archived, and every request with an active blank minted by a repair operation.
 * The first two markers are permanent (history rows are never deleted, audit rows neither), so a
 * trace cannot hide from this list by having been superseded; the third is the trace itself.
 */
export async function listTraceCandidates(
  db: Handle | Tx,
  params: { nums?: readonly number[] } = {},
): Promise<{ id: string; num: number }[]> {
  const rows = await db.execute<{ id: string; num: number }>(sql`
    SELECT r.id, r.num
      FROM vehicle_requests r
     WHERE r.request_type = 'special_equipment'
       AND (EXISTS (SELECT 1 FROM vehicle_request_assignment_changes c
                     WHERE c.request_id = r.id AND c.origin = 'known_fill')
            OR EXISTS (SELECT 1 FROM audit_log a
                        WHERE a.entity_type = 'vehicle_request' AND a.entity_id = r.id::text
                          AND a.action = 'vehicle_request.assignment_repair'
                          AND a.metadata->>'archived' = 'true')
            OR EXISTS (SELECT 1 FROM waybills w
                         JOIN waybill_corrections c ON c.id = w.correction_id
                        WHERE w.source_request_id = r.id AND w.status <> 'cancelled'
                          AND c.payload -> 'repair' IS NOT NULL))
       ${
         params.nums && params.nums.length > 0
           ? sql`AND r.num IN (${sql.join(
               params.nums.map((n) => sql`${n}`),
               sql`, `,
             )})`
           : sql``
       }
     ORDER BY r.num`);
  return rows.rows.map((row) => ({ id: row.id, num: Number(row.num) }));
}

// ── Reading ──

interface SheetRow extends TraceSheet {
  issuedForDate: string;
  periodToOriginal: string | null;
  correctionId: string | null;
  cancelCorrectionId: string | null;
  periodTrimCorrectionId: string | null;
}

interface OperationRow {
  id: string;
  operationId: string;
  createdAt: Date;
  payload: unknown;
}

interface Head {
  num: number;
  status: string;
  archived: boolean;
  isLinear: boolean;
  dateFrom: string | null;
  dateTo: string | null;
}

async function readHead(tx: Tx, requestId: string): Promise<Head | null> {
  const [row] = await tx
    .select({
      num: schema.vehicleRequests.num,
      status: schema.vehicleRequests.status,
      deletedAt: schema.vehicleRequests.deletedAt,
      isLinear: requestIsLinearSql(
        schema.vehicleRequests.isLinearFrozen,
        schema.vehicleTypes.isLinear,
      ),
      dateFrom: schema.specialEquipmentRequestDetails.dateFrom,
      dateTo: schema.specialEquipmentRequestDetails.dateTo,
    })
    .from(schema.vehicleRequests)
    .innerJoin(
      schema.vehicleTypes,
      eq(schema.vehicleTypes.id, schema.vehicleRequests.vehicleTypeId),
    )
    .leftJoin(
      schema.specialEquipmentRequestDetails,
      eq(schema.specialEquipmentRequestDetails.requestId, schema.vehicleRequests.id),
    )
    .where(eq(schema.vehicleRequests.id, requestId));
  if (!row) return null;
  return {
    num: Number(row.num),
    status: row.status,
    archived: row.deletedAt !== null,
    isLinear: row.isLinear,
    dateFrom: row.dateFrom,
    dateTo: row.dateTo,
  };
}

async function readSheets(tx: Tx, requestId: string): Promise<SheetRow[]> {
  const rows = await tx
    .select({
      id: schema.waybills.id,
      status: schema.waybills.status,
      periodFrom: schema.waybills.periodFrom,
      periodTo: schema.waybills.periodTo,
      periodToOriginal: schema.waybills.periodToOriginal,
      issuedForDate: schema.waybills.issuedForDate,
      vehicleId: schema.waybills.vehicleId,
      driverPersonId: schema.waybills.driverPersonId,
      correctionId: schema.waybills.correctionId,
      cancelCorrectionId: schema.waybills.cancelCorrectionId,
      periodTrimCorrectionId: schema.waybills.periodTrimCorrectionId,
      number: schema.waybills.number,
      prefix: schema.waybillSeries.prefix,
      numberWidth: schema.waybillSeries.numberWidth,
    })
    .from(schema.waybills)
    .innerJoin(schema.waybillSeries, eq(schema.waybillSeries.id, schema.waybills.seriesId))
    .where(
      and(eq(schema.waybills.sourceRequestId, requestId), isNotNull(schema.waybills.periodFrom)),
    )
    .orderBy(asc(schema.waybills.periodFrom), asc(schema.waybills.id));
  return rows.map((row) => ({
    id: row.id,
    number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
    status: row.status,
    from: row.periodFrom!,
    to: row.periodTo!,
    vehicleId: row.vehicleId,
    driverPersonId: row.driverPersonId,
    issuedForDate: row.issuedForDate,
    periodToOriginal: row.periodToOriginal,
    correctionId: row.correctionId,
    cancelCorrectionId: row.cancelCorrectionId,
    periodTrimCorrectionId: row.periodTrimCorrectionId,
  }));
}

/**
 * Blanks that have been used since they were printed: a reading submitted against them, a scan of
 * the returned form, or an hour signed on one of their days. Cancelling such a blank rewrites a
 * document somebody already acted on, and that is not a mechanical decision.
 */
async function readUsedSheets(
  tx: Tx,
  requestId: string,
  sheets: readonly SheetRow[],
): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  const ids = sheets.filter((sheet) => sheet.status !== 'cancelled').map((sheet) => sheet.id);
  if (ids.length === 0) return used;
  const readings = await tx
    .selectDistinct({ id: schema.driverDailyReportItems.waybillId })
    .from(schema.driverDailyReportItems)
    .innerJoin(
      schema.vehicleReadings,
      eq(schema.vehicleReadings.itemId, schema.driverDailyReportItems.id),
    )
    .where(inArray(schema.driverDailyReportItems.waybillId, ids));
  for (const row of readings) if (row.id) used.set(row.id, 'по листу сданы показания');
  const files = await tx
    .selectDistinct({ id: schema.waybillFiles.waybillId })
    .from(schema.waybillFiles)
    .where(inArray(schema.waybillFiles.waybillId, ids));
  for (const row of files) if (!used.has(row.id)) used.set(row.id, 'к листу приложен скан');
  const signed = await tx
    .select({ day: schema.vehicleRequestShifts.shiftDate })
    .from(schema.vehicleRequestShifts)
    .where(
      and(
        eq(schema.vehicleRequestShifts.requestId, requestId),
        isNotNull(schema.vehicleRequestShifts.approvedAt),
      ),
    );
  for (const sheet of sheets) {
    if (used.has(sheet.id) || sheet.status === 'cancelled') continue;
    const day = signed.find((row) => row.day >= sheet.from && row.day <= sheet.to)?.day;
    if (day) used.set(sheet.id, `смена ${day} по листу подписана`);
  }
  return used;
}

async function readOperations(tx: Tx, ids: readonly string[]): Promise<Map<string, OperationRow>> {
  const out = new Map<string, OperationRow>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      id: schema.waybillCorrections.id,
      operationId: schema.waybillCorrections.operationId,
      createdAt: schema.waybillCorrections.createdAt,
      payload: schema.waybillCorrections.payload,
    })
    .from(schema.waybillCorrections)
    .where(inArray(schema.waybillCorrections.id, [...ids]));
  for (const row of rows) out.set(row.id, row);
  return out;
}

/**
 * Repair operations run on an archived request without `restore` (D2). The audit event is the only
 * place that remembers the request was archived at the time; it is written in the operation's
 * transaction, so its `created_at` (the transaction start, `now()`) equals the journal row's and
 * joins them exactly.
 */
async function readArchivedRepairs(tx: Tx, requestId: string): Promise<OperationRow[]> {
  const rows = await tx.execute<{
    id: string;
    operation_id: string;
    created_ms: string | number;
    payload: unknown;
  }>(sql`
    SELECT DISTINCT ON (c.id) c.id, c.operation_id,
           (extract(epoch FROM c.created_at) * 1000)::float8 AS created_ms, c.payload
      FROM audit_log a
      JOIN waybill_corrections c
        ON c.created_at = a.created_at AND c.payload -> 'repair' IS NOT NULL
      JOIN vehicle_request_corrections l
        ON l.correction_id = c.id AND l.request_id = ${requestId}::uuid
     WHERE a.entity_type = 'vehicle_request' AND a.entity_id = ${requestId}::text
       AND a.action = 'vehicle_request.assignment_repair'
       AND a.metadata->>'archived' = 'true'
       AND coalesce(c.payload->>'restore', 'false') <> 'true'
     ORDER BY c.id`);
  // `execute` returns timestamps as text in a server-dependent format; epoch milliseconds are
  // unambiguous and give every operation a real Date.
  return rows.rows.map((row) => ({
    id: row.id,
    operationId: row.operation_id,
    createdAt: new Date(Number(row.created_ms)),
    payload: row.payload,
  }));
}

async function readModeTransitions(tx: Tx): Promise<{ at: Date; toReadMode: string }[]> {
  return tx
    .select({
      at: schema.assignmentPeriodsModeTransitions.at,
      toReadMode: schema.assignmentPeriodsModeTransitions.toReadMode,
    })
    .from(schema.assignmentPeriodsModeTransitions)
    .orderBy(asc(schema.assignmentPeriodsModeTransitions.at));
}

// ── Payload of a repair operation ──

interface RepairSummary {
  fills: KnownFillSummary[];
  anchors: number;
  stateBefore: string | null;
  stateAfter: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The operation's own record of what it filled. Parsed defensively: the snapshot is written once
 * and read months later, and a shape this command does not recognise must turn into "not decided"
 * rather than into a guess about which days the fill covered.
 */
function repairSummaryOf(payload: unknown): RepairSummary | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const repair = record.repair as Record<string, unknown> | undefined;
  if (!repair || !Array.isArray(repair.fills)) return null;
  const fills: KnownFillSummary[] = [];
  for (const item of repair.fills as unknown[]) {
    const fill = item as Record<string, unknown>;
    if (
      typeof fill.from !== 'string' ||
      typeof fill.to !== 'string' ||
      typeof fill.personId !== 'string' ||
      !DATE_RE.test(fill.from) ||
      !DATE_RE.test(fill.to)
    ) {
      return null;
    }
    fills.push({ from: fill.from, to: fill.to, personId: fill.personId });
  }
  return {
    fills,
    anchors: Array.isArray(repair.anchors) ? repair.anchors.length : 0,
    stateBefore: typeof record.stateBefore === 'string' ? record.stateBefore : null,
    stateAfter: typeof record.stateAfter === 'string' ? record.stateAfter : null,
  };
}

const isRange = (value: unknown): value is AssignmentRange => {
  const range = value as Record<string, unknown> | null;
  return (
    typeof range?.from === 'string' &&
    typeof range.to === 'string' &&
    DATE_RE.test(range.from) &&
    DATE_RE.test(range.to)
  );
};

/**
 * The days a repair operation's command changed, as the door itself recorded them: its
 * `paperRange` (logical days of every mutation) and `paperScope` (those days closed over whole
 * documents). Taken from the snapshot rather than re-derived from `payload.repair`: the door
 * computed them from history as it stood before the command — an anchor's range ends at the next
 * machinist row of that moment, a leaking fill's runs to its end — and today's history can no
 * longer tell. `null` — not a repair operation, or a snapshot this command does not recognise.
 */
function commandScopeOf(payload: unknown): AssignmentRange[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.repair !== 'object' || record.repair === null) return null;
  const effects = record.effects as Record<string, unknown> | undefined;
  const scope = effects?.paperScope;
  const range = effects?.paperRange;
  if (!Array.isArray(scope) || !Array.isArray(range)) return null;
  const all = [...(scope as unknown[]), ...(range as unknown[])];
  return all.every(isRange) ? all : null;
}

// ── Inspection ──

function publicSheet(sheet: SheetRow): TraceSheet {
  return {
    id: sheet.id,
    number: sheet.number,
    status: sheet.status,
    from: sheet.from,
    to: sheet.to,
    vehicleId: sheet.vehicleId,
    driverPersonId: sheet.driverPersonId,
  };
}

function subtract(ranges: AssignmentRange[], cut: AssignmentRange): AssignmentRange[] {
  return ranges.flatMap((range) => {
    if (cut.to < range.from || cut.from > range.to) return [range];
    const out: AssignmentRange[] = [];
    if (range.from < cut.from) out.push({ from: range.from, to: shiftDateKey(cut.from, -1) });
    if (range.to > cut.to) out.push({ from: shiftDateKey(cut.to, 1), to: range.to });
    return out;
  });
}

function clip(range: AssignmentRange, frame: AssignmentRange): AssignmentRange | null {
  const from = range.from > frame.from ? range.from : frame.from;
  const to = range.to < frame.to ? range.to : frame.to;
  return from <= to ? { from, to } : null;
}

/**
 * Every trace of one request, each classified as curable or not — reads only.
 *
 * Runs under the request lock inside the healing transaction and in a read-only transaction for the
 * report; both get the same answer from the same state.
 */
export async function inspectTraces(
  tx: Tx,
  requestId: string,
  asOf: string,
): Promise<RequestTraces> {
  const head = await readHead(tx, requestId);
  const empty: RequestTraces = {
    requestId,
    num: head?.num ?? 0,
    archived: head?.archived ?? false,
    status: head?.status ?? '',
    leaks: [],
    cancelledFills: [],
    orphans: [],
    archivedRepairs: [],
    incidentalSheets: [],
  };
  // Linear requests keep no machinist in history (ADR 0100 §6): fills do not exist there.
  if (!head || head.isLinear || head.dateFrom === null) return empty;
  const term: AssignmentRange = { from: head.dateFrom, to: head.dateTo || head.dateFrom };

  const rows = await readAssignmentChanges(tx, requestId);
  const actual = rows.filter((row) => row.supersededAt === null);
  const fillRows = rows.filter((row) => row.origin === 'known_fill' && row.correctionId);
  const archivedOps = await readArchivedRepairs(tx, requestId);
  const sheets = await readSheets(tx, requestId);
  const active = sheets.filter((sheet) => sheet.status !== 'cancelled');
  const minting = active.flatMap((sheet) => (sheet.correctionId ? [sheet.correctionId] : []));
  if (fillRows.length === 0 && archivedOps.length === 0 && minting.length === 0) return empty;

  const used = await readUsedSheets(tx, requestId, sheets);
  const operations = await readOperations(tx, [
    ...new Set([...fillRows.map((row) => row.correctionId!), ...minting]),
  ]);
  const transitions = await readModeTransitions(tx);
  const opRef = (op: OperationRow): TraceOperation => ({
    id: op.id,
    operationId: op.operationId,
    day: moscowDateKeyOf(op.createdAt),
    readMode:
      [...transitions].reverse().find((t) => t.at.getTime() <= op.createdAt.getTime())
        ?.toReadMode ?? 'legacy',
  });
  // Request-wide reasons: the command writes only where a door would, and neither the archive nor a
  // request out of work is a door's territory (the archive is decided with `restore`, by a human).
  const requestManual: string[] = [];
  if (head.archived) requestManual.push('заявка в архиве — решается восстановлением, вручную');
  if (head.status !== 'confirmed' && head.status !== 'done') {
    requestManual.push(`заявка не в работе (статус ${head.status})`);
  }

  const traces: RequestTraces = { ...empty };
  const seenOrphans = new Set<string>();

  for (const row of fillRows) {
    const op = operations.get(row.correctionId!);
    if (!op) continue;
    const summary = repairSummaryOf(op.payload);
    const fill =
      summary?.fills.find(
        (candidate) =>
          candidate.from === row.effectiveDate && candidate.personId === row.driverPersonId,
      ) ?? null;
    const opManual: string[] = [];
    if (summary && summary.fills.length > 1) {
      opManual.push(`операция заполнила ${summary.fills.length} отрезка сразу`);
    }
    if (summary && summary.anchors > 0) {
      opManual.push('та же операция назначала машиниста якорем — её бланки не разделить');
    }

    // D5 first: it depends on the operation only, not on what became of its fill row.
    for (const sheet of sheets) {
      const how =
        sheet.cancelCorrectionId === op.id
          ? ('burned' as const)
          : sheet.periodTrimCorrectionId === op.id && sheet.periodToOriginal
            ? ('trimmed' as const)
            : null;
      if (!how || seenOrphans.has(`${sheet.id}:${op.id}`)) continue;
      const lost =
        how === 'burned'
          ? { from: sheet.from, to: sheet.to }
          : { from: shiftDateKey(sheet.to, 1), to: sheet.periodToOriginal! };
      const inTerm = clip(lost, term);
      if (!inTerm) continue;
      let uncovered: AssignmentRange[] = [inTerm];
      for (const other of active)
        uncovered = subtract(uncovered, { from: other.from, to: other.to });
      if (uncovered.length === 0) continue;
      seenOrphans.add(`${sheet.id}:${op.id}`);
      traces.orphans.push({
        kind: 'orphan',
        requestId,
        operation: opRef(op),
        fill,
        sheet: publicSheet(sheet),
        how,
        uncovered: uncovered.flatMap((range) => splitByToday(range, asOf)),
      });
    }

    if (!fill) continue;
    if (row.supersededAt === null) {
      const leak = leakOf({
        row,
        op,
        fill,
        summary: summary!,
        rows,
        actual,
        term,
        active,
        asOf,
        used,
      });
      if (leak) {
        traces.leaks.push({
          ...leak,
          requestId,
          operation: opRef(op),
          manual: [...requestManual, ...opManual, ...leak.manual],
        });
      }
      continue;
    }
    if (row.supersededKind !== 'cancelled') continue;
    const cancelled = cancelledFillOf({ row, op, fill, actual, term, active, used });
    if (cancelled.length > 0) {
      const shared = [...requestManual, ...opManual];
      traces.cancelledFills.push({
        kind: 'cancelled_fill',
        requestId,
        operation: opRef(op),
        fill,
        changeGroupId: row.changeGroupId,
        sheets: cancelled.map(({ sheet, manual }) => ({
          sheet,
          manual: shared.length > 0 ? shared.join('; ') : manual,
        })),
      });
    }
  }

  for (const op of archivedOps) {
    const issued = sheets.filter((sheet) => sheet.correctionId === op.id);
    const burned = sheets.filter((sheet) => sheet.cancelCorrectionId === op.id);
    const trimmed = sheets.filter((sheet) => sheet.periodTrimCorrectionId === op.id);
    if (issued.length + burned.length + trimmed.length === 0) continue;
    traces.archivedRepairs.push({
      kind: 'archived_repair',
      requestId,
      operation: opRef(op),
      issued: issued.map(publicSheet),
      burned: burned.map(publicSheet),
      trimmed: trimmed.map(publicSheet),
    });
  }

  // Blanks a repair minted on days its command did not change. An archived repair is listed whole
  // above, and one list per operation is enough for a human.
  const archivedIds = new Set(archivedOps.map((op) => op.id));
  for (const op of operations.values()) {
    if (archivedIds.has(op.id)) continue;
    const scope = commandScopeOf(op.payload);
    if (!scope) continue;
    for (const sheet of active) {
      if (sheet.correctionId !== op.id) continue;
      const inTerm = clip({ from: sheet.from, to: sheet.to }, term);
      if (!inTerm) continue;
      let outside: AssignmentRange[] = [inTerm];
      for (const range of scope) outside = subtract(outside, range);
      if (outside.length === 0) continue;
      traces.incidentalSheets.push({
        kind: 'incidental_sheet',
        requestId,
        operation: opRef(op),
        sheet: publicSheet(sheet),
        outside,
      });
    }
  }
  return traces;
}

/**
 * Uncovered days split into the locked past and the mutable rest. No active blank covers them, so
 * the sheet half of the mutable part (R21) never applies, and the split is the calendar's: a past
 * day is filled with the door's known fill, a day from today on is named with an anchor.
 */
function splitByToday(
  range: AssignmentRange,
  asOf: string,
): (AssignmentRange & { locked: boolean })[] {
  if (range.to < asOf) return [{ ...range, locked: true }];
  if (range.from >= asOf) return [{ ...range, locked: false }];
  return [
    { from: range.from, to: shiftDateKey(asOf, -1), locked: true },
    { from: asOf, to: range.to, locked: false },
  ];
}

/**
 * D3: the fill's `set` still governs `fill.to + 1`, and nothing in its group says where it ends.
 *
 * Measured on today's history, with one look back: the day after the fill must have had no machinist
 * row of its own when the fill ran. If it had one that was removed later, today's inheritance comes
 * from that later removal, not from the fill — a human reads which.
 */
function leakOf(input: {
  row: AssignmentChangeRecord;
  op: OperationRow;
  fill: KnownFillSummary;
  summary: RepairSummary;
  rows: readonly AssignmentChangeRecord[];
  actual: readonly AssignmentChangeRecord[];
  term: AssignmentRange;
  active: readonly SheetRow[];
  asOf: string;
  used: ReadonlyMap<string, string>;
}): Omit<LeakTrace, 'requestId' | 'operation'> | null {
  const { row, op, fill, rows, actual, term, active, asOf, used } = input;
  const group = rows.filter((other) => other.changeGroupId === row.changeGroupId);
  if (group.some((other) => other.origin === 'unknown_remainder')) return null;
  const day = shiftDateKey(fill.to, 1);
  if (day > term.to) return null;
  const drivers = actual.filter((other) => other.dimension === 'driver');
  if (
    drivers.some((other) => other.effectiveDate > row.effectiveDate && other.effectiveDate <= day)
  ) {
    return null;
  }
  const next = drivers.find((other) => other.effectiveDate > day);
  const through =
    next && next.effectiveDate <= term.to ? shiftDateKey(next.effectiveDate, -1) : term.to;

  const manual: string[] = [];
  const removedLater = rows.some(
    (other) =>
      other.dimension === 'driver' &&
      other.effectiveDate === day &&
      other.supersededAt !== null &&
      other.createdAt.getTime() < op.createdAt.getTime() &&
      new Date(other.supersededAt).getTime() >= op.createdAt.getTime(),
  );
  if (removedLater) {
    manual.push(`строку машиниста на ${day} сняли уже после заполнения — протекание не от него`);
  }
  const foreignFill = rows.find(
    (other) =>
      other.origin === 'known_fill' &&
      other.changeGroupId !== row.changeGroupId &&
      other.effectiveDate >= day &&
      other.effectiveDate <= through,
  );
  if (foreignFill) {
    manual.push(`на протекших днях есть другое заполнение (с ${foreignFill.effectiveDate})`);
  }

  const forward: TraceSheet[] = [];
  const others: TraceSheet[] = [];
  for (const sheet of active) {
    if (sheet.to < day || sheet.from > through) continue;
    if (sheet.correctionId !== op.id) {
      others.push(publicSheet(sheet));
      continue;
    }
    forward.push(publicSheet(sheet));
    if (sheet.from < day) {
      manual.push(`лист ${sheet.number} захватывает и заполненные, и протекшие дни`);
    } else if (sheet.to > through) {
      manual.push(`лист ${sheet.number} выходит за протекшие дни (до ${through})`);
    } else if (
      !canCancelWaybill({ issuedForDate: sheet.issuedForDate, periodTo: sheet.to }, asOf)
    ) {
      manual.push(`лист ${sheet.number} отработан (кончился ${sheet.to})`);
    } else if (sheet.driverPersonId !== fill.personId) {
      manual.push(`лист ${sheet.number} печатает не того человека, что заполнение`);
    } else if (used.has(sheet.id)) {
      manual.push(`лист ${sheet.number}: ${used.get(sheet.id)}`);
    }
  }
  return {
    kind: 'leak',
    fill,
    changeGroupId: row.changeGroupId,
    day,
    through,
    stateBefore: input.summary.stateBefore,
    stateAfter: input.summary.stateAfter,
    forward,
    others,
    manual,
  };
}

/**
 * D4: active blanks the cancelled fill minted, on days today's history no longer names anyone.
 *
 * A blank whose days history still names the same person (a later fill re-covered them) is
 * consistent and not a trace; one whose days history names somebody else is a contradiction the
 * drift verdict owns, and it goes to a human here.
 */
function cancelledFillOf(input: {
  row: AssignmentChangeRecord;
  op: OperationRow;
  fill: KnownFillSummary;
  actual: readonly AssignmentChangeRecord[];
  term: AssignmentRange;
  active: readonly SheetRow[];
  used: ReadonlyMap<string, string>;
}): { sheet: TraceSheet; manual: string | null }[] {
  const { op, fill, actual, term, active, used } = input;
  const out: { sheet: TraceSheet; manual: string | null }[] = [];
  for (const sheet of active) {
    if (sheet.correctionId !== op.id || sheet.driverPersonId !== fill.personId) continue;
    if (sheet.to < fill.from) continue;
    let supported = 0;
    let contradicted: string | null = null;
    let days = 0;
    for (let day = sheet.from; day <= sheet.to; day = shiftDateKey(day, 1)) {
      if (day < term.from || day > term.to) continue;
      days += 1;
      const driver = assignmentStateOn(actual, day).driver;
      if (driver?.state === 'set') {
        if (driver.personId === sheet.driverPersonId) supported += 1;
        else contradicted ??= day;
      } else if (driver?.state === 'cleared') {
        contradicted ??= day;
      }
    }
    // Every day is vouched for again by today's history: the blank is consistent, not a trace.
    if (days > 0 && supported === days) continue;
    let manual: string | null = null;
    if (days === 0) manual = `лист ${sheet.number} лежит за сроком заявки`;
    else if (sheet.from < fill.from) manual = `лист ${sheet.number} начинается раньше заполнения`;
    else if (contradicted)
      manual = `история на ${contradicted} называет по листу ${sheet.number} другое`;
    else if (supported > 0) manual = `часть дней листа ${sheet.number} история снова подтверждает`;
    else if (used.has(sheet.id)) manual = `лист ${sheet.number}: ${used.get(sheet.id)}`;
    out.push({ sheet: publicSheet(sheet), manual });
  }
  return out;
}

// ── Healing ──

export interface TraceHealPlan {
  /** `unknown_remainder` rows to return, each into its leaked fill's group. */
  remainders: { date: string; changeGroupId: string; fillOperationId: string }[];
  /** Blanks to cancel through the journal. */
  cancels: TraceSheet[];
  /** What each healed trace was, for the journal snapshot and the audit event. */
  healed: (
    | { kind: 'leak'; operationId: string; fill: KnownFillSummary; day: string; sheets: string[] }
    | { kind: 'cancelled_fill'; operationId: string; fill: KnownFillSummary; sheets: string[] }
  )[];
}

/** The cure the selected fixes allow — only the unambiguous parts of the traces. */
export function traceHealPlanOf(
  traces: RequestTraces,
  fixes: ReadonlySet<DriftFix>,
): TraceHealPlan {
  const plan: TraceHealPlan = { remainders: [], cancels: [], healed: [] };
  const cancelled = new Set<string>();
  const cancel = (sheet: TraceSheet): void => {
    if (cancelled.has(sheet.id)) return;
    cancelled.add(sheet.id);
    plan.cancels.push(sheet);
  };
  if (fixes.has('leak')) {
    for (const leak of traces.leaks) {
      if (leak.manual.length > 0) continue;
      plan.remainders.push({
        date: leak.day,
        changeGroupId: leak.changeGroupId,
        fillOperationId: leak.operation.id,
      });
      leak.forward.forEach(cancel);
      plan.healed.push({
        kind: 'leak',
        operationId: leak.operation.operationId,
        fill: leak.fill,
        day: leak.day,
        sheets: leak.forward.map((sheet) => sheet.number),
      });
    }
  }
  if (fixes.has('fill-paper')) {
    for (const trace of traces.cancelledFills) {
      const curable = trace.sheets.filter((item) => item.manual === null).map((item) => item.sheet);
      if (curable.length === 0) continue;
      curable.forEach(cancel);
      plan.healed.push({
        kind: 'cancelled_fill',
        operationId: trace.operation.operationId,
        fill: trace.fill,
        sheets: curable.map((sheet) => sheet.number),
      });
    }
  }
  return plan;
}

export interface TraceHealOutcome {
  plan: TraceHealPlan;
  /** Journal operation that carries the cure; `null` — nothing was curable. */
  correctionId: string | null;
  /** Traces as they were under the lock before the cure — what the report lists. */
  before: RequestTraces;
  /** Traces as they are after the cure — what is left for a human. */
  after: RequestTraces;
}

/**
 * The journal is written by the portal's own functions, loaded by name: they live next to the
 * application pool, and a static import would make even the report depend on the portal's
 * environment (the same reason `assignment-shadow.ts` loads its module by name). A second copy of
 * the journal `INSERT` here would drift from the one every door uses.
 */
const CORRECTION_MODULE = '../src/services/waybill-correction';

/**
 * Heal one request: one transaction, the door gate and the row lock first, the traces re-read under
 * the lock, the cure written with one journal operation, readiness recomputed, the result
 * re-checked. Idempotent: a healed trace is no longer a trace, so the second run finds nothing.
 */
export async function applyTraceHeal(
  db: Handle,
  params: {
    requestId: string;
    asOf: string;
    actorUserId: string;
    reason: string;
    fixes: ReadonlySet<DriftFix>;
  },
): Promise<TraceHealOutcome> {
  return db.transaction(async (tx) => {
    // The same gate every history door passes first: a cutover or a rollback freezes this command
    // as well, since it writes history and burns blanks.
    await requireOpenDoor(tx, 'history');
    await tx.execute(
      sql`SELECT id FROM vehicle_requests WHERE id = ${params.requestId}::uuid FOR UPDATE`,
    );
    const before = await inspectTraces(tx, params.requestId, params.asOf);
    const plan = traceHealPlanOf(before, params.fixes);
    if (plan.remainders.length === 0 && plan.cancels.length === 0) {
      return { plan, correctionId: null, before, after: before };
    }

    const journal = (await import(CORRECTION_MODULE)) as typeof CorrectionJournal;
    const effectiveDate = [
      ...plan.remainders.map((item) => item.date),
      ...plan.cancels.map((sheet) => sheet.to),
    ].sort()[0]!;
    const requiresCorrect = effectiveDate < params.asOf;
    // The requirements the operation carried, recorded as a door records them (R9). The command
    // itself is admitted by the maintenance role, not by the actor's grants: the actor is whose
    // name the journal carries, and choosing an account with `waybills.correct` is the operator's
    // part (runbook).
    const scope: WaybillCorrectionAuthorizationScope = {
      schemaVersion: 1,
      requiresCorrect,
      requiresCorrectBeyondLimit:
        requiresCorrect && effectiveDate < correctionFloorDateKey(params.asOf),
      requiresArchiveRestore: false,
      effectiveDate,
      authorizedAsOf: params.asOf,
    };
    const body = {
      remainders: plan.remainders.map((item) => ({ date: item.date, group: item.changeGroupId })),
      cancels: plan.cancels.map((sheet) => sheet.id).sort(),
    };
    const correction = await journal.insertCorrection(tx, {
      operationId: randomUUID(),
      fingerprint: journal.correctionFingerprint({
        kind: 'crew',
        target: { door: JOURNAL_DOOR, requestId: params.requestId },
        body,
      }),
      // `crew`: the operation corrects the history of worked days and the paper printed from it —
      // exactly what the repair door's own operations are; it completes what they left undone.
      kind: 'crew',
      reason: params.reason,
      actorUserId: params.actorUserId,
      authorizationScope: scope,
    });

    for (const remainder of plan.remainders) {
      /*
       * A direct insert, not the write core: the core issues change groups itself precisely so that
       * no door can slip rows into another decision's group. Here that is the whole point — the
       * row is the missing member of the fill's group, the one the fill should have written (Sh4),
       * and a remainder outside it would make `cancel_fill` refuse the group or leave the boundary
       * behind. The table's CHECKs pin the row's shape (driver, `unknown`, with an operation) and
       * its unique indexes keep the slot and the group's single remainder honest.
       */
      await tx.insert(schema.vehicleRequestAssignmentChanges).values({
        requestId: params.requestId,
        effectiveDate: remainder.date,
        dimension: 'driver',
        vehicleId: null,
        driverPersonId: null,
        driverState: 'unknown',
        origin: 'unknown_remainder',
        changeGroupId: remainder.changeGroupId,
        correctionId: correction.id,
        createdBy: params.actorUserId,
      });
    }
    for (const sheet of plan.cancels) {
      const done = await journal.cancelWaybillForCorrection(tx, {
        waybillId: sheet.id,
        correctionId: correction.id,
        reason: params.reason,
        actorUserId: params.actorUserId,
      });
      if (!done)
        throw new Error(`лист ${sheet.number} аннулировали параллельно — лечение отменено`);
    }
    await journal.saveCorrectionPayload(tx, correction.id, {
      door: JOURNAL_DOOR,
      healed: plan.healed,
      remainders: plan.remainders,
      cancelled: plan.cancels.map((sheet) => ({
        id: sheet.id,
        number: sheet.number,
        from: sheet.from,
        to: sheet.to,
        vehicleId: sheet.vehicleId,
        driverPersonId: sheet.driverPersonId,
      })),
    });
    await journal.linkCorrectionRequests(tx, correction.id, [params.requestId]);
    // Readiness follows the returned boundary: the leaked days become `unknown` again and a
    // mutable one among them makes the request `materialized` until an anchor names somebody.
    await ensureAssignmentHistory(tx, { requestId: params.requestId, asOf: params.asOf });
    await bumpRequestVersion(tx, params.requestId, params.actorUserId);

    const after = await inspectTraces(tx, params.requestId, params.asOf);
    const left = traceHealPlanOf(after, params.fixes);
    if (left.remainders.length > 0 || left.cancels.length > 0) {
      throw new Error(
        `после лечения у заявки ${params.requestId} остался излечимый след — запись отменена`,
      );
    }
    await tx.insert(schema.auditLog).values({
      actorUserId: params.actorUserId,
      action: HEAL_AUDIT_ACTION,
      entityType: 'vehicle_request',
      entityId: params.requestId,
      metadata: {
        reason: params.reason,
        operationId: correction.operationId,
        healed: plan.healed,
      },
    });
    return { plan, correctionId: correction.id, before, after };
  });
}

/**
 * The request version moves with every write of this command, as it does with every door (§8, step
 * 14): an open preview must not be confirmed against history it no longer describes, and a door
 * transaction that took its snapshot before this one committed must fail on the row rather than
 * plan from rows it cannot see.
 */
export async function bumpRequestVersion(
  tx: Tx,
  requestId: string,
  actorUserId: string,
): Promise<void> {
  await tx
    .update(schema.vehicleRequests)
    .set({
      version: sql`${schema.vehicleRequests.version} + 1`,
      updatedBy: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(schema.vehicleRequests.id, requestId));
}
