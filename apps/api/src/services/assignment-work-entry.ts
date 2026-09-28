import type { DriverState, VehicleOwnership } from '@technic/contracts';
import { err } from '../lib/errors';
import type { AssignmentCommandTx } from './assignment-command';
import { assignmentPaperPreviewOf, readSheetNumbers } from './assignment-crew';
import {
  assignmentCommandEffects,
  paperScopeOf,
  type AssignmentMutation,
} from './assignment-effects';
import {
  assignmentChangeTargetOf,
  assignmentHistoryUnrestorableReason,
  ensureAssignmentHistory,
  readAssignmentHistorySnapshot,
} from './assignment-ensure';
import {
  assignmentSegments,
  assignmentStateOn,
  sameDriverState,
  type AssignmentTerm,
} from './assignment-history';
import type { AssignmentModeSnapshot } from './assignment-mode';
import {
  applyAssignmentPaper,
  assertAssignmentPaperConverged,
  assignmentPlanIssues,
} from './assignment-paper';
import {
  applyAssignmentMutations,
  assertAssignmentDenormalization,
  readAssignmentChanges,
  type AssignmentChangeRecord,
  type AssignmentChangeValue,
  type AssignmentWriteMutation,
} from './assignment-write';
import { esm2SheetPlan, type Esm2ExistingSheet } from './esm2-plan';
import { buildEsm2SyncPlan, syncEsm2Waybills, type Esm2SyncResult } from './waybill-esm2';

/**
 * Taking a special-equipment request into work writes the assignment history it starts from
 * (ADR 0212, decisions 1–2, `docs/adr/0212-assignment-old-doors-write-history.md`;
 * `docs/assignment-periods-plan.md`, R13, R26).
 *
 * WHY THE STATUS DOOR WRITES HISTORY. With `read_mode = history` the rows are the source of truth,
 * and the status door used to write only the assignment. A first entry then folded into "machinist
 * unknown from `dateFrom`" and the backstop refused every own vehicle (hotfix `239f8595` only
 * silenced that refusal). A re-entry after a rollback to «Новая» was worse and silent: the previous
 * pair's rows stayed, the readers (site slice, garage, vehicle filter, driver contact, analytics)
 * kept showing the previous vehicle, and the next history command re-issued paper for it.
 *
 * WHAT IS WRITTEN. One group with `origin = 'assignment'` on date D:
 *
 * - D is `dateFrom` on a first entry (no rows and no sheets): the pair is named for the whole term,
 *   past days included, even though past weeks get no paper;
 * - D is `max(asOf, dateFrom)`, kept inside the term, on a re-entry: earlier days keep the pair that
 *   worked them — their sheets are still there — and the new pair starts today (ADR 0212,
 *   decision 2);
 * - the vehicle is the one just saved to the assignment; the machinist is the person named by the
 *   body for an own vehicle, `cleared` for a rental one (its paper is the lessor's), and no driver
 *   row at all for a linear request (ADR 0100 §6 — there is no machinist of the request);
 * - a row already on D is replaced, rows after D are cancelled: they are plans of the previous pair,
 *   and leaving them would bring that pair back on their dates. Rows before D are not touched.
 *
 * PAPER. For `auto` requests the sheets follow the written history through the segment plan, as
 * for every history door in this mode (§10 of the periods plan): the weekly sweep knows one pair
 * per request and would print the new pair over the days the previous one worked. The scope starts
 * at the first sheet period not yet over on `max(D, asOf)`: the current week is issued whole, as the
 * weekly sweep does, while fully past weeks without a sheet stay a hole — ordinary work never fills
 * the past (R21), and a scope covering them would fail the convergence check. `on_demand` (linear)
 * and `none` (rental) keep the weekly sweep: their paper is not derived from history.
 *
 * NOT HERE. `read_mode = legacy` is the rollback mode and is left as it was: the caller comes here
 * only in `history`. Acknowledgements are not required: the "Take into work" form has no sheet
 * handshake, and the weekly sweep it replaces did not ask for one either — the sheets record that
 * nobody confirmed their warnings.
 */

/** Group key of the entry: both rows are one decision and must be cancelled or replaced together. */
const ENTRY_GROUP = 'work-entry';

export interface WorkEntryParams {
  requestId: string;
  actor: { id: string };
  /** The door's single "today": the paper plan and the history must not straddle midnight. */
  asOf: string;
  mode: AssignmentModeSnapshot;
  /** Machinist named by the "Take into work" body; `null` — not named. */
  driverPersonId: string | null;
  /** Why the paper changed: goes into cancel reasons and the sync event. */
  reason: string;
}

/**
 * Write the entry history and issue its paper, in the caller's transaction and under its locks.
 *
 * The caller must already have saved the assignment, written the new status and locked the
 * request row: the paper mode is read from the database, and `follow` (R17) checks the saved
 * assignment against the history tail.
 */
export async function enterWorkWithHistory(
  tx: AssignmentCommandTx,
  params: WorkEntryParams,
): Promise<Esm2SyncResult> {
  const { requestId, asOf } = params;
  const snapshot = await readAssignmentHistorySnapshot(tx, requestId);
  const vehicleId = snapshot.assignmentVehicleId;
  if (!vehicleId) {
    throw err.unprocessable('Выберите технику — в работу заявку берут конкретной машиной', {
      assignment: 'Выберите технику',
    });
  }
  const term = snapshot.term;
  const last = term.dateTo || term.dateFrom;
  const rental = snapshot.ownershipByVehicle.get(vehicleId) === 'rental';

  let driver: DriverState | null = null;
  if (!snapshot.isLinear) {
    if (rental) {
      driver = { state: 'cleared' };
    } else if (params.driverPersonId) {
      driver = { state: 'set', personId: params.driverPersonId };
    } else if (last >= asOf) {
      // Same words the weekly sweep used: an own vehicle with days ahead gets sheets, and a sheet
      // without a machinist cannot be printed. A term entirely in the past issues nothing, so it
      // is let through with the vehicle alone, as before.
      throw err.unprocessable(
        'Укажите машиниста — на него выписываются путевые листы ЭСМ-2 за каждую неделю работ',
        { driverPersonId: 'Выберите машиниста' },
      );
    }
  }

  const fresh = snapshot.changes.length === 0 && snapshot.sheets.length === 0;
  if (!fresh && snapshot.changes.length === 0) {
    // Rows are missing but paper exists (a request worked before the history module, rolled back
    // and taken again): restore what the paper says first, so the days before D keep their pair.
    const ensured = await ensureAssignmentHistory(tx, { requestId, asOf });
    if (ensured.state === 'empty') {
      throw err.unprocessable(
        `История назначения этой заявки не восстановлена: ${assignmentHistoryUnrestorableReason(ensured.unrestorable)}`,
        { requestId: 'История не материализована' },
      );
    }
  }
  const before: AssignmentChangeRecord[] = fresh
    ? []
    : await readAssignmentChanges(tx, requestId, { actualOnly: true });

  const today = asOf > term.dateFrom ? asOf : term.dateFrom;
  const effectiveDate = fresh ? term.dateFrom : today < last ? today : last;

  const mutations: AssignmentWriteMutation[] = [];
  const effectMutations: AssignmentMutation[] = [];
  const stateOnDate = assignmentStateOn(before, effectiveDate);
  const put = (value: AssignmentChangeValue, unchanged: boolean): void => {
    if (unchanged) return;
    const row = before.find(
      (r) => r.dimension === value.dimension && r.effectiveDate === effectiveDate,
    );
    if (row) {
      mutations.push({
        kind: 'replace',
        target: assignmentChangeTargetOf(row),
        value,
        origin: 'assignment',
        group: ENTRY_GROUP,
      });
      effectMutations.push({ kind: 'replace', changeId: row.id });
      return;
    }
    mutations.push({
      kind: 'insert',
      effectiveDate,
      value,
      origin: 'assignment',
      group: ENTRY_GROUP,
    });
    effectMutations.push({
      kind: 'insert',
      dimension: value.dimension,
      effectiveDate,
      origin: 'assignment',
    });
  };
  put({ dimension: 'vehicle', vehicleId }, stateOnDate.vehicle?.vehicleId === vehicleId);
  if (driver) put({ dimension: 'driver', driver }, sameDriverState(stateOnDate.driver, driver));
  // Cancels go after replaces: the core cancels whole groups, and a row it has already replaced
  // must not be superseded a second time by a group sweep.
  for (const row of before.filter((r) => r.effectiveDate > effectiveDate)) {
    mutations.push({ kind: 'cancel', target: assignmentChangeTargetOf(row) });
  }

  let after: readonly AssignmentChangeRecord[] = before;
  if (mutations.length > 0) {
    const write = await applyAssignmentMutations(tx, {
      requestId,
      actorUserId: params.actor.id,
      correctionId: null,
      mutations,
      denormalization: { kind: 'follow' },
    });
    await assertAssignmentDenormalization(tx, write.denormalization);
    after = write.changesAfter;
    for (const { kind, row } of write.superseded) {
      if (kind === 'cancelled') effectMutations.push({ kind: 'cancel', changeId: row.id });
    }
  }

  const base = await buildEsm2SyncPlan(tx, { requestId, asOf });
  const esm2 =
    base?.input.mode === 'auto'
      ? await issueEntryPaper(tx, {
          params,
          term,
          effectiveDate,
          before,
          after,
          effectMutations,
          sheets: [...base.input.existing],
          ownershipByVehicle: snapshot.ownershipByVehicle,
        })
      : await syncEsm2Waybills(tx, {
          requestId,
          actor: params.actor,
          reason: params.reason,
          driverPersonId: params.driverPersonId,
          asOf,
        });

  // Readiness last: its mutable region depends on which sheets are cancellable, and the paper
  // step has just changed them.
  await ensureAssignmentHistory(tx, { requestId, asOf });
  return esm2;
}

/** Segment-plan paper of the entry: the same helpers every history door issues sheets with. */
async function issueEntryPaper(
  tx: AssignmentCommandTx,
  input: {
    params: WorkEntryParams;
    term: AssignmentTerm;
    effectiveDate: string;
    before: readonly AssignmentChangeRecord[];
    after: readonly AssignmentChangeRecord[];
    effectMutations: readonly AssignmentMutation[];
    sheets: readonly Esm2ExistingSheet[];
    ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>;
  },
): Promise<Esm2SyncResult> {
  const { params, term, sheets, ownershipByVehicle } = input;
  const asOf = params.asOf;
  const last = term.dateTo || term.dateFrom;
  const segmentsAfter = assignmentSegments(input.after, term);
  const planContext = { ownershipByVehicle, today: asOf };
  const wanted = esm2SheetPlan(segmentsAfter, term, [], planContext).wanted;

  const from = input.effectiveDate > asOf ? input.effectiveDate : asOf;
  const firstOpen = wanted
    .filter((want) => want.to >= from)
    .reduce<string | null>(
      (min, want) => (min === null || want.from < min ? want.from : min),
      null,
    );
  // Closure over the new cut only: the previous pair's periods would drag its ended days into the
  // scope, and those days have no paper to converge to.
  const paperScope = firstOpen ? paperScopeOf([{ from: firstOpen, to: last }], sheets, wanted) : [];
  if (paperScope.length === 0) return { cancelled: [], issued: [], trimmed: [] };

  const effects = assignmentCommandEffects({
    changes: input.before,
    term,
    asOf,
    mutations: input.effectMutations,
    sheets,
    wanted,
  });
  const sheetPlan = esm2SheetPlan(segmentsAfter, term, sheets, {
    ...planContext,
    scope: paperScope,
  });
  const numbers = await readSheetNumbers(tx, params.requestId);
  const preview = await assignmentPaperPreviewOf(tx, sheetPlan, sheets, numbers);
  const planIssues = await assignmentPlanIssues(tx, {
    requestId: params.requestId,
    issue: preview.issue,
  });
  const esm2 = await applyAssignmentPaper(tx, {
    requestId: params.requestId,
    actor: params.actor,
    reason: params.reason,
    mode: params.mode,
    effects,
    // No journal operation: taking into work is ordinary work, and the executor picks the ordinary
    // branch from this `null` whatever the effects say about past days.
    operationId: null,
    sheetPlan,
    paperScope,
    sheets,
    displayNumbers: numbers,
    unlockWaybillIds: [],
    issues: planIssues.prepared,
  });
  await assertAssignmentPaperConverged(tx, {
    requestId: params.requestId,
    asOf,
    segmentsAfter,
    term,
    ownershipByVehicle,
    paperScope,
    unlockWaybillIds: [],
    needsCorrection: false,
  });
  return esm2;
}
