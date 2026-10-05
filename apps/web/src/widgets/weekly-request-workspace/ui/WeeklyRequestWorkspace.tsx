import { Card, Input, Skeleton } from 'antd';
import { isWeeklyRequestApplied, weeklyWeekEffectiveDate } from '@technic/contracts';
import { ReasonModal } from '@shared/ui';
import { useWeeklyRequestWorkspace } from '../model/useWeeklyRequestWorkspace';
import { weeklyReasonText } from '../model/pageState';
import { WeeklyRequestActions } from './WeeklyRequestActions';
import { WeeklyRequestBanners } from './WeeklyRequestBanners';
import { WeeklyRequestAnnulModal } from './WeeklyRequestAnnulModal';
import { WeeklyRequestConductModal } from './WeeklyRequestConductModal';
import { WeeklyRequestComposition, WeeklyRequestLeaving } from './WeeklyRequestComposition';
import { WeeklyRequestHeader, WeeklyRequestNotOpened } from './WeeklyRequestFrame';
import { WeeklyRequestNewItems } from './WeeklyRequestNewItems';
import {
  WeeklyRequestAgreed,
  WeeklyRequestChecklist,
  WeeklyRequestHistory,
} from './WeeklyRequestChecklist';

/** Compose the editable weekly plan, applied-week checklist and their command surfaces. */
export function WeeklyRequestWorkspace() {
  const workspace = useWeeklyRequestWorkspace();
  const {
    request,
    requestQuery,
    composition,
    composable,
    editable,
    suggestionQuery,
    classifications,
    status,
    weekState,
  } = workspace;

  if (requestQuery.isError) {
    return <WeeklyRequestNotOpened error={requestQuery.error} onLeave={workspace.leave} />;
  }
  if (!request || !weekState) return <Skeleton active paragraph={{ rows: 8 }} />;

  const blockedByWeek = !!weekState.weekBlocker;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <WeeklyRequestHeader request={request} onBack={workspace.goBack} />

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <WeeklyRequestBanners
            request={request}
            rejection={workspace.rejection}
            weekBlocker={weekState.weekBlocker}
            overdue={weekState.overdue}
            canPast={workspace.backdate.correct}
            effectiveDate={weeklyWeekEffectiveDate(request.weekStart)}
            editable={editable}
            composable={composable}
            isPending={status === 'pending'}
            applyError={workspace.applyError}
            counts={composition.counts}
            undecided={composition.undecided}
            onCancel={() => workspace.setReasonMode('cancel')}
            onNextWeek={
              weekState.nextWeek && workspace.can('weeklyRequests.create')
                ? () => workspace.create.openWeek(request.objectId, weekState.nextWeek!)
                : null
            }
            nextWeekPending={workspace.create.pending}
          />

          {composable && (
            <Card size="small" title="Остаётся на площадке">
              <WeeklyRequestComposition
                rows={composition.rows}
                decisions={composition.decisions}
                setDecision={composition.setDecision}
                skipReasons={workspace.skipReasons}
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
                skipReasons={workspace.skipReasons}
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

          {/* An applied or cancelled request is history: the composition is shown as what it
              became, not as inputs that would accept nothing anyway (R13). */}
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
              onChange={(event) => composition.setComment(event.target.value)}
            />
          </Card>

          {!!status && isWeeklyRequestApplied(status) && (
            <Card size="small" title="Готовность недели">
              <WeeklyRequestChecklist documents={workspace.documents} can={workspace.can} />
            </Card>
          )}

          <Card size="small" title="История">
            <WeeklyRequestHistory entries={workspace.history} />
          </Card>
        </div>
      </div>

      <WeeklyRequestActions
        counts={composition.counts}
        editable={editable}
        isDraft={status === 'draft'}
        approvesOwn={weekState.approvesOwn}
        canApproveWeek={weekState.canApproveWeek}
        canReject={weekState.canReject}
        overdue={weekState.overdue}
        empty={composition.items.length === 0}
        blockedByWeek={blockedByWeek}
        hasIssues={composition.issues.size > 0}
        dirty={composition.dirty}
        savePending={workspace.saveMutation.isPending}
        submitPending={workspace.submitMutation.isPending}
        approvePending={workspace.approveMutation.isPending}
        onSave={() => workspace.saveMutation.mutate()}
        onSubmit={() => workspace.submitMutation.mutate()}
        onApprove={() => workspace.approveMutation.mutate({ approved: true, comment: '' })}
        onConduct={() => workspace.setConducting(true)}
        onReject={() => workspace.setReasonMode('reject')}
        onCancel={() => workspace.setReasonMode('cancel')}
        onAnnul={workspace.annul.onOpen}
      />

      {/* Annulment: the server computes the price of the rollback with the very code that will
          execute it (ADR 0218); the reason and the sheets to reissue are named by the person. */}
      <WeeklyRequestAnnulModal
        request={workspace.annul.target}
        onClose={workspace.annul.onClose}
        onAnnul={workspace.annul.onAnnul}
        pending={workspace.annul.pending}
      />

      {/* Retroactive conduct window: the operation price is asked from the server by the same code
          that will execute it, the reason and waybills to reissue from the person (ADR 0101). The
          mutation stays in the workspace hook: conducting is the same approval, and its refusals
          must have one handler. */}
      <WeeklyRequestConductModal
        request={workspace.conducting ? request : null}
        onClose={() => workspace.setConducting(false)}
        onConduct={(correction) =>
          workspace.approveMutation.mutate({ approved: true, comment: '', correction })
        }
        pending={workspace.approveMutation.isPending}
      />
      <ReasonModal
        open={workspace.reasonMode !== null}
        {...weeklyReasonText(workspace.reasonMode === 'reject')}
        danger
        confirmLoading={workspace.approveMutation.isPending || workspace.cancelMutation.isPending}
        onCancel={() => workspace.setReasonMode(null)}
        onSubmit={(reason) =>
          workspace.reasonMode === 'reject'
            ? workspace.approveMutation.mutate({ approved: false, comment: reason })
            : workspace.cancelMutation.mutate(reason)
        }
      />
      {workspace.create.node}
    </div>
  );
}
