import { useEffect, useState } from 'react';
import { App } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  isWeeklyRequestApplied,
  isWeeklyRequestEditable,
  type WeeklyCorrectionBody,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { waybillKeys } from '@entities/waybill';
import {
  weeklyBackdateAccess,
  weeklyRequestErrorMessage,
  weeklyRequestKeys,
  weeklyRequestsApi,
  weeklySkipReasonsFromError,
} from '@entities/weekly-request';
import { useVehicleClassifications } from '@entities/vehicle-type';
import { useWeeklyRequestCreate } from '@features/weekly-request-create';
import { useWeeklyComposition } from './useWeeklyComposition';
import { useWeeklyReversal } from './useWeeklyReversal';
import { hasApiStatus } from './apiError';
import {
  decisionMessage,
  lastRejectionComment,
  lastReturn,
  WEEKLY_LEAVE_CONFIRM,
  weeklyPageWeekState,
} from './pageState';

/**
 * Weekly request page state: composition assembly and the applied week's card (section 5 steps
 * 1-6). Queries, mutations and navigation live here; the view only composes UI blocks.
 *
 * A separate page with an address rather than a modal: three composition blocks, history and
 * documents do not fit a modal, and a link to the week must be shareable.
 *
 * An overdue week shows THREE different states, all computed by contracts rather than page
 * expressions (ADR 0101): a future week as before; an overdue one for someone allowed to conduct
 * the past, open, with the operation price in the banner and the conduct window; an overdue one for
 * someone who is not, closed but not a dead end: the banner names whom to call. A second list of
 * these rules on the client would offer a button the endpoint refuses or lock what it accepts.
 */
export function useWeeklyRequestWorkspace() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  // What the account may do retroactively: this pair opens the week or keeps it closed.
  const backdate = weeklyBackdateAccess(can);
  const create = useWeeklyRequestCreate();
  // Per-row apply refusal reasons (section 9): kept until the next attempt.
  const [skipReasons, setSkipReasons] = useState<Map<string, string>>(new Map());
  // Whole-apply refusal: "no row is applicable" with the list of reasons (R9).
  const [applyError, setApplyError] = useState<string | null>(null);
  const [reasonMode, setReasonMode] = useState<'cancel' | 'reject' | null>(null);
  // The window conducting an overdue week retroactively is open (ADR 0101).
  const [conducting, setConducting] = useState(false);

  const requestQuery = useQuery({
    queryKey: weeklyRequestKeys.detail(id),
    queryFn: () => weeklyRequestsApi.get(id),
    enabled: !!id,
    // A vanished request is not refetched: 404 here is an answer, not a connection failure (section
    // 9).
    retry: false,
  });
  const request = requestQuery.data;
  const status = request?.status;
  const composable = !!request && isWeeklyRequestEditable(request.status);
  const editable = composable && can('weeklyRequests.update');
  // The suggestion is asked only where the composition is still assembled: an applied request's
  // composition is frozen, and today's site slice has nothing to do with it.
  const suggestionEnabled = composable && can('weeklyRequests.create');
  const suggestionQuery = useQuery({
    queryKey: weeklyRequestKeys.suggestion(request?.objectId, request?.weekStart),
    queryFn: () =>
      weeklyRequestsApi.suggestion({
        objectId: request!.objectId,
        weekStart: request!.weekStart,
      }),
    enabled: suggestionEnabled,
    // The site slice is not recomputed by itself during assembly, otherwise a background refresh
    // would wipe the person's edits. That the composition may be stale is said by the apply
    // refusal (R14).
    staleTime: 5 * 60_000,
  });
  // The checklist lives on for an annulled week too: its rows explain what was rolled back
  // (ADR 0218), and they are shown read-only.
  const documentsQuery = useQuery({
    queryKey: weeklyRequestKeys.documents(id),
    queryFn: () => weeklyRequestsApi.documents(id),
    enabled: !!id && !!status && isWeeklyRequestApplied(status),
  });
  const historyQuery = useQuery({
    queryKey: weeklyRequestKeys.history(id),
    queryFn: () => weeklyRequestsApi.history(id),
    enabled: !!id,
  });
  const classifications = useVehicleClassifications();
  const composition = useWeeklyComposition(
    request,
    suggestionQuery.data,
    classifications.byKey,
    !suggestionEnabled || suggestionQuery.isFetched,
  );

  /*
   * Unsaved changes on leaving the page (section 9). Closing the browser tab and the "Back to list"
   * button are intercepted; the portal has no general navigation blocker because useBlocker works
   * only in a data router, and the app runs on BrowserRouter.
   */
  useEffect(() => {
    if (!composition.dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [composition.dirty]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.root });
    // Applying moves order terms and creates new orders, so the vehicle request list is stale too.
    // Extending a term reissues the order's ESM-2 (extendSpecialEquipmentPeriod ->
    // syncEsm2Waybills), so the waybill journal and garage occupancy are stale after approval.
    void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
    void queryClient.invalidateQueries({ queryKey: garageKeys.root });
  };
  // A successful action clears the previous refusal's explanations: they were about the old
  // composition.
  const clearApplyError = () => {
    setApplyError(null);
    setSkipReasons(new Map());
  };
  /** Done and recorded: last refusal's explanations are moot and the related feeds are stale. */
  const settled = () => {
    clearApplyError();
    invalidate();
  };
  const onError = (error: unknown) => {
    if (hasApiStatus(error, 409)) {
      void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.root });
      message.error('Состав изменил другой пользователь — страница обновлена');
      return;
    }
    if (hasApiStatus(error, 422) && request) {
      // The server lists reasons in the message itself and per row where it can name them as
      // fields. Both are taken: the banner explains the whole refusal, rows say what to fix.
      setApplyError(weeklyRequestErrorMessage(error));
      const reasons = weeklySkipReasonsFromError(error, request.items);
      if (reasons.size > 0) setSkipReasons(reasons);
      // The site slice is reread: a row whose order was cancelled or closed gets its own reason in
      // the composition, so nobody has to reconcile the list with the table by eye.
      void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.suggestions() });
    }
    message.error(weeklyRequestErrorMessage(error));
  };

  // The composition is sent whole; version is a lock token, not a column value.
  const saveComposition = async () => {
    if (!request) throw new Error('Заявка не загружена');
    if (!composition.dirty) return request;
    return weeklyRequestsApi.update(request.id, {
      items: composition.items,
      comment: composition.comment,
      version: request.version,
    });
  };
  /**
   * Reversals of an applied week — annulment (ADR 0218) and return for re-approval (ADR 0219) — in
   * their own module: the workspace is dense enough, and both share the engine and the window.
   */
  const annul = useWeeklyReversal({ intent: 'annul', request, onSettled: settled, onError });
  const returning = useWeeklyReversal({ intent: 'return', request, onSettled: settled, onError });

  const saveMutation = useMutation({
    mutationFn: saveComposition,
    onSuccess: () => {
      clearApplyError();
      message.success('Состав сохранён');
      invalidate();
    },
    onError,
  });
  // Submitting saves the composition in the same move: submitting one thing and approving another
  // is the worst that can happen to a document whose approval applies terms (R6).
  const submitMutation = useMutation({
    mutationFn: async () => {
      const saved = await saveComposition();
      return weeklyRequestsApi.changeStatus(saved.id, {
        status: 'pending',
        version: saved.version,
      });
    },
    onSuccess: (result) => {
      clearApplyError();
      message.success(
        result.apply ? `Неделя применена: строк ${result.apply.applied}` : 'Заявка подана на визу',
      );
      invalidate();
    },
    onError,
  });
  // Approval, rejection and conducting an overdue week are one mutation because the endpoint is one
  // (ADR 0101): conducting is the same approval with a correction block attached. Split into two
  // mutations, the page would get two 409/422 handlers for one action.
  const approveMutation = useMutation({
    mutationFn: async (value: {
      approved: boolean;
      comment: string;
      /**
       * Correction block, only for approving an overdue week; the endpoint rejects it otherwise.
       */
      correction?: WeeklyCorrectionBody;
    }) => {
      const saved = value.approved ? await saveComposition() : request!;
      return weeklyRequestsApi.approval(saved.id, {
        approved: value.approved,
        comment: value.comment,
        version: saved.version,
        ...(value.correction ? { correction: value.correction } : {}),
      });
    },
    onSuccess: (result, value) => {
      setReasonMode(null);
      setConducting(false);
      clearApplyError();
      message.success(decisionMessage(result, value.approved, !!value.correction));
      invalidate();
    },
    onError,
  });
  const cancelMutation = useMutation({
    mutationFn: (reason: string) =>
      weeklyRequestsApi.changeStatus(request!.id, {
        status: 'cancelled',
        reason,
        version: request!.version,
      }),
    onSuccess: () => {
      setReasonMode(null);
      message.success('Заявка снята');
      invalidate();
    },
    onError,
  });

  // Weekly requests no longer have their own tab: they are rows of the shared vehicle-order list,
  // and "Back" returns there narrowed to weekly ones, not to the full list where the document just
  // left would have to be searched among orders.
  const leave = () => void navigate('/vehicle-requests?tab=requests&kind=weekly');
  const goBack = () => {
    if (!composition.dirty) return leave();
    modal.confirm({ ...WEEKLY_LEAVE_CONFIRM, onOk: leave });
  };
  // What can no longer be done with this week and what still can (ADR 0101), in one contract-based
  // computation.
  const weekState = request
    ? weeklyPageWeekState({
        weekStart: request.weekStart,
        composable,
        isPending: status === 'pending',
        backdate,
        role: user?.role,
        can,
      })
    : null;

  return {
    annul,
    returning,
    request,
    requestQuery,
    status,
    composable,
    editable,
    suggestionQuery,
    documents: documentsQuery.data,
    history: historyQuery.data,
    classifications,
    composition,
    skipReasons,
    applyError,
    backdate,
    create,
    reasonMode,
    setReasonMode,
    conducting,
    setConducting,
    saveMutation,
    submitMutation,
    approveMutation,
    cancelMutation,
    leave,
    goBack,
    weekState,
    rejection: lastRejectionComment(historyQuery.data),
    returned: lastReturn(historyQuery.data),
    can,
  };
}
