import {
  type AnnulWeeklyRequestInput,
  BACKDATE_PERMISSION_MESSAGE,
  can,
  minRequestDateKey,
  moscowDateKeyOf,
  weeklyItemHadEffect,
  type WeeklyAnnulPreviewDto,
  type WeeklyReversalResultDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { writeAudit } from '../lib/audit';
import {
  assertWeeklyRequestScope,
  managesWeeklyRequestObject,
  seesWholeWeeklyRequest,
} from '../lib/access';
import { err } from '../lib/errors';
import type { Principal } from '../auth/principal';
import {
  backdateAccessOf,
  backdateOrThrow,
  checkBackdate,
  findCorrection,
  linkCorrectionRequests,
  runCorrection,
} from './waybill-correction';
import { assertWeeklyRequestReadable } from './weekly-request-access';
import {
  assertReversalOperation,
  openReversalDoor,
  planWeeklyAnnul,
  weeklyReversalPreviewDto,
  type WeeklyReversalSpec,
} from './weekly-request-annul';

/**
 * The two halves of a reversal command over an applied week — the preview and the execution —
 * shared by annulment (ADR 0218) and the return for re-approval (ADR 0219).
 *
 * They used to live inline in the annulment route. The return runs exactly the same sequence —
 * branch by the unlocked plan, right, scope, locked plan, header, blockers, fingerprints, journal
 * operation, audit — and a second copy of it would be the worst thing to do here: the two branches
 * of one command already differ in a single point (is there a journal row), and two commands
 * differing in a dozen copied checks would drift at the first fix.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The preview: the same work by the same functions, without a single write.
 *
 * No locks are taken (ADR 0211 decision 1): `FOR UPDATE` for the time of viewing would stop the
 * dispatchers' work for the sake of "what if", and the command is protected by the fingerprint,
 * not by a lock. It still reads inside a transaction: the plan asks the history, sheets, shifts and
 * routes in a dozen reads, and under `READ COMMITTED` each would take its own snapshot — the
 * fingerprint would describe a state that never existed at any moment.
 */
export async function previewWeeklyReversal(
  p: Principal,
  weeklyId: string,
  spec: WeeklyReversalSpec,
): Promise<WeeklyAnnulPreviewDto> {
  await assertWeeklyRequestReadable(p, weeklyId);
  /*
   * The plan lists every row with its order number, the pending weeks of the same orders and the
   * titles of cancelled decisions. A lessor reads the week narrowed to their own rows (the card and
   * the history are trimmed for them), and this answer would hand over the site's whole fleet next
   * to them. A lessor never runs a reversal, so there is nothing for them to explain here either.
   */
  if (!seesWholeWeeklyRequest(p)) {
    throw err.forbidden('Предпросмотр разворота недели арендодателю не открывается');
  }
  // One moment for the whole answer: midnight between two `new Date()` calls would give the window
  // today from one boundary and yesterday from the other.
  const now = new Date();
  const today = moscowDateKeyOf(now);
  const access = backdateAccessOf(p);
  const plan = await db.transaction(async (tx) =>
    planWeeklyAnnul(tx, { weeklyId, asOf: today, locked: false }),
  );
  /*
   * Depth is asked by the same `checkBackdate` the command will ask, with a reason assumed present:
   * the question here is not "is the explanation sufficient" (the person has not written it yet)
   * but "will the operation pass in the past". The right is not part of this verdict — the DTO names
   * it in its own order of reasons.
   */
  const verdict =
    plan.effectiveDate === null
      ? null
      : checkBackdate({ effectiveDate: plan.effectiveDate, today, subject: p, hasReason: true });
  return weeklyReversalPreviewDto(plan, spec, {
    subject: p,
    canReadWaybills: can(p, 'waybills.read'),
    inSiteScope: managesWeeklyRequestObject(p, plan.header.objectId),
    // Same rule as the lower bound of the date picker: `null` for a right without a limit, and an
    // invented "very old year" would lock what the server accepts.
    correctionFloor: minRequestDateKey(now, access),
    depthRefusal: verdict && !verdict.ok ? verdict.reason : null,
  });
}

/**
 * Run the command: authorize by branch, re-plan under locks, check and execute.
 *
 * WHY THE PLAN IS COMPUTED TWICE. First without locks, before the transaction: it chooses the
 * branch and refuses whoever this command does not belong to at all — before the command starts
 * waiting on locks of orders that may not be theirs. Second under locks inside the transaction, and
 * that one is executed. If they diverge, the fingerprint will not match and the person goes back to
 * the recomputed list (409); otherwise the choice of branch would depend on what changed between
 * the read and the write.
 */
export async function runWeeklyReversal(
  p: Principal,
  weeklyId: string,
  body: AnnulWeeklyRequestInput,
  spec: WeeklyReversalSpec,
): Promise<WeeklyReversalResultDto> {
  await assertWeeklyRequestReadable(p, weeklyId);
  const today = moscowDateKeyOf(new Date());
  const unlockWaybillIds = body.correction?.unlockWaybillIds ?? [];

  const draft = await planWeeklyAnnul(db, {
    weeklyId,
    asOf: today,
    locked: false,
    unlockWaybillIds,
  });
  if (!spec.canRun(p, draft.backdated)) throw err.forbidden(spec.rightRefusal(draft.backdated));
  // The site scope is asked only where the right came with the site approval: `waybills.correct`
  // has no scope at all — a dispatcher has no sites.
  if (spec.needsSiteScope(p, draft.backdated)) assertWeeklyRequestScope(p, draft.header.objectId);

  /** Checks and execution under locks — one body for both branches. */
  const reverseInTx = async (tx: Tx, correctionId: string | null) => {
    // Mode gate — the first query of the transaction (Zh3): not for its value, but so that a freeze
    // waits for this transaction and this transaction does not slip past the freeze.
    const mode = await openReversalDoor(tx);
    const plan = await planWeeklyAnnul(tx, {
      weeklyId,
      asOf: today,
      locked: true,
      unlockWaybillIds,
    });
    const headerBlocker = spec.headerBlocker(plan.header);
    if (headerBlocker) throw err.unprocessable(headerBlocker);
    if (plan.header.version !== body.version) throw err.conflict();

    // Blockers as a full list and before the first write: the week is fixed in one pass, and a
    // refusal naming one row of four would send the person in circles.
    const blockedItems = plan.items.filter((item) => plan.states.get(item.id)?.state === 'blocked');
    if (blockedItems.length > 0 || plan.blockers.length > 0) {
      const reasons = [
        ...blockedItems.map((item) => plan.states.get(item.id)?.reason ?? ''),
        ...plan.blockers.map((blocker) => blocker.message),
      ].filter((text) => text !== '');
      throw err.unprocessable(`${spec.refusalLead}: ${reasons.join('; ')}`, {
        items: 'Есть строки, которые нельзя развернуть',
      });
    }
    // A document may be reversed even when nothing is left to reverse: its trace may have been
    // removed row by row (ADR 0218 decision 4). The refusal stays only for a week none of whose
    // rows was ever applied — such a document asserts nothing.
    if (!plan.items.some((item) => weeklyItemHadEffect(item.result))) {
      throw err.unprocessable(spec.nothingToReverse);
    }

    // Fingerprints under the locks and before the first write: consequences change between the
    // preview and the click without touching the header version (a sheet was issued for an order,
    // a shift draft appeared, the week became worked).
    if (plan.fingerprint !== body.fingerprint) {
      throw err.conflict('Последствия изменились с момента просмотра: посмотрите перечень заново');
    }
    if (plan.cancelGroupsFingerprint !== (body.cancelGroupsFingerprint ?? null)) {
      throw err.conflict(
        'Перечень гасимых решений изменился с момента просмотра: посмотрите его заново',
      );
    }
    // Whether an operation is needed is decided by the plan RECOMPUTED under the lock, not by the
    // chosen branch: midnight may have passed between the two plans, or a foreign edit moved the
    // first removed day into the past. A refusal is more honest than a silent run without a journal.
    assertReversalOperation(plan, body, spec.correctionRequired);
    if (!plan.requiresOperation && correctionId) {
      throw err.unprocessable(
        'Последствия изменились: операция журнала этой команде больше не нужна — посмотрите перечень заново',
      );
    }

    return spec.apply(tx, {
      plan,
      actor: p,
      reason: body.reason,
      mode,
      correctionId,
      acknowledgements: body.acknowledgements,
      unlockWaybillIds,
    });
  };

  let repeated = false;
  let result: WeeklyReversalResultDto | null = null;

  /*
   * A repeat of an operation already done is recognized BEFORE the branch is read from the state —
   * the approval route does the same (R31 ADR 0101). The first attempt takes the week out of
   * `applied`, so the unlocked plan of the repeat says "nothing to reverse, no operation needed",
   * and without this check a retry after a dropped connection would end in 422 on work its own
   * first request has done. A found key sends the command to `runCorrection`, which checks the
   * author and the fingerprint and returns the earlier outcome without calling `perform`.
   */
  const prior = body.correction ? await findCorrection(db, body.correction.operationId) : undefined;

  if (draft.requiresOperation || prior) {
    assertReversalOperation(draft, body, spec.correctionRequired);
    const correction = body.correction!;
    const done = await runCorrection(
      {
        operationId: correction.operationId,
        kind: spec.kind,
        // The target is the weekly request itself: the body is the same for two weeks of one site,
        // and without the id one key would cover two different commands.
        target: draft.header.id,
        body,
        reason: body.reason,
        actorUserId: p.id,
      },
      {
        /*
         * The right is asked on EVERY attempt, the repeat included: silently returning the earlier
         * result to someone whose right was revoked between attempts leaks as much as running the
         * operation without it. Depth stays checked by the first attempt: the second one does no
         * work, and recomputed tomorrow it would refuse a result already obtained.
         */
        authorize: () => {
          if (!spec.canRun(p, true)) throw err.forbidden(BACKDATE_PERMISSION_MESSAGE);
          return backdateOrThrow(
            checkBackdate({
              effectiveDate: draft.effectiveDate ?? today,
              today,
              subject: p,
              hasReason: body.reason.trim() !== '',
            }),
          );
        },
        perform: async (tx, record) => {
          const done = await reverseInTx(tx, record.id);
          result = done;
          await linkCorrectionRequests(tx, record.id, [
            ...done.shortened.map((row) => row.requestId),
            ...done.cancelled.map((row) => row.requestId),
          ]);
          // "Before → after" snapshot (R16 ADR 0101): the request keeps only row results, while
          // "what term did TS-341 have before the reversal" and "which numbers burnt" are asked
          // months later, with nothing else to answer them.
          return {
            weeklyRequest: { id: draft.header.id, num: draft.header.num },
            shortened: done.shortened,
            cancelled: done.cancelled,
            released: done.released,
            esm2: done.esm2,
            unlockWaybillIds: correction.unlockWaybillIds,
          };
        },
      },
    );
    repeated = done.repeated;
  } else {
    result = await db.transaction(async (tx) => reverseInTx(tx, null));
  }

  /*
   * A repeat after a dropped connection: `perform` was not called and has no result of its own, so
   * the answer is rebuilt from the current state, as conducting does. A snapshot of the DTO would
   * rot at the first contract change, and a repeat must answer what a new request would answer.
   */
  const outcome: WeeklyReversalResultDto = result ?? {
    weeklyRequestId: draft.header.id,
    status: spec.kind === 'weekly_annul' ? 'annulled' : 'pending',
    shortened: [],
    cancelled: [],
    released: 0,
    esm2: { cancelled: 0, issued: 0 },
  };

  // Audit on top and in addition: the week history is written in the same transaction (ADR 0085
  // item 16), while `writeAudit` does not fail the operation on a write error by design.
  await writeAudit({
    actorUserId: p.id,
    action: spec.auditAction,
    entityType: 'weekly_vehicle_request',
    entityId: weeklyId,
    metadata: {
      reason: body.reason,
      shortened: outcome.shortened,
      cancelled: outcome.cancelled,
      released: outcome.released,
      esm2: outcome.esm2,
      ...(repeated ? { repeated: true } : {}),
    },
  });
  return outcome;
}
