import { useCallback, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import type { CreateVehicleRequestInput } from '@technic/contracts';
import { LocalCreateAttemptError, newIdempotencyKey } from '@shared/lib';
import {
  draftValues,
  isBackdatedCreateAttempt,
  isLegacyOrdinaryCreateAttempt,
  listLocalDrafts,
  newDraftId,
  removeLocalDraft,
  restoreDraftValues,
  writeLocalDraft,
  type DraftTarget,
  type FormValues,
  type VehicleCreateAttempt,
  type VehicleCreateProtocol,
  type VehicleRequestLocalDraft,
} from '@features/vehicle-request-editor';

export interface ActiveDraft {
  id: string;
  userId: string;
  target: DraftTarget;
  baseVersion: number | null;
  operationId: string;
  createAttempt?: VehicleCreateAttempt;
  nextCreateKey?: string;
  previousCreateKeys?: string[];
}

export interface DraftStatus {
  savedAt: number | null;
  available: boolean;
}

/** The draft is a device-local snapshot; writes are checked because quota and private mode can fail. */
export function useVehicleRequestLocalDraft(form: FormInstance<FormValues>, userId: string | null) {
  const [active, setActive] = useState<ActiveDraft | null>(null);
  const activeRef = useRef<ActiveDraft | null>(null);
  const activate = (next: ActiveDraft | null) => {
    activeRef.current = next;
    setActive(next);
  };
  const [pending, setPending] = useState<VehicleRequestLocalDraft[]>([]);
  const [status, setStatus] = useState<DraftStatus>({ savedAt: null, available: true });

  const begin = (target: DraftTarget, baseVersion: number | null, operationId: string) => {
    if (!userId) {
      activate(null);
      setPending([]);
      setStatus({ savedAt: null, available: false });
      return;
    }
    const found = listLocalDrafts(userId, target);
    setPending(found.drafts);
    activate(
      found.drafts.length ? null : { id: newDraftId(), userId, target, baseVersion, operationId },
    );
    setStatus({ savedAt: null, available: found.available });
  };

  const persist = useCallback((): boolean => {
    const current = activeRef.current;
    if (!current) return false;
    const savedAt = Date.now();
    const ok = writeLocalDraft({
      ...current,
      schema: 1,
      savedAt,
      values: draftValues(form.getFieldsValue(true)),
    });
    setStatus({ savedAt: ok ? savedAt : null, available: ok });
    return ok;
  }, [form]);

  // A later 422 may race with the original POST, so retries always keep its first body and key.
  const prepareCreate = (body: CreateVehicleRequestInput) => {
    const current = activeRef.current;
    if (!current) throw new LocalCreateAttemptError('Черновик недоступен — откройте форму заново');
    const frozen = current.createAttempt;
    // An unmarked ordinary attempt may have reached an old API that ignored its header. The new
    // barrier cannot prove that old request absent, so it must never claim this key as its own.
    if (isLegacyOrdinaryCreateAttempt(frozen)) {
      throw new LocalCreateAttemptError(
        `Старая попытка ${frozen.key} требует ручной проверки заявки; повтор через новую сверку недоступен.`,
      );
    }
    const protocol: VehicleCreateProtocol =
      frozen?.protocol ??
      (frozen?.body.operationId ||
      frozen?.body.backdateReason ||
      body.operationId ||
      body.backdateReason
        ? 'correction-v1'
        : 'receipt-v1');
    const key = frozen?.key ?? current.nextCreateKey ?? newIdempotencyKey();
    // Keep a private JSON-shaped snapshot: form trip rows and file IDs can still be mutated by
    // callers, while the stored draft and the request must describe the same first command.
    const submittedBody: CreateVehicleRequestInput =
      frozen?.body ?? JSON.parse(JSON.stringify(body));
    const next = {
      ...current,
      createAttempt: { key, body: submittedBody, protocol },
      nextCreateKey: undefined,
    };
    const savedAt = Date.now();
    const ok = writeLocalDraft({
      ...next,
      schema: 1,
      savedAt,
      values: draftValues(form.getFieldsValue(true)),
    });
    if (!ok) {
      setStatus({ savedAt: null, available: false });
      throw new LocalCreateAttemptError(
        'Не удалось сохранить попытку создания на устройстве. Освободите место и повторите.',
      );
    }
    activate(next);
    setStatus({ savedAt, available: true });
    return {
      body: JSON.parse(JSON.stringify(submittedBody)) as CreateVehicleRequestInput,
      key,
      protocol,
    };
  };

  const acceptNotCreated = (originalKey: string, nextKey: string) => {
    const current = activeRef.current;
    if (
      current?.createAttempt?.key !== originalKey ||
      current.createAttempt.protocol !== 'receipt-v1'
    )
      return 'stale' as const;
    const savedAt = Date.now();
    // One localStorage value changes from frozen original body to a server-minted replacement key.
    // A failed write leaves both the original body and key intact for another reconciliation.
    const next = {
      ...current,
      createAttempt: undefined,
      nextCreateKey: nextKey,
      previousCreateKeys: [...new Set([...(current.previousCreateKeys ?? []), originalKey])],
    };
    if (
      !writeLocalDraft({
        ...next,
        schema: 1,
        savedAt,
        values: draftValues(form.getFieldsValue(true)),
      })
    ) {
      setStatus({ savedAt: null, available: false });
      return 'storage-error' as const;
    }
    activate(next);
    setStatus({ savedAt, available: true });
    return 'resolved' as const;
  };

  const resetBackdatedAttempt = (originalKey: string, operationId: string, nextKey: string) => {
    const current = activeRef.current;
    if (
      current?.createAttempt?.key !== originalKey ||
      !isBackdatedCreateAttempt(current.createAttempt)
    )
      return 'stale' as const;
    const savedAt = Date.now();
    // The correction journal cannot prove absence of a late first POST. After explicit consent,
    // one write keeps the visible form while changing both identities for a deliberate new command.
    const next = {
      ...current,
      operationId,
      createAttempt: undefined,
      nextCreateKey: nextKey,
      previousCreateKeys: [...new Set([...(current.previousCreateKeys ?? []), originalKey])],
    };
    if (
      !writeLocalDraft({
        ...next,
        schema: 1,
        savedAt,
        values: draftValues(form.getFieldsValue(true)),
      })
    ) {
      setStatus({ savedAt: null, available: false });
      return 'storage-error' as const;
    }
    activate(next);
    setStatus({ savedAt, available: true });
    return 'resolved' as const;
  };

  const resetLegacyOrdinaryAttempt = (originalKey: string, nextKey: string) => {
    const current = activeRef.current;
    if (
      current?.createAttempt?.key !== originalKey ||
      !isLegacyOrdinaryCreateAttempt(current.createAttempt)
    )
      return 'stale' as const;
    const savedAt = Date.now();
    // A root-route request might still commit. Only an explicit operator decision retires its
    // local key; the first body remains in sibling envelopes until confirmed creation cleans up.
    const next = {
      ...current,
      createAttempt: undefined,
      nextCreateKey: nextKey,
      previousCreateKeys: [...new Set([...(current.previousCreateKeys ?? []), originalKey])],
    };
    if (
      !writeLocalDraft({
        ...next,
        schema: 1,
        savedAt,
        values: draftValues(form.getFieldsValue(true)),
      })
    ) {
      setStatus({ savedAt: null, available: false });
      return 'storage-error' as const;
    }
    activate(next);
    setStatus({ savedAt, available: true });
    return 'resolved' as const;
  };

  const discardPending = (operationId: string) => {
    const context = pending[0];
    if (!context || pending.some((candidate) => !!candidate.createAttempt)) return;
    const removed = pending.map((candidate) => removeLocalDraft(candidate.id)).every(Boolean);
    setPending([]);
    activate({
      id: newDraftId(),
      userId: context.userId,
      target: context.target,
      baseVersion: context.baseVersion,
      operationId,
    });
    setStatus({ savedAt: null, available: removed });
  };

  const restore = (candidate: VehicleRequestLocalDraft, baseVersion: number | null) => {
    const values = restoreDraftValues(candidate.values);
    const next: ActiveDraft = {
      id: newDraftId(),
      userId: candidate.userId,
      target: candidate.target,
      baseVersion,
      operationId: candidate.operationId,
      createAttempt: candidate.createAttempt,
      nextCreateKey: candidate.nextCreateKey,
      previousCreateKeys: candidate.previousCreateKeys,
    };
    const savedAt = Date.now();
    const ok = writeLocalDraft({ ...next, schema: 1, savedAt, values: draftValues(values) });
    // The source may still belong to another live tab. A fork must not erase its only recovery
    // point; the user can remove the older snapshot from the next restoration prompt.
    activate(next);
    setPending([]);
    setStatus({ savedAt: ok ? savedAt : null, available: ok });
    return values;
  };

  const clear = () => {
    const current = activeRef.current;
    if (current) {
      // Restoring forks the envelope so another live tab cannot lose its recovery point. Once the
      // server confirms creation, every local fork of that same command must be removed or the
      // original will resurface as an unresolvable attempted draft on the next opening.
      const keys = new Set([
        ...(current.previousCreateKeys ?? []),
        ...(current.createAttempt ? [current.createAttempt.key] : []),
      ]);
      const siblings = keys.size
        ? listLocalDrafts(current.userId, current.target)
        : { drafts: [], available: true };
      if (!siblings.available) {
        setStatus({ savedAt: null, available: false });
        return false;
      }
      const relatedIds = siblings.drafts
        .filter(
          (draft) =>
            draft.id !== current.id &&
            ((!!draft.createAttempt && keys.has(draft.createAttempt.key)) ||
              (!!draft.nextCreateKey && keys.has(draft.nextCreateKey)) ||
              !!draft.previousCreateKeys?.some((key) => keys.has(key))),
        )
        .map((draft) => draft.id);
      for (const id of [...relatedIds, current.id]) {
        if (removeLocalDraft(id)) continue;
        setStatus({ savedAt: null, available: false });
        return false;
      }
    }
    activate(null);
    setPending([]);
    setStatus({ savedAt: null, available: true });
    return true;
  };

  return {
    active,
    begin,
    clear,
    discardPending,
    pending,
    persist,
    prepareCreate,
    acceptNotCreated,
    resetBackdatedAttempt,
    resetLegacyOrdinaryAttempt,
    restore,
    status,
  };
}
