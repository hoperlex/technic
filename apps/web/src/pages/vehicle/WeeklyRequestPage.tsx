import { useEffect, useState } from 'react';
import { App, Button, Card, Input, Result, Skeleton, Space, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  isObjectScopedRole,
  isWeeklyRequestEditable,
  selectableWeeks,
  weeklyWeekBlocker,
} from '@technic/contracts';
import { weeklyRequestsApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { ReasonModal } from '../../components/CancelReasonModal';
import { useAuth } from '../../auth/AuthContext';
import { useVehicleClassifications } from '../../hooks/useVehicleClassifications';
import { errorMessage } from '../../utils/format';
import { useWeeklyComposition } from './weeklyComposition';
import { WeeklyRequestActions } from './WeeklyRequestActions';
import { WeeklyRequestBanners } from './WeeklyRequestBanners';
import { WeeklyRequestComposition, WeeklyRequestLeaving } from './WeeklyRequestComposition';
import { WeeklyRequestNewItems } from './WeeklyRequestNewItems';
import {
  WeeklyRequestAgreed,
  WeeklyRequestChecklist,
  WeeklyRequestHistory,
} from './WeeklyRequestChecklist';
import {
  hasStatus,
  skipReasonsFromError,
  useWeeklyRequestCreate,
  WEEKLY_QUERY_KEY,
  WeeklyStatusTag,
  weeklyToday,
} from './weeklyShared';

/**
 * Страница недельной заявки: сборка состава и карточка применённой недели (§5 шаги 1–6).
 *
 * Отдельной страницей с адресом, а не модальным окном: три блока состава, история и документы в
 * модалку не помещаются, а ссылку на неделю нужно уметь послать. Панель действий закреплена внизу
 * — состав длинный, и кнопка «Подать» не должна уезжать за конец списка.
 */

export function WeeklyRequestPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const create = useWeeklyRequestCreate();
  /** Причины отказа применения по строкам (§9): держатся до следующей попытки. */
  const [skipReasons, setSkipReasons] = useState<Map<string, string>>(new Map());
  /** Отказ применения целиком: «ни одна строка не применима» с перечнем причин (Р9). */
  const [applyError, setApplyError] = useState<string | null>(null);
  const [reasonMode, setReasonMode] = useState<'cancel' | 'reject' | null>(null);

  const requestQuery = useQuery({
    queryKey: ['weekly-vehicle-requests', id],
    queryFn: () => weeklyRequestsApi.get(id),
    enabled: !!id,
    // Исчезнувшую заявку не перезапрашиваем: 404 здесь — это ответ, а не сбой связи (§9).
    retry: false,
  });
  const request = requestQuery.data;
  const status = request?.status;
  const composable = !!request && isWeeklyRequestEditable(request.status);
  const editable = composable && can('weeklyRequests.update');

  // Предложение спрашивается только там, где состав ещё собирают: у применённой заявки состав
  // заморожен, и срез площадки к ней отношения не имеет.
  const suggestionEnabled = composable && can('weeklyRequests.create');
  const suggestionQuery = useQuery({
    queryKey: ['weekly-vehicle-requests', 'suggestion', request?.objectId, request?.weekStart],
    queryFn: () =>
      weeklyRequestsApi.suggestion({
        objectId: request!.objectId,
        weekStart: request!.weekStart,
      }),
    enabled: suggestionEnabled,
    // Срез площадки за время сборки не пересчитывается сам: иначе правка человека слетала бы от
    // фонового обновления. Что состав мог устареть, скажет отказ применения (Р14).
    staleTime: 5 * 60_000,
  });

  const documentsQuery = useQuery({
    queryKey: ['weekly-vehicle-requests', id, 'documents'],
    queryFn: () => weeklyRequestsApi.documents(id),
    enabled: !!id && status === 'applied',
  });
  const historyQuery = useQuery({
    queryKey: ['weekly-vehicle-requests', id, 'history'],
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

  /**
   * Несохранённые изменения при уходе со страницы (§9). Перехватывается закрытие вкладки и
   * переход по кнопке «К списку»; общего блокировщика переходов у портала нет — `useBlocker`
   * работает только в data-роутере, а приложение живёт на `BrowserRouter`.
   */
  useEffect(() => {
    if (!composition.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [composition.dirty]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: WEEKLY_QUERY_KEY });
    // Применение двигает сроки заказов и порождает новые: список заявок ТС тоже устарел.
    void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    // Продление срока перевыписывает ЭСМ-2 заказа (`extendSpecialEquipmentPeriod` → `syncEsm2Waybills`),
    // поэтому журнал листов после визы недели показывает смены, которых уже нет.
    void qc.invalidateQueries({ queryKey: ['waybills'] });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  /** Удавшееся действие снимает объяснения прошлого отказа: они относились к прежнему составу. */
  const clearApplyError = () => {
    setApplyError(null);
    setSkipReasons(new Map());
  };

  /** Общий разбор отказа: конфликт версий, исчезнувшая заявка и построчные причины 422. */
  const onError = (e: unknown) => {
    if (hasStatus(e, 409)) {
      void qc.invalidateQueries({ queryKey: WEEKLY_QUERY_KEY });
      message.error('Состав изменил другой пользователь — страница обновлена');
      return;
    }
    if (hasStatus(e, 422) && request) {
      // Причины сервер перечисляет в самом сообщении, а по строкам — там, где умеет назвать их
      // полями. Берутся оба: банер объясняет отказ целиком, строки — что править.
      setApplyError(errorMessage(e));
      const reasons = skipReasonsFromError(e, request.items);
      if (reasons.size > 0) setSkipReasons(reasons);
      // Срез площадки перечитывается: строка, чей заказ отменили или закрыли, получит свою
      // причину прямо в составе — сверять список с таблицей глазами не придётся.
      void qc.invalidateQueries({ queryKey: ['weekly-vehicle-requests', 'suggestion'] });
    }
    message.error(errorMessage(e));
  };

  /** Состав уходит целиком; версия — токен блокировки, а не значение колонки. */
  const saveComposition = async () => {
    if (!request) throw new Error('Заявка не загружена');
    if (!composition.dirty) return request;
    return weeklyRequestsApi.update(request.id, {
      items: composition.items,
      comment: composition.comment,
      version: request.version,
    });
  };

  const saveMut = useMutation({
    mutationFn: saveComposition,
    onSuccess: () => {
      clearApplyError();
      message.success('Состав сохранён');
      invalidate();
    },
    onError,
  });

  // Подача сохраняет состав тем же движением: подать одно, а согласовать другое — худшее, что
  // может случиться с документом, у которого виза применяет сроки (Р6).
  const submitMut = useMutation({
    mutationFn: async () => {
      const saved = await saveComposition();
      return weeklyRequestsApi.changeStatus(saved.id, {
        status: 'pending',
        version: saved.version,
      });
    },
    onSuccess: (res) => {
      clearApplyError();
      message.success(
        res.apply ? `Неделя применена: строк ${res.apply.applied}` : 'Заявка подана на визу',
      );
      invalidate();
    },
    onError,
  });

  const approveMut = useMutation({
    mutationFn: async (v: { approved: boolean; comment: string }) => {
      const saved = v.approved ? await saveComposition() : request!;
      return weeklyRequestsApi.approval(saved.id, {
        approved: v.approved,
        comment: v.comment,
        version: saved.version,
      });
    },
    onSuccess: (res, v) => {
      setReasonMode(null);
      clearApplyError();
      message.success(
        !v.approved
          ? 'Заявка отклонена и возвращена в черновик'
          : res.apply
            ? `Неделя применена: строк ${res.apply.applied}, пропущено ${res.apply.skipped}`
            : 'Неделя согласована и применена',
      );
      invalidate();
    },
    onError,
  });

  const cancelMut = useMutation({
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

  // Своей вкладки у недельных заявок больше нет: они строки общего списка «Заказ автотехники», и
  // «Назад» возвращает туда — в список, заранее суженный до недельных, а не в общую выдачу, где
  // только что оставленный документ пришлось бы искать среди заказов.
  const leave = () => void navigate('/vehicle-requests?tab=requests&kind=weekly');
  const goBack = () => {
    if (!composition.dirty) return leave();
    modal.confirm({
      title: 'Уйти, не сохранив состав?',
      content: 'Решения по строкам и добавленная техника не сохранятся.',
      okText: 'Уйти',
      okButtonProps: { danger: true },
      cancelText: 'Остаться',
      onOk: leave,
    });
  };

  if (requestQuery.isError) {
    const gone = hasStatus(requestQuery.error, 404);
    return (
      <Result
        status={gone ? '404' : 'error'}
        title={gone ? 'Заявка удалена вместе с площадкой' : 'Заявка не открылась'}
        subTitle={
          gone
            ? 'Неприменённые недельные заявки погашенной площадки удаляются вместе с ней: документа больше нет.'
            : errorMessage(requestQuery.error)
        }
        extra={
          <Button type="primary" onClick={leave}>
            К списку недельных заявок
          </Button>
        }
      />
    );
  }

  if (!request) return <Skeleton active paragraph={{ rows: 8 }} />;

  // Неделя, до которой черновик дожил, закрыта: подать и завизировать её нельзя, а отменить —
  // можно всегда (§8). Одного 422 от API здесь мало: он объясняет отказ, но не выход из положения.
  const weekBlocker = composable ? weeklyWeekBlocker(request.weekStart, weeklyToday()) : null;
  const nextWeek = selectableWeeks(weeklyToday())[0];
  /** Автовиза при подаче — только объектной роли (Р12): администратор под неё не подпадает. */
  const approvesOwn = isObjectScopedRole(user?.role) && can('weeklyRequests.approve');
  const canApprove = can('weeklyRequests.approve') && status === 'pending';
  const empty = composition.items.length === 0;
  const blockedByWeek = !!weekBlocker;
  /** Причина отклонения показывается сверху в самой заявке, а не только в истории (§5 шаг 5). */
  const rejection = (historyQuery.data ?? [])
    .filter((e) => e.event === 'status' && e.toStatus === 'draft' && e.comment)
    .at(-1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={goBack} aria-label="К списку" />
        <div style={{ lineHeight: 1.3 }}>
          <Space size={8} wrap>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {request.displayNumber} · {request.weekLabel}
            </Typography.Title>
            <WeeklyStatusTag status={request.status} />
          </Space>
          <div>
            <Typography.Text type="secondary">
              {request.objectName}
              {request.objectCode ? ` · ${request.objectCode}` : ''} · автор {request.createdByName}
            </Typography.Text>
          </div>
        </div>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <WeeklyRequestBanners
            request={request}
            rejection={rejection?.comment ?? null}
            weekBlocker={weekBlocker}
            editable={editable}
            composable={composable}
            applyError={applyError}
            counts={composition.counts}
            undecided={composition.undecided}
            onCancel={() => setReasonMode('cancel')}
            onNextWeek={
              nextWeek && can('weeklyRequests.create')
                ? () => create.openWeek(request.objectId, nextWeek)
                : null
            }
            nextWeekPending={create.pending}
          />

          {composable && (
            <Card size="small" title="Остаётся на площадке">
              <WeeklyRequestComposition
                rows={composition.rows}
                decisions={composition.decisions}
                setDecision={composition.setDecision}
                skipReasons={skipReasons}
                weekStart={request.weekStart}
                weekEnd={request.weekEnd}
                editable={editable && !blockedByWeek}
                suggestion={suggestionQuery.data}
              />
            </Card>
          )}

          {composable && (
            <Card size="small" title="Нужна дополнительно">
              <WeeklyRequestNewItems
                rows={composition.newRows}
                issues={composition.issues}
                skipReasons={skipReasons}
                weekStart={request.weekStart}
                weekEnd={request.weekEnd}
                editable={editable && !blockedByWeek}
                groups={classifications.groups}
                loading={classifications.loading}
                onAdd={composition.addNewRow}
                onUpdate={composition.updateNewRow}
                onRemove={composition.removeNewRow}
              />
            </Card>
          )}

          {composable && (
            <Card size="small" title="Уезжает">
              <WeeklyRequestLeaving rows={composition.rows} decisions={composition.decisions} />
            </Card>
          )}

          {/* Применённая и снятая заявка — история: состав показывается тем, чем он стал, а не
              полями ввода, которые всё равно ничего не примут (Р13). */}
          {!composable && (
            <Card size="small" title="Состав">
              <WeeklyRequestAgreed items={request.items} />
            </Card>
          )}

          <Card size="small" title="Комментарий к неделе">
            <Input.TextArea
              rows={2}
              maxLength={2000}
              disabled={!editable}
              placeholder="Что важно знать о неделе"
              value={composition.comment}
              onChange={(e) => composition.setComment(e.target.value)}
            />
          </Card>

          {status === 'applied' && (
            <Card size="small" title="Готовность недели">
              <WeeklyRequestChecklist documents={documentsQuery.data} can={can} />
            </Card>
          )}

          <Card size="small" title="История">
            <WeeklyRequestHistory entries={historyQuery.data} />
          </Card>
        </div>
      </div>

      <WeeklyRequestActions
        counts={composition.counts}
        editable={editable}
        isDraft={status === 'draft'}
        approvesOwn={approvesOwn}
        canApprove={canApprove}
        empty={empty}
        blockedByWeek={blockedByWeek}
        hasIssues={composition.issues.size > 0}
        dirty={composition.dirty}
        savePending={saveMut.isPending}
        submitPending={submitMut.isPending}
        approvePending={approveMut.isPending}
        onSave={() => saveMut.mutate()}
        onSubmit={() => submitMut.mutate()}
        onApprove={() => approveMut.mutate({ approved: true, comment: '' })}
        onReject={() => setReasonMode('reject')}
        onCancel={() => setReasonMode('cancel')}
      />

      <ReasonModal
        open={reasonMode !== null}
        title={reasonMode === 'reject' ? 'Отклонить недельную заявку' : 'Снять недельную заявку'}
        label="Причина"
        okText={reasonMode === 'reject' ? 'Отклонить' : 'Снять'}
        danger
        placeholderHint={
          reasonMode === 'reject'
            ? 'Причина покажется составителю сверху в самой заявке'
            : 'Причина останется в истории заявки'
        }
        confirmLoading={approveMut.isPending || cancelMut.isPending}
        onCancel={() => setReasonMode(null)}
        onSubmit={(reason) =>
          reasonMode === 'reject'
            ? approveMut.mutate({ approved: false, comment: reason })
            : cancelMut.mutate(reason)
        }
      />
      {create.node}
    </div>
  );
}
