import { useEffect, useState } from 'react';
import { App } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { isWeeklyRequestEditable, type WeeklyCorrectionBody } from '@technic/contracts';
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
import { hasApiStatus } from './apiError';
import {
  decisionMessage,
  lastRejectionComment,
  WEEKLY_LEAVE_CONFIRM,
  weeklyPageWeekState,
} from './pageState';

/** Own weekly-request queries, mutations and navigation while the view only composes UI blocks. */
export function useWeeklyRequestWorkspace() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const backdate = weeklyBackdateAccess(can);
  const create = useWeeklyRequestCreate();
  const [skipReasons, setSkipReasons] = useState<Map<string, string>>(new Map());
  const [applyError, setApplyError] = useState<string | null>(null);
  const [reasonMode, setReasonMode] = useState<'cancel' | 'reject' | null>(null);
  const [conducting, setConducting] = useState(false);

  const requestQuery = useQuery({
    queryKey: weeklyRequestKeys.detail(id),
    queryFn: () => weeklyRequestsApi.get(id),
    enabled: !!id,
    // A deleted request is the final answer for this route, not a transient retry condition.
    retry: false,
  });
  const request = requestQuery.data;
  const status = request?.status;
  const composable = !!request && isWeeklyRequestEditable(request.status);
  const editable = composable && can('weeklyRequests.update');
  // Applied requests use their frozen saved composition; querying the live site suggestion would
  // incorrectly compare historical decisions with today's fleet.
  const suggestionEnabled = composable && can('weeklyRequests.create');
  const suggestionQuery = useQuery({
    queryKey: weeklyRequestKeys.suggestion(request?.objectId, request?.weekStart),
    queryFn: () =>
      weeklyRequestsApi.suggestion({
        objectId: request!.objectId,
        weekStart: request!.weekStart,
      }),
    enabled: suggestionEnabled,
    // Do not refresh under an editor: a background suggestion change would erase local decisions.
    staleTime: 5 * 60_000,
  });
  const documentsQuery = useQuery({
    queryKey: weeklyRequestKeys.documents(id),
    queryFn: () => weeklyRequestsApi.documents(id),
    enabled: !!id && status === 'applied',
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

  useEffect(() => {
    if (!composition.dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [composition.dirty]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.root });
    // Applying a week changes order periods, ESM-2 sheets and garage occupancy in one command.
    void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
    void queryClient.invalidateQueries({ queryKey: garageKeys.root });
  };
  const clearApplyError = () => {
    setApplyError(null);
    setSkipReasons(new Map());
  };
  const onError = (error: unknown) => {
    if (hasApiStatus(error, 409)) {
      void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.root });
      message.error('Состав изменил другой пользователь — страница обновлена');
      return;
    }
    if (hasApiStatus(error, 422) && request) {
      setApplyError(weeklyRequestErrorMessage(error));
      const reasons = weeklySkipReasonsFromError(error, request.items);
      if (reasons.size > 0) setSkipReasons(reasons);
      // Refresh the suggestion so orders that disappeared receive a row-level stale reason.
      void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.suggestions() });
    }
    message.error(weeklyRequestErrorMessage(error));
  };

  const saveComposition = async () => {
    if (!request) throw new Error('Заявка не загружена');
    if (!composition.dirty) return request;
    return weeklyRequestsApi.update(request.id, {
      items: composition.items,
      comment: composition.comment,
      version: request.version,
    });
  };
  const saveMutation = useMutation({
    mutationFn: saveComposition, // cache-write: delegated — calls the update API when dirty.
    onSuccess: () => {
      clearApplyError();
      message.success('Состав сохранён');
      invalidate();
    },
    onError,
  });
  // Submission saves first so the reviewed document can never differ from the visible draft.
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
  // Ordinary approval and backdated conduct share one API command and therefore one conflict and
  // row-error handler. Splitting them would duplicate the same cache and version protocol.
  const approveMutation = useMutation({
    mutationFn: async (value: {
      approved: boolean;
      comment: string;
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

  const leave = () => void navigate('/vehicle-requests?tab=requests&kind=weekly');
  const goBack = () => {
    if (!composition.dirty) return leave();
    modal.confirm({ ...WEEKLY_LEAVE_CONFIRM, onOk: leave });
  };
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
    can,
  };
}
