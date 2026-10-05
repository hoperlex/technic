import { Button, Space, Typography } from 'antd';
import type { WeeklyItemCounts } from '@technic/contracts';
import { weeklyCountsText } from '@entities/weekly-request';

/**
 * Action bar of the weekly request, pinned to the page bottom (section 5 step 1): the composition
 * is long, and the totals with buttons must not scroll past its end.
 *
 * The totals sit left of the buttons and next to the irreversibility warning: "Submit and approve"
 * moves order terms and issues waybills in the same transaction (R6), and what is being approved
 * must be read before the click, not after.
 *
 * Approval and rejection are split by TWO flags, not one "has approval right" (ADR 0101). For an
 * overdue week these are different people: only a holder of the past right (dispatcher,
 * administrator) may conduct it, while the site's construction manager may still reject it, because
 * rejection moves nothing in the past, it returns the request to draft. Merging them back into one
 * flag would offer one person a button the endpoint answers with 403 and take from another a
 * rejection it accepts.
 */

interface Props {
  counts: WeeklyItemCounts;
  /** The document remains composable and the account may edit it. */
  editable: boolean;
  isDraft: boolean;
  /** Approval applies the request at once: the construction manager's own site (R8). */
  approvesOwn: boolean;
  /**
   * Right to approve THIS week, with the request awaiting it: weeklyRequests.approve for a future
   * week, the past right for an overdue one (weeklyApprovalPermission).
   */
  canApproveWeek: boolean;
  /** Rejection retains ordinary site approval authority because it moves no historical work. */
  canReject: boolean;
  /** Approval becomes a backdated operation once the week starts. */
  overdue: boolean;
  /** An empty composition has nothing to submit. */
  empty: boolean;
  /**
   * The week is closed for this account: submitting and approving are impossible, cancelling is
   * always possible (section 8). For a holder of the past right the flag is lifted: no dead end.
   */
  blockedByWeek: boolean;
  /** Incomplete additional rows must block submission instead of disappearing silently. */
  hasIssues: boolean;
  dirty: boolean;
  savePending: boolean;
  submitPending: boolean;
  approvePending: boolean;
  onSave: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  /** Open the conduct dialog that discloses reason, reissued sheets and operation cost. */
  onConduct: () => void;
  onReject: () => void;
  onCancel: () => void;
}

export function WeeklyRequestActions(props: Props) {
  const blocked = props.empty || props.blockedByWeek || props.hasIssues;
  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        paddingTop: 8,
        borderTop: '1px solid rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 200, lineHeight: 1.3 }}>
        <Typography.Text strong>{weeklyCountsText(props.counts)}</Typography.Text>
        {props.editable && props.approvesOwn && props.isDraft && (
          <div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              Сроки продлятся сразу, будут выписаны путевые листы
            </Typography.Text>
          </div>
        )}
        {/* A lone "Reject" button without approval next to it reads as a broken screen: the panel
            that lacks approval must say where it went. */}
        {props.overdue && props.canReject && !props.canApproveWeek && (
          <div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              Неделя уже началась: провести её задним числом может диспетчер или администратор — вам
              остаётся отклонить заявку или снять её
            </Typography.Text>
          </div>
        )}
        {props.hasIssues && (
          <div>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              Заполните строки дополнительной техники — незаполненная в состав не уйдёт
            </Typography.Text>
          </div>
        )}
      </div>
      <Space size={8} wrap>
        {props.editable && (
          <Button onClick={props.onSave} loading={props.savePending} disabled={!props.dirty}>
            Сохранить черновик
          </Button>
        )}
        {props.editable && props.isDraft && (
          <Button
            type="primary"
            loading={props.submitPending}
            disabled={blocked}
            onClick={props.onSubmit}
          >
            {props.approvesOwn ? 'Подать и завизировать' : 'Подать'}
          </Button>
        )}
        {/* An overdue week is approved through a window, not a click: reason, waybills to reissue
            and the operation price are asked before the first form number burns (ADR 0101). The
            button is red: it takes forms away and moves the past rather than saving. */}
        {props.canApproveWeek && props.overdue && (
          <Button danger type="primary" disabled={blocked} onClick={props.onConduct}>
            Провести задним числом
          </Button>
        )}
        {props.canApproveWeek && !props.overdue && (
          <Button
            type="primary"
            loading={props.approvePending}
            disabled={blocked}
            onClick={props.onApprove}
          >
            Завизировать
          </Button>
        )}
        {props.canReject && (
          <Button danger onClick={props.onReject}>
            Отклонить
          </Button>
        )}
        {/* A request can always be cancelled until applied (plan section 8): overdueness does not
            apply to cancelling, neither on the server nor here. The former !blockedByWeek locked
            exactly the exit the overdue-week banner offered. */}
        {props.editable && (
          <Button danger onClick={props.onCancel}>
            Снять заявку
          </Button>
        )}
      </Space>
    </div>
  );
}
