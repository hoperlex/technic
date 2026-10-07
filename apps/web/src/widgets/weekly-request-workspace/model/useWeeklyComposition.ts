import { useMemo, useState } from 'react';
import type {
  UpdateWeeklyRequestBody,
  VehicleClassificationDto,
  WeeklyItemCounts,
  WeeklySuggestionDto,
  WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyToday } from '@entities/weekly-request';
import { useRecordSession, type RecordSession } from '@shared/lib';
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
  /**
   * The request version the composition was built from — the one every command of the page sends,
   * moved by the page's own answers (`accept`); `stale` and `reload` drive the notice.
   */
  session: RecordSession<number>;
}

interface Source {
  request: WeeklyVehicleRequestDto;
  suggestion: WeeklySuggestionDto | undefined;
}

const EMPTY_COMPOSITION: WeeklyCompositionState = { rows: [], decisions: {}, newRows: [] };

/**
 * The composition in page state, built per page session (stage 5 plan §4.5, group R1): when the
 * request and the suggestion are both there, and anew for another request.
 *
 * A newer source — another request version or another suggestion membership — rebuilds an
 * untouched composition silently, since the screen must show what lies on the server. Over the
 * dispatcher's edits it only raises the notice: before, a colleague's save or a refreshed site slice
 * rebuilt the composition and wiped the work. The page's own commands move the snapshot version
 * with their answers and rebuild from what they saved.
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
  // The comment as built, not the live one: a colleague's new comment is not the person's edit.
  const [initialComment, setInitialComment] = useState('');
  const items = useMemo(
    () => serializeWeeklyComposition(state, classifications),
    [state, classifications],
  );
  const savedItems = useMemo(
    () => serializeWeeklyComposition(initial, classifications),
    [initial, classifications],
  );
  // Unsaved changes compare what will be sent to the server, not form state: toggling a decision
  // there and back must not count as an edit.
  const dirty = JSON.stringify(items) !== JSON.stringify(savedItems) || comment !== initialComment;

  const session = useRecordSession<Source>({
    open: true,
    id: request?.id ?? null,
    data: request && ready ? { request, suggestion } : undefined,
    version: (source) => source.request.version,
    revision: (source) =>
      `${source.request.version}:${(source.suggestion?.extend ?? [])
        .concat(source.suggestion?.leaving ?? [])
        .map((order) => order.requestId)
        .join(',')}`,
    isDirty: () => dirty,
    fill: (source) => {
      setState(buildWeeklyCompositionState(source.request, source.suggestion, true));
      setInitial(buildWeeklyCompositionState(source.request, source.suggestion, false));
      setComment(source.request.comment);
      setInitialComment(source.request.comment);
    },
  });

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
    dirty,
    session,
  };
}
