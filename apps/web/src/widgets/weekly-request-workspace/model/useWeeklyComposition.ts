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
  /** Why a new row is unfit: row key -> text. */
  issues: Map<string, string>;
  items: UpdateWeeklyRequestBody['items'];
  dirty: boolean;
}

const EMPTY_COMPOSITION: WeeklyCompositionState = { rows: [], decisions: {}, newRows: [] };

/**
 * The composition in page state. Rebuilt when the request version changes (composition saved,
 * applied, rejected) or the suggestion membership changes: then the screen must show what lies on
 * the server. An ordinary re-render never touches the user's edits.
 */
export function useWeeklyComposition(
  request: WeeklyVehicleRequestDto | undefined,
  suggestion: WeeklySuggestionDto | undefined,
  classifications: Map<string, VehicleClassificationDto>,
  /**
   * Whether the suggestion has arrived. Building before it is not allowed: saved rows would be
   * "lost" for a second, and an edit started in that second would be wiped by the rebuild.
   */
  ready: boolean,
): WeeklyComposition {
  const [state, setState] = useState<WeeklyCompositionState>(EMPTY_COMPOSITION);
  // The server composition without defaults, kept in state: a snapshot taken before the
  // classifier loaded would lose the new rows.
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
    // Unsaved changes compare what will be sent to the server, not form state: toggling a decision
    // there and back must not count as an edit.
    dirty:
      JSON.stringify(items) !== JSON.stringify(savedItems) ||
      (request ? comment !== request.comment : false),
  };
}
