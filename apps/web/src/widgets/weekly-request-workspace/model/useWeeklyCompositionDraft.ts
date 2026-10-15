import { useEffect, useState } from 'react';
import type { WeeklyVehicleRequestDto } from '@technic/contracts';
import { useLocalFormDraft } from '@shared/lib';
import type { WeeklyCompositionState } from './compositionState';
import type { WeeklyComposition } from './useWeeklyComposition';

export interface WeeklyCompositionPayload {
  baseVersion: number;
  state: WeeklyCompositionState;
  comment: string;
}

function parseWeeklyComposition(value: unknown): WeeklyCompositionPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<WeeklyCompositionPayload>;
  const state = payload.state;
  if (
    typeof payload.baseVersion !== 'number' ||
    !Number.isInteger(payload.baseVersion) ||
    !state ||
    !Array.isArray(state.rows) ||
    !Array.isArray(state.newRows) ||
    !state.decisions ||
    typeof state.decisions !== 'object' ||
    typeof payload.comment !== 'string'
  )
    return null;
  return payload as WeeklyCompositionPayload;
}

/** Preserve current server rows while recovering older unsaved decisions and additions. */
export function mergeComposition(
  current: WeeklyCompositionState,
  saved: WeeklyCompositionState,
): WeeklyCompositionState {
  const currentRows = new Map(current.rows.map((row) => [row.requestId, row]));
  const savedRows = saved.rows.map((row) => {
    const fresh = currentRows.get(row.requestId);
    currentRows.delete(row.requestId);
    return (
      fresh ?? {
        ...row,
        staleReason: 'Заказ изменился после сохранения черновика — проверьте строку',
      }
    );
  });
  const currentNew = new Map(current.newRows.map((row) => [row.itemId ?? row.key, row]));
  for (const row of saved.newRows) currentNew.set(row.itemId ?? row.key, row);
  return {
    rows: [...savedRows, ...currentRows.values()],
    decisions: { ...current.decisions, ...saved.decisions },
    newRows: [...currentNew.values()],
  };
}

export function useWeeklyCompositionDraft({
  request,
  ready,
  userId,
  composition,
}: {
  request: WeeklyVehicleRequestDto | undefined;
  ready: boolean;
  userId: string | null;
  composition: WeeklyComposition;
}) {
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const draft = useLocalFormDraft<WeeklyCompositionPayload>({
    userId,
    form: 'weekly-request-composition',
    read: () => ({
      baseVersion: composition.session.version ?? request?.version ?? 0,
      state: composition.snapshot,
      comment: composition.comment,
    }),
    parse: parseWeeklyComposition,
  });
  const { begin } = draft;
  const requestId = request?.id;
  useEffect(() => {
    if (!requestId || !ready) return;
    setReviewNeeded(false);
    begin(requestId);
  }, [requestId, ready, begin]);

  const restore = (candidate: (typeof draft.pending)[number]) => {
    const payload = draft.restore(candidate);
    const savedIds = payload.state.rows
      .map((row) => row.requestId)
      .sort()
      .join('|');
    const currentIds = composition.snapshot.rows
      .map((row) => row.requestId)
      .sort()
      .join('|');
    const changed =
      (!!request && payload.baseVersion !== request.version) || savedIds !== currentIds;
    composition.restore(
      changed ? mergeComposition(composition.snapshot, payload.state) : payload.state,
      payload.comment,
    );
    setReviewNeeded(changed);
  };

  return {
    ...draft,
    active: draft.active?.target === request?.id ? draft.active : null,
    restore,
    reviewNeeded,
    acknowledgeReview: () => setReviewNeeded(false),
  };
}
