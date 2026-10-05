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

/** Render the contract-owned subject label and the live foreign-container warning together. */
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
 * Keep the status component outside the list body. Defining it during a feed render would replace
 * its React type and close the mobile action sheet whenever the list updates.
 */
export function WasteStatusCell({
  request,
  pending,
  onChange,
}: {
  request: WasteRequestDto;
  pending: boolean;
  onChange: (request: WasteRequestDto, status: RequestStatus) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Contract predicates keep the role-specific transition corridor identical to the API.
  const transitions = user ? allowedStatusTransitions(request.status, user, 'waste') : [];
  const tag = (
    <Tag color={requestStatusColors[request.status]} style={{ marginInlineEnd: 0 }}>
      {requestStatusLabels[request.status]}
    </Tag>
  );
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
   */
  const completionBlocker = wasteTicketReviewBlocker(request.ticketBadge);
  const items = transitions.map((status) => ({
    key: status,
    label: requestStatusLabels[status],
    ...(status === 'completed' && completionBlocker
      ? { disabled: true, title: completionBlocker }
      : {}),
  }));

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
