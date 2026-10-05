import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  UpdateWeeklyRequestBody,
  VehicleClassificationDto,
  WeeklyItemCounts,
  WeeklySuggestionDto,
  WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyToday } from '@entities/weekly-request';
import {
  buildWeeklyCompositionState,
  emptyWeeklyNewRow,
  serializeWeeklyComposition,
  weeklyNewRowIssues,
  type WeeklyCompositionState,
  type WeeklyNewRow,
  type WeeklyOrderDecision,
  type WeeklyOrderRow,
} from './compositionState';

export interface WeeklyComposition {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
  setDecision: (requestId: string, patch: Partial<WeeklyOrderDecision>) => void;
  newRows: WeeklyNewRow[];
  addNewRow: () => void;
  updateNewRow: (key: string, patch: Partial<WeeklyNewRow>) => void;
  removeNewRow: (key: string) => void;
  comment: string;
  setComment: (value: string) => void;
  counts: WeeklyItemCounts;
  /** Orders without a decision may be submitted, but the action bar must disclose their count. */
  undecided: number;
  issues: Map<string, string>;
  items: UpdateWeeklyRequestBody['items'];
  dirty: boolean;
}

const EMPTY_COMPOSITION: WeeklyCompositionState = { rows: [], decisions: {}, newRows: [] };

/**
 * Own the editable composition and a default-free server snapshot. Rebuild only after the request
 * version or suggestion membership changes; an ordinary render must never erase user edits.
 */
export function useWeeklyComposition(
  request: WeeklyVehicleRequestDto | undefined,
  suggestion: WeeklySuggestionDto | undefined,
  classifications: Map<string, VehicleClassificationDto>,
  /** Wait for the suggestion so saved rows are not briefly and incorrectly marked stale. */
  ready: boolean,
): WeeklyComposition {
  const [state, setState] = useState<WeeklyCompositionState>(EMPTY_COMPOSITION);
  const [initial, setInitial] = useState<WeeklyCompositionState>(EMPTY_COMPOSITION);
  const [comment, setComment] = useState('');
  const sourceKey = request
    ? `${request.id}:${request.version}:${(suggestion?.extend ?? [])
        .concat(suggestion?.leaving ?? [])
        .map((order) => order.requestId)
        .join(',')}`
    : '';
  const builtKey = useRef('');

  useEffect(() => {
    if (!request || !ready || builtKey.current === sourceKey) return;
    builtKey.current = sourceKey;
    setState(buildWeeklyCompositionState(request, suggestion, true));
    setInitial(buildWeeklyCompositionState(request, suggestion, false));
    setComment(request.comment);
  }, [request, suggestion, sourceKey, ready]);

  const items = useMemo(
    () => serializeWeeklyComposition(state, classifications),
    [state, classifications],
  );
  const savedItems = useMemo(
    () => serializeWeeklyComposition(initial, classifications),
    [initial, classifications],
  );
  const counts: WeeklyItemCounts = {
    extend: items.filter((item) => item.kind === 'extend').length,
    new: items.filter((item) => item.kind === 'new').length,
    leave: items.filter((item) => item.kind === 'leave').length,
  };

  return {
    ...state,
    setDecision: (requestId, patch) =>
      setState((previous) => ({
        ...previous,
        decisions: {
          ...previous.decisions,
          [requestId]: { ...previous.decisions[requestId]!, ...patch },
        },
      })),
    addNewRow: () =>
      setState((previous) => ({
        ...previous,
        newRows: [
          ...previous.newRows,
          emptyWeeklyNewRow(request?.weekStart ?? '', request?.weekEnd ?? ''),
        ],
      })),
    updateNewRow: (key, patch) =>
      setState((previous) => ({
        ...previous,
        newRows: previous.newRows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      })),
    removeNewRow: (key) =>
      setState((previous) => ({
        ...previous,
        newRows: previous.newRows.filter((row) => row.key !== key),
      })),
    comment,
    setComment,
    counts,
    undecided: state.rows.filter((row) => !state.decisions[row.requestId]?.kind).length,
    issues: request
      ? weeklyNewRowIssues(state.newRows, request, classifications, weeklyToday())
      : new Map<string, string>(),
    items,
    // Compare serialized commands, not transient controls, so toggling back is clean again.
    dirty:
      JSON.stringify(items) !== JSON.stringify(savedItems) ||
      (request ? comment !== request.comment : false),
  };
}
