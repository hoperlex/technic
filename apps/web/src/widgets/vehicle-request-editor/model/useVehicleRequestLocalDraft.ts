import { useCallback, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import type { CreateVehicleRequestInput } from '@technic/contracts';
import { LocalCreateAttemptError, newIdempotencyKey } from '@shared/lib';
import {
  draftValues,
  listLocalDrafts,
  newDraftId,
  removeLocalDraft,
  restoreDraftValues,
  writeLocalDraft,
  type DraftTarget,
  type FormValues,
  type VehicleRequestLocalDraft,
} from '@features/vehicle-request-editor';

export interface ActiveDraft {
  id: string;
  userId: string;
  target: DraftTarget;
  baseVersion: number | null;
  operationId: string;
  createAttempt?: { key: string; body: CreateVehicleRequestInput };
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
    const key = current.createAttempt?.key ?? newIdempotencyKey();
    const submittedBody = current.createAttempt?.body ?? body;
    const next = { ...current, createAttempt: { key, body: submittedBody } };
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
    return { body: submittedBody, key };
  };

  const discardPending = (operationId: string) => {
    const context = pending[0];
    if (!context) return;
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
    if (activeRef.current) removeLocalDraft(activeRef.current.id);
    activate(null);
    setPending([]);
    setStatus({ savedAt: null, available: true });
  };

  return {
    active,
    begin,
    clear,
    discardPending,
    pending,
    persist,
    prepareCreate,
    restore,
    status,
  };
}
