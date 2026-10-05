import { useState } from 'react';
import { Button, Dropdown, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DownOutlined,
} from '@ant-design/icons';
import {
  allowedVehicleRequestTransitions,
  isApprovalChangeable,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { formatDateTime, useIsMobile } from '@shared/lib';
import { ActionSheet } from '@shared/ui';

/**
 * The two cells that manage a request right from its list row: status (ADR 0021) and the
 * construction manager's approval (ADR 0025). The live feed is the only list where they are
 * commands rather than labels: the closed-requests journal has nothing to manage, and the
 * "На объекте" view only reads. Mutation ownership stays in the page; these cells expose only the
 * requested next value.
 */
export function StatusCell({
  status,
  deleted,
  approved,
  cancelReason,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  /** Construction manager's approval: without it the request is not taken into work (ADR 0025). */
  approved: boolean;
  /** Shown as a tooltip on the tag: the table has no column for it. */
  cancelReason?: string | null;
  pending: boolean;
  onChange: (status: RequestStatus) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  // The contracts predicate is the single source for role/status transitions and the approval gate:
  // the linear cycle is for request-managing roles, rolling back closed requests is admin-only, and
  // "В работе" before approval is offered to nobody because the server would reject it.
  const transitions = user ? allowedVehicleRequestTransitions(status, user, approved) : [];
  const plain = <Tag color={requestStatusColors[status]}>{requestStatusLabels[status]}</Tag>;
  // Mobile cards print the cancellation reason as a line (ADR 0030) because a tooltip does not open
  // on tap.
  const tag =
    cancelReason && !isMobile ? (
      <Tooltip title={`Причина отмены: ${cancelReason}`}>{plain}</Tooltip>
    ) : (
      plain
    );
  if (deleted || transitions.length === 0) return tag;

  // On a phone transitions are a bottom sheet: a dropdown opens past the finger, and tapping the
  // tag must not also open the request card (hence stopPropagation below).
  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className="status-trigger"
          aria-label="Изменить статус"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            setSheetOpen(true);
          }}
        >
          {tag}
          <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
        </button>
        <ActionSheet
          title="Изменить статус"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={transitions.map((next) => ({
            key: next,
            label: requestStatusLabels[next],
            onClick: () => onChange(next),
          }))}
        />
      </>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: transitions.map((next) => ({ key: next, label: requestStatusLabels[next] })),
        onClick: ({ key }) => onChange(key as RequestStatus),
      }}
    >
      <Button size="small" type="text" loading={pending}>
        {tag}
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}

/**
 * Approval is editable only for approvers and only before work starts (ADR 0025). Every other
 * role/status sees a badge, so a permanently unavailable command is not misread as temporarily
 * disabled. The state is read by colour (green approved, orange waiting), not by text: in the list
 * it is the first thing both the dispatcher and the construction manager look at.
 */
export function ApprovalCell({
  status,
  deleted,
  approved,
  approvedByName,
  approvedAt,
  canApprove,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  /**
   * The role's approval right only. A request on someone else's object is cut off by the server
   * itself (assertRequestScope), so the cell does not repeat that check.
   */
  canApprove: boolean;
  pending: boolean;
  onChange: (approved: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const approvedTitle =
    approved && approvedAt
      ? `Завизировал ${approvedByName ?? '—'} · ${formatDateTime(approvedAt)}`
      : 'Заявка ждёт визы руководителя строительства';
  const editable = canApprove && !deleted && isApprovalChangeable(status);

  if (!editable) {
    const tag = approved ? (
      <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Завизирована
      </Tag>
    ) : (
      <Tag color="orange" icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Ждёт визы
      </Tag>
    );
    // The request card carries approver details on mobile, where the tooltip cannot be opened.
    return isMobile ? tag : <Tooltip title={approvedTitle}>{tag}</Tooltip>;
  }

  const button = (
    <Button
      size="small"
      color={approved ? 'green' : 'orange'}
      variant="solid"
      loading={pending}
      icon={approved ? <CheckOutlined /> : undefined}
      // Approval sits inside a clickable row/card: pressing it must not also open the request card.
      onClick={(event) => {
        event.stopPropagation();
        onChange(!approved);
      }}
    >
      {approved ? 'Завизирована' : 'Согласовать'}
    </Button>
  );

  return isMobile ? (
    button
  ) : (
    <Tooltip
      title={approved ? `${approvedTitle}. Нажмите, чтобы снять визу` : 'Согласовать заявку'}
    >
      {button}
    </Tooltip>
  );
}
