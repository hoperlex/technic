import { useCallback, useState } from 'react';
import type { FormInstance } from 'antd';
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
}

export interface DraftStatus {
  savedAt: number | null;
  available: boolean;
}

/** The draft is a device-local snapshot; writes are checked because quota and private mode can fail. */
export function useVehicleRequestLocalDraft(form: FormInstance<FormValues>, userId: string | null) {
  const [active, setActive] = useState<ActiveDraft | null>(null);
  const [pending, setPending] = useState<VehicleRequestLocalDraft[]>([]);
  const [status, setStatus] = useState<DraftStatus>({ savedAt: null, available: true });

  const begin = (target: DraftTarget, baseVersion: number | null, operationId: string) => {
    if (!userId) {
      setActive(null);
      setPending([]);
      setStatus({ savedAt: null, available: false });
      return;
    }
    const found = listLocalDrafts(userId, target);
    setPending(found.drafts);
    setActive(
      found.drafts.length ? null : { id: newDraftId(), userId, target, baseVersion, operationId },
    );
    setStatus({ savedAt: null, available: found.available });
  };

  const persist = useCallback((): boolean => {
    if (!active) return false;
    const savedAt = Date.now();
    const ok = writeLocalDraft({
      ...active,
      schema: 1,
      savedAt,
      values: draftValues(form.getFieldsValue(true)),
    });
    setStatus({ savedAt: ok ? savedAt : null, available: ok });
    return ok;
  }, [active, form]);

  const discardPending = (operationId: string) => {
    const context = pending[0];
    if (!context) return;
    const removed = pending.map((candidate) => removeLocalDraft(candidate.id)).every(Boolean);
    setPending([]);
    setActive({
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
    };
    const savedAt = Date.now();
    const ok = writeLocalDraft({ ...next, schema: 1, savedAt, values: draftValues(values) });
    // The source may still belong to another live tab. A fork must not erase its only recovery
    // point; the user can remove the older snapshot from the next restoration prompt.
    setActive(next);
    setPending([]);
    setStatus({ savedAt: ok ? savedAt : null, available: ok });
    return values;
  };

  const clear = () => {
    if (active) removeLocalDraft(active.id);
    setActive(null);
    setPending([]);
    setStatus({ savedAt: null, available: true });
  };

  return { active, begin, clear, discardPending, pending, persist, restore, status };
}
