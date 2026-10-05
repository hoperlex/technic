import { Button, Space, Typography } from 'antd';
import type { WeeklyItemCounts } from '@technic/contracts';
import { weeklyCountsText } from '@entities/weekly-request';

/**
 * Keep totals and commands pinned below a long composition. Approval and rejection deliberately
 * use separate capabilities: an overdue week is conducted by a backdate-capable operator, while
 * the site approver may still reject it because rejection changes no historical work (ADR 0101).
 */

interface Props {
  counts: WeeklyItemCounts;
  /** The document remains composable and the account may edit it. */
  editable: boolean;
  isDraft: boolean;
  /** Submission immediately approves an object-scoped approver's own site. */
  approvesOwn: boolean;
  /**
   * Permission to approve this exact week: ordinary approval for the future, backdate authority
   * after the week starts.
   */
  canApproveWeek: boolean;
  /** Rejection retains ordinary site approval authority because it moves no historical work. */
  canReject: boolean;
  /** Approval becomes a backdated operation once the week starts. */
  overdue: boolean;
  /** An empty composition has nothing to submit. */
  empty: boolean;
  /**
   * This account cannot submit or approve the week; cancellation remains available as an exit.
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
  /**
   * Annul an applied week (ADR 0218); `null` — no button at all, because the week is not applied or
   * the viewer holds neither branch's right. A nullable handler rather than a separate boolean: two
   * fields for one condition drift apart at the first edit.
   */
  onAnnul: (() => void) | null;
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
        {/* Explain why rejection is present without approval so the action set does not look broken. */}
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
        {/* Backdated approval must disclose its audit reason and irreversible waybill effects. */}
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
        {/* Cancellation remains available before application even when the week itself is blocked. */}
        {props.editable && (
          <Button danger onClick={props.onCancel}>
            Снять заявку
          </Button>
        )}
        {/* Annulment of an applied week (ADR 0218). The button appears by status and right alone;
            the price and the refusals are named by the window, which asks the server — the preview
            builds a history and paper plan per extended row, and paying that on every card view
            would be waste. */}
        {props.onAnnul && (
          <Button danger onClick={props.onAnnul}>
            Аннулировать неделю
          </Button>
        )}
      </Space>
    </div>
  );
}
