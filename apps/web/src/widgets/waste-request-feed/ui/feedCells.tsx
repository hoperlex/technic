import { useState } from 'react';
import { Button, Dropdown, Space, Tag, Tooltip, Typography } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import {
  allowedStatusTransitions,
  containerOwnerMismatch,
  requestStatusColors,
  requestStatusLabels,
  wasteRequestCommentLines,
  wasteSubjectLabel,
  wasteTicketReviewBlocker,
  type RequestStatus,
  type WasteRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { useIsMobile } from '@shared/lib';
import { ActionSheet, ExpandableCell } from '@shared/ui';

/**
 * The request comment as two labelled lines: the site and the executor (ADR 0053).
 *
 * In a list row (collapsible) the whole cell collapses with the same ExpandableCell that holds the
 * comment and contacts in the vehicle feed: text wraps to the column width, the collapsed cell
 * shows two lines (as many as the neighbouring columns take), and a tap reveals the rest. Before
 * that every line was cut by its own ellipsis exactly where the essence of the request begins.
 *
 * A collapsed cell may cut off the second side together with its label: a wordy site comment
 * fills two lines on its own. This is a deliberate trade-off: the side comes back with the same
 * tap, not by opening the card, while letting both sides grow in height would stretch every list
 * row to the wordiest request.
 */
export function WasteCommentCell({
  request,
  collapsible,
}: {
  request: WasteRequestDto;
  collapsible?: boolean;
}) {
  const lines = wasteRequestCommentLines(request);
  if (lines.length === 0) return null;
  const body = lines.map((line) => (
    <div key={line.key}>
      <Typography.Text type="secondary">{line.label}: </Typography.Text>
      {/* Preserve author paragraphs; both comment fields accept multiline input. */}
      <span style={{ whiteSpace: 'pre-line' }}>{line.text}</span>
    </div>
  ));
  return collapsible ? <ExpandableCell>{body}</ExpandableCell> : <>{body}</>;
}

/**
 * The request subject with a foreign-container mark (ADR 0054). The label itself is built by the
 * contract (wasteSubjectLabel), since both the list and the phone card need it; the tag lives here
 * because it is presentation, not a description of the subject.
 */
export function WasteSubjectCell({ request }: { request: WasteRequestDto }) {
  return (
    <>
      {wasteSubjectLabel(request)}
      {containerOwnerMismatch(request) && (
        <Tooltip title={`Контейнер установил «${request.containerOwnerName ?? '—'}»`}>
          <Tag color="volcano" style={{ marginInlineStart: 8 }}>
            Чужой контейнер
          </Tag>
        </Tooltip>
      )}
    </>
  );
}

/**
 * Status cell: the tag with transitions available to the role. It stays a module-level component:
 * defined inside a feed render it would be a new React type on every render, React would destroy
 * the subtree and its state, and an open mobile transition sheet would close on any list update.
 * The user and device mode come from hooks (they are the same for the whole page); props carry
 * only what differs per row.
 */
export function WasteStatusCell({
  request,
  pending,
  onChange,
}: {
  request: WasteRequestDto;
  /** This request's status change is in flight: the tag waits for the answer and ignores taps. */
  pending: boolean;
  onChange: (request: WasteRequestDto, status: RequestStatus) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Contract predicates keep the role-specific transition corridor identical to the API: the linear
  // cycle for everyone, rollbacks for the admin only, and an external executor has its own
  // corridor (closing a request taken into work).
  const transitions = user ? allowedStatusTransitions(request.status, user, 'waste') : [];
  const tag = (
    <Tag color={requestStatusColors[request.status]} style={{ marginInlineEnd: 0 }}>
      {requestStatusLabels[request.status]}
    </Tag>
  );
  // The cancellation reason is a tooltip on the tag: the table has no column for it. A phone has
  // no tooltips, so there the reason is a card line instead.
  const badge =
    request.cancelReason && !isMobile ? (
      <Tooltip title={`Причина отмены: ${request.cancelReason}`}>{tag}</Tooltip>
    ) : (
      tag
    );
  if (request.deletedAt || transitions.length === 0) return badge;

  /**
   * Completion is the human decision that ticket review is finished (ADR 0135). Keep the action
   * visible but disabled with the contract-owned reason; hiding it would look like missing access.
   *
   * It is computed from the same badge shown in the review column and by the same function the
   * server uses to refuse: the badge arrives only with the wasteRequests.ticketReview right, and
   * the "Завершена" item is offered exactly to whoever holds that right. A null badge means no
   * paper is under review, so completing is allowed.
   */
  const completionBlocker = wasteTicketReviewBlocker(request.ticketBadge);
  const items = transitions.map((status) => ({
    key: status,
    label: requestStatusLabels[status],
    ...(status === 'completed' && completionBlocker
      ? { disabled: true, title: completionBlocker }
      : {}),
  }));

  // On a phone transitions are a bottom sheet: a dropdown on a card tag opens past the finger, and
  // the captions stay the same (ADR 0030). stopPropagation keeps the tap from opening the card.
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
          <Space size={4}>
            {badge}
            <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
          </Space>
        </button>
        <ActionSheet
          title="Изменить статус"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={items.map((item) => ({
            key: item.key,
            label: item.label,
            disabled: item.key === 'completed' && !!completionBlocker,
            disabledReason:
              item.key === 'completed' && completionBlocker ? completionBlocker : undefined,
            onClick: () => onChange(request, item.key as RequestStatus),
          }))}
        />
      </>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      disabled={pending}
      menu={{
        items,
        onClick: ({ key }) => onChange(request, key as RequestStatus),
      }}
    >
      <Button
        type="text"
        size="small"
        loading={pending}
        aria-label="Изменить статус"
        style={{ padding: 0, height: 'auto', border: 'none' }}
      >
        <Space size={4}>
          {badge}
          <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
        </Space>
      </Button>
    </Dropdown>
  );
}
