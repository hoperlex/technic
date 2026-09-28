import type {
  AssignmentPlanCancelDto,
  AssignmentPlanIssueDto,
  AssignmentIssueWarningsDto,
  DriverState,
  Esm2Period,
  RequiredAnchor,
  VehicleOwnership,
} from '@technic/contracts';
import { err } from '../lib/errors';
import type { AssignmentCommandTx } from './assignment-command';
import { assignmentPaperPreviewOf } from './assignment-crew';
import {
  assignmentCommandEffects,
  type AssignmentEffects,
  type AssignmentMutation,
} from './assignment-effects';
import {
  assignmentChangeTargetOf,
  assignmentHistoryUnrestorableReason,
  computeAssignmentHistory,
  ensureAssignmentHistory,
  ensureCommandHistory,
  readAssignmentHistorySnapshot,
} from './assignment-ensure';
import {
  assignmentSegments,
  assignmentStateOn,
  sameDriverState,
  type AssignmentChangeRow,
  type AssignmentSegment,
  type AssignmentTerm,
} from './assignment-history';
import type { AssignmentModeSnapshot } from './assignment-mode';
import {
  applyAssignmentPaper,
  assertAssignmentPaperConverged,
  assignmentPlanIssues,
} from './assignment-paper';
import { mutableRangesOf, requiredAnchorsOf } from './assignment-repair';
import {
  applyAssignmentMutations,
  assertAssignmentDenormalization,
  type AssignmentChangeValue,
  type AssignmentWriteMutation,
} from './assignment-write';
import {
  esm2SheetPlan,
  type DateRangeSet,
  type Esm2ExistingSheet,
  type Esm2SheetPlan,
} from './esm2-plan';
import type { Esm2IssuePreparations, Esm2SyncResult } from './waybill-esm2';

/**
 * "Change vehicle" as a history command when history is read (ADR 0212, decision 3).
 *
 * WHY. The old reassignment door rewrote the assignment and the paper through the weekly sweep and
 * never touched history. With `read_mode = history` that left the previous vehicle as the history
 * tail: every history-aware reader kept showing it, and the next history command (machinist
 * change, term edit, repair) issued paper from that stale history — back onto the previous vehicle.
 *
 * WHAT THE COMMAND IS. A vehicle row on date D with `origin = 'reassignment'` (D is the door's own
 * date: today or the start of a term not begun yet; the earliest touched day for a correction):
 *
 * - the vehicle row already on D is replaced; vehicle rows after D are cancelled with their groups
 *   (earlier reassignments and a dormant tail): the new vehicle holds to the end of the term, which
 *   is what the assignment says and what `follow` (R17) verifies;
 * - planned machinist changes after D are kept: the person changes independently of the vehicle
 *   (R7 of the periods plan);
 * - the machinist on D follows the vehicle: named by the body → that person; a rental vehicle →
 *   `cleared` (its paper is the lessor's); otherwise the person is inherited and no row is written.
 *   An own segment left without a person in the door's own range is refused with "name the
 *   machinist" (R16) — the body carries that field, unlike the backstop's advice to use another door.
 *
 * PAPER. Sheets follow the new cut through the segment plan: days before D stay with the previous
 * vehicle (a burned current-week sheet is re-issued for them), days from D go to the new one. The
 * plan is computed once here — for the preview, its fingerprint and the executing door alike.
 *
 * LINEAR requests write the vehicle row only: they have no machinist of the request and their paper
 * is issued on demand (ADR 0100 §6), so the caller keeps the weekly sweep for it.
 */

/** Origin of the new row — the same the period correction writes; `correction_id` tells them apart. */
const ORIGIN = 'reassignment' as const;

/** Group key of the rows this command writes: one decision, cancelled or replaced together. */
const GROUP = 'reassignment';

export interface ReassignHistoryInput {
  request: { id: string; num: number; term: AssignmentTerm };
  asOf: string;
  /** The door's date of the command. */
  effectiveDate: string;
  vehicleId: string;
  nextOwnership: VehicleOwnership;
  driverPersonId: string | null;
  /** Sheets named by a correction body; empty for an ordinary change. */
  unlockWaybillIds: readonly string[];
  correction: boolean;
  /** Active sheets of the request, as the weekly sweep input reads them. */
  sheets: readonly Esm2ExistingSheet[];
  numbers: ReadonlyMap<string, string>;
}

/** What the executing half needs, computed once with the preview. */
export interface ReassignHistoryApply {
  linear: boolean;
  mutations: AssignmentWriteMutation[];
  term: AssignmentTerm;
  segmentsAfter: AssignmentSegment[];
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>;
  sheetPlan: Esm2SheetPlan;
  paperScope: DateRangeSet;
  sheets: readonly Esm2ExistingSheet[];
  numbers: ReadonlyMap<string, string>;
  issuePreparations: Esm2IssuePreparations;
}

export interface ReassignHistoryPlan {
  /** `null` for a linear request: its effects and paper stay with the weekly sweep. */
  effects: AssignmentEffects | null;
  preview: { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] };
  issues: AssignmentIssueWarningsDto[];
  requiredUnlockIds: string[];
  /** Own segments left without a person in the command's own range; non-empty — refused. */
  requiredAnchors: RequiredAnchor[];
  apply: ReassignHistoryApply;
}

const EMPTY_SHEET_PLAN: Esm2SheetPlan = {
  wanted: [],
  cancel: [],
  issue: [],
  trim: [],
  kept: [],
  locked: [],
  outOfScope: [],
};

/** Plan the reassignment on the real history. Reads only — the preview calls it too. */
export async function planReassignHistory(
  tx: AssignmentCommandTx,
  input: ReassignHistoryInput,
): Promise<ReassignHistoryPlan> {
  const { request, asOf, effectiveDate: d } = input;
  const snapshot = await readAssignmentHistorySnapshot(tx, request.id);
  const history = computeAssignmentHistory(snapshot, asOf);
  if (history.state === 'empty') {
    throw err.unprocessable(
      `История назначения этой заявки не восстановлена: ${assignmentHistoryUnrestorableReason(history.unrestorable)}`,
      { requestId: 'История не материализована' },
    );
  }
  const term = snapshot.term;
  const last = term.dateTo || term.dateFrom;
  const linear = snapshot.isLinear;
  const ownershipByVehicle = new Map(snapshot.ownershipByVehicle);
  ownershipByVehicle.set(input.vehicleId, input.nextOwnership);

  const before: readonly AssignmentChangeRow[] = history.changes;
  const cancelledGroups = new Set(
    before
      .filter((row) => row.dimension === 'vehicle' && row.effectiveDate > d)
      .map((row) => row.changeGroupId),
  );
  const cancelled = before.filter((row) => cancelledGroups.has(row.changeGroupId));
  let after: AssignmentChangeRow[] = before.filter(
    (row) => !cancelledGroups.has(row.changeGroupId),
  );

  const mutations: AssignmentWriteMutation[] = [];
  const effectMutations: AssignmentMutation[] = [];
  const put = (value: AssignmentChangeValue): void => {
    const state = assignmentStateOn(after, d);
    const unchanged =
      value.dimension === 'vehicle'
        ? state.vehicle?.vehicleId === value.vehicleId
        : sameDriverState(state.driver, value.driver);
    if (unchanged) return;
    const row = after.find((r) => r.dimension === value.dimension && r.effectiveDate === d);
    const fields =
      value.dimension === 'vehicle'
        ? { vehicleId: value.vehicleId, driverPersonId: null, driverState: null }
        : {
            vehicleId: null,
            driverPersonId: value.driver.state === 'set' ? value.driver.personId : null,
            driverState: value.driver.state,
          };
    if (row) {
      mutations.push({
        kind: 'replace',
        target: assignmentChangeTargetOf(row),
        value,
        origin: ORIGIN,
        group: GROUP,
      });
      effectMutations.push({ kind: 'replace', changeId: row.id });
      after = after.map((r) => (r === row ? { ...r, ...fields, origin: ORIGIN } : r));
      return;
    }
    mutations.push({ kind: 'insert', effectiveDate: d, value, origin: ORIGIN, group: GROUP });
    effectMutations.push({
      kind: 'insert',
      dimension: value.dimension,
      effectiveDate: d,
      origin: ORIGIN,
    });
    after = [
      ...after,
      {
        // Planned row: it gets a real id on write; the fold only needs its content.
        id: `planned-reassign:${value.dimension}:${d}`,
        effectiveDate: d,
        dimension: value.dimension,
        ...fields,
        origin: ORIGIN,
        changeGroupId: `planned-reassign:${d}`,
        supersededAt: null,
      },
    ];
  };
  put({ dimension: 'vehicle', vehicleId: input.vehicleId });
  const driver: DriverState | null = linear
    ? null
    : input.nextOwnership === 'rental'
      ? { state: 'cleared' }
      : input.driverPersonId
        ? { state: 'set', personId: input.driverPersonId }
        : null;
  if (driver) put({ dimension: 'driver', driver });
  // Cancels after replaces: the core sweeps whole groups, and a row already replaced must not be
  // superseded twice.
  for (const group of cancelledGroups) {
    const target = cancelled.find((row) => row.changeGroupId === group)!;
    mutations.push({ kind: 'cancel', target: assignmentChangeTargetOf(target) });
  }
  for (const row of cancelled) effectMutations.push({ kind: 'cancel', changeId: row.id });

  const segmentsBefore = assignmentSegments(before, term);
  const segmentsAfter = assignmentSegments(after, term);
  const sheets = input.sheets;

  const apply = (overrides: Partial<ReassignHistoryApply>): ReassignHistoryApply => ({
    linear,
    mutations,
    term,
    segmentsAfter,
    ownershipByVehicle,
    sheetPlan: EMPTY_SHEET_PLAN,
    paperScope: [],
    sheets,
    numbers: input.numbers,
    issuePreparations: new Map(),
    ...overrides,
  });
  if (linear) {
    return {
      effects: null,
      preview: { cancel: [], issue: [] },
      issues: [],
      requiredUnlockIds: [],
      requiredAnchors: [],
      apply: apply({}),
    };
  }

  const planContext = { ownershipByVehicle, today: asOf };
  const wanted: Esm2Period[] = [
    ...esm2SheetPlan(segmentsBefore, term, [], planContext).wanted,
    ...esm2SheetPlan(segmentsAfter, term, [], planContext).wanted,
  ];
  const effects = assignmentCommandEffects({
    changes: before,
    term,
    asOf,
    mutations: effectMutations,
    sheets,
    wanted,
  });
  const paperScope = effects.paperScope;
  // Unlocks are named by the server from a plan without them: its `locked` set is exactly what a
  // correction has to name to re-issue worked paper (R11).
  const probe = esm2SheetPlan(segmentsAfter, term, sheets, { ...planContext, scope: paperScope });
  const requiredUnlockIds = effects.needsCorrection ? [...probe.locked].sort() : [];
  const sheetPlan = esm2SheetPlan(segmentsAfter, term, sheets, {
    ...planContext,
    scope: paperScope,
    ...(input.correction
      ? { unlockWaybillIds: input.unlockWaybillIds, correction: { allowed: true as const } }
      : {}),
  });
  const preview = await assignmentPaperPreviewOf(tx, sheetPlan, sheets, input.numbers);
  const planIssues = await assignmentPlanIssues(tx, {
    requestId: request.id,
    issue: preview.issue,
  });

  // Gaps in the command's own range only: earlier blockers belong to other decisions, and this
  // door is not obliged to repair them (R26, materialized → materialized).
  const ownRange = mutableRangesOf(term, sheets, asOf)
    .map((part) => ({ from: part.from > d ? part.from : d, to: part.to < last ? part.to : last }))
    .filter((part) => part.from <= part.to);
  const requiredAnchors = requiredAnchorsOf(
    { id: request.id, num: request.num },
    segmentsAfter,
    term,
    ownershipByVehicle,
    ownRange,
  );

  return {
    effects,
    preview,
    issues: planIssues.issues,
    requiredUnlockIds,
    requiredAnchors,
    apply: apply({
      sheetPlan,
      paperScope,
      issuePreparations: planIssues.prepared,
    }),
  };
}

/**
 * Execute the planned reassignment: history rows, then paper, then readiness.
 *
 * The caller has saved the assignment (rates, route, lessor — the door's full path, R17) and bumped
 * the request version under its locks; `follow` then checks that the history tail is the saved
 * vehicle. A linear request returns `null`: its paper stays with the weekly sweep.
 */
export async function applyReassignHistory(
  tx: AssignmentCommandTx,
  params: {
    requestId: string;
    actor: { id: string };
    asOf: string;
    mode: AssignmentModeSnapshot;
    correctionId: string | null;
    reason: string;
    effects: AssignmentEffects | null;
    apply: ReassignHistoryApply;
    unlockWaybillIds: readonly string[];
    acknowledgements: Readonly<Record<string, string>> | undefined;
  },
): Promise<Esm2SyncResult | null> {
  const { apply } = params;
  // Planned rows become real first: the command addresses them by logical key (R10).
  await ensureCommandHistory(tx, { requestId: params.requestId, asOf: params.asOf });
  if (apply.mutations.length > 0) {
    const write = await applyAssignmentMutations(tx, {
      requestId: params.requestId,
      actorUserId: params.actor.id,
      correctionId: params.correctionId,
      mutations: apply.mutations,
      denormalization: { kind: 'follow' },
    });
    await assertAssignmentDenormalization(tx, write.denormalization);
  }

  let esm2: Esm2SyncResult | null = null;
  if (!apply.linear && params.effects) {
    esm2 =
      apply.paperScope.length === 0
        ? { cancelled: [], issued: [], trimmed: [] }
        : await applyAssignmentPaper(tx, {
            requestId: params.requestId,
            actor: params.actor,
            reason: params.reason,
            mode: params.mode,
            effects: params.effects,
            operationId: params.correctionId,
            sheetPlan: apply.sheetPlan,
            paperScope: apply.paperScope,
            sheets: apply.sheets,
            displayNumbers: apply.numbers,
            unlockWaybillIds: params.unlockWaybillIds,
            issues: apply.issuePreparations,
            acknowledgements: params.acknowledgements,
          });
    if (apply.paperScope.length > 0) {
      await assertAssignmentPaperConverged(tx, {
        requestId: params.requestId,
        asOf: params.asOf,
        segmentsAfter: apply.segmentsAfter,
        term: apply.term,
        ownershipByVehicle: apply.ownershipByVehicle,
        paperScope: apply.paperScope,
        unlockWaybillIds: params.unlockWaybillIds,
        needsCorrection: params.effects.needsCorrection,
      });
    }
  }
  await ensureAssignmentHistory(tx, { requestId: params.requestId, asOf: params.asOf });
  return esm2;
}
