import { Alert, Button, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  containerOwnerMismatch,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  usesContainerGroup,
  usesContainerType,
  type WasteRequestDto,
  wasteRequestChangeLabels,
  wasteSubjectLabel,
} from '@technic/contracts';
import { useSnowSupport, wasteRequestKeys, wasteRequestsApi } from '@entities/waste-request';
import { WasteRequestCommentField } from '@features/waste-request-comment';
import { useAuth } from '@entities/session';
import { FileLinkList } from '@entities/file';
import { RequestHistoryTable } from '@entities/request-history';
import { ResponsibleValue } from '@entities/user-account';

import { formatDateTime, useScrollIntoViewWhen } from '@shared/lib';
import { UserAvatar, ViewFields, ViewModal } from '@shared/ui';
import { formatDateTimeMaybe } from '@entities/request';
import { buildWasteRequestHistoryRows } from './viewHistory';
import { factFields, subjectFields } from './viewSubjectFields';
import { WasteRequestTickets } from './WasteRequestTickets';

/**
 * Read-only request details and event history (ADR 0012). The operator comment remains editable
 * here because it belongs to the executor, who may have no access to the request editor (ADR 0053).
 */
export interface WasteRequestViewProps {
  /** A null request closes the modal; fields otherwise use the list record. */
  request: WasteRequestDto | null;
  onClose: () => void;
  /** Omitted when role, status or archive state forbids editing. */
  onEdit?: (r: WasteRequestDto) => void;
  /** Omitted when this role cannot edit the executor comment or the request is already closed. */
  onSaveOperatorComment?: (r: WasteRequestDto, operatorComment: string) => void;
  savingOperatorComment?: boolean;
  /**
   * Roll a completed request back to Done (ADR 0135). Omitted when there is no such move: the
   * status is not terminal, the rollback permission is missing, or the request is archived.
   *
   * The button lives here, not in the journal row: the journal answers "what happened", while the
   * rollback is a decision about one request, taken after looking at its tickets and history. The
   * status menu exists only in the working list, which never shows completed requests (ADR 0135
   * section 5), so without this button they would have no way back at all.
   */
  onRollbackToDone?: (r: WasteRequestDto) => void;
  rollingBack?: boolean;
  /**
   * Attach tickets to a completed request (ADR 0189). Omitted without the status permission, in the
   * wrong state, or for an archived request. It lives in the card rather than the list row: tickets
   * are attached after seeing which paper is already on the request, otherwise the same scan would
   * arrive twice.
   */
  onAddTickets?: (r: WasteRequestDto, ticketFileIds: string[]) => void;
  addingTickets?: boolean;
  /** A ticket-column entry scrolls directly to review (ADR 0195). */
  focus?: 'tickets' | null;
}

export function WasteRequestView({
  request,
  onClose,
  onEdit,
  onSaveOperatorComment,
  savingOperatorComment,
  onRollbackToDone,
  rollingBack,
  onAddTickets,
  addingTickets,
  focus,
}: WasteRequestViewProps) {
  // Ticket review permission (ADR 0114, R25). It also controls remarks and the attempt log: an
  // external executor may complete a request but not review its own paper.
  const { can } = useAuth();
  const canReviewTickets = can('wasteRequests.ticketReview');
  const ticketsRef = useScrollIntoViewWhen<HTMLDivElement>(focus === 'tickets', request?.id);
  // A snow request is shown only while the serving API confirms snow (snow-removal plan, §3.5):
  // a card opened by link against an older or unavailable API would otherwise offer edits,
  // completion and ticket actions the server cannot take, and its history is not asked either.
  const snowCard = request?.requestType === 'snow_removal';
  const snow = useSnowSupport(snowCard);
  const snowUnavailable = snowCard && !snow.supported;

  const { data: history, isPending } = useQuery({
    queryKey: wasteRequestKeys.history(request?.id),
    queryFn: () => wasteRequestsApi.history(request!.id),
    enabled: !!request && !snowUnavailable,
  });

  const rows = useMemo(
    () =>
      buildWasteRequestHistoryRows(
        history,
        request?.completion ?? null,
        request?.vehicles ?? [],
        request?.tickets ?? [],
      ),
    [history, request?.completion, request?.vehicles, request?.tickets],
  );

  if (request && snowUnavailable) {
    return (
      <ViewModal
        title={`Заявка № ${request.displayNumber}`}
        open
        onClose={onClose}
        width={1000}
        footer={[
          <Button key="close" onClick={onClose}>
            Закрыть
          </Button>,
        ]}
      >
        {snow.checking ? (
          <Spin />
        ) : (
          <Alert
            type="warning"
            showIcon
            title="Заявка на вывоз снега сейчас недоступна"
            description="Сервер не подтвердил поддержку вывоза снега. Обновите страницу через несколько минут."
          />
        )}
      </ViewModal>
    );
  }

  const fields = request
    ? [
        {
          key: 'status',
          label: 'Статус',
          children: (
            <Tag color={requestStatusColors[request.status]}>
              {requestStatusLabels[request.status]}
            </Tag>
          ),
        },
        {
          key: 'requestType',
          label: 'Тип заявки',
          children: (
            <Tag color={requestTypeColors[request.requestType]}>
              {requestTypeLabels[request.requestType]}
            </Tag>
          ),
        },
        {
          key: 'object',
          label: 'Объект',
          full: true,
          children: `${request.objectCode} — ${request.objectName}`,
        },
        {
          key: 'delivery',
          label: 'Доставка',
          children: formatDateTimeMaybe(request.deliveryAt, request.deliveryTimeUnspecified),
        },
        {
          key: 'operator',
          label: 'Оператор вывоза',
          children: request.operatorName ?? 'не назначен',
        },
        // Who receives the truck on site (migration 0062): the arriving operator calls this phone.
        {
          key: 'responsible',
          label: 'Ответственный',
          children: (
            <ResponsibleValue name={request.responsibleName} phone={request.responsiblePhone} />
          ),
        },
        // A container is the subject only of container operations: removal orders a volume and
        // names no equipment (ADR 0022), and scrap has no volume either (ADR 0067). Older removal
        // requests still store a type, but a row about it would describe a field this request type
        // no longer has.
        ...(usesContainerType(request.requestType)
          ? [
              {
                key: 'containerType',
                label: 'Контейнер / машина',
                // Quantity is part of the subject label (ADR 0054).
                children: wasteSubjectLabel(request),
              },
            ]
          : []),
        // Owner applies only to replacement and removal of an existing site container (ADR 0054).
        ...(usesContainerGroup(request.requestType)
          ? [
              {
                key: 'containerOwner',
                label: 'Владелец контейнера',
                full: true,
                children: containerOwnerMismatch(request) ? (
                  <Typography.Text type="warning">
                    {`${request.containerOwnerName ?? 'не указан'} — вывозит «${request.operatorName ?? '—'}»`}
                  </Typography.Text>
                ) : (
                  (request.containerOwnerName ?? 'не указан')
                ),
              },
            ]
          : []),
        ...subjectFields(request),
        ...factFields(request),
        {
          key: 'author',
          label: 'Автор',
          children: (
            <Space size={8}>
              <UserAvatar name={request.createdByName} size="small" />
              <span>{request.createdByName}</span>
            </Space>
          ),
        },
        { key: 'createdAt', label: 'Создана', children: formatDateTime(request.createdAt) },
        ...(request.cancelReason
          ? [
              {
                key: 'cancelReason',
                label: 'Причина отмены',
                full: true,
                children: request.cancelReason,
              },
            ]
          : []),
        {
          key: 'comment',
          label: 'Комментарий',
          full: true,
          children: (
            <WasteRequestCommentField
              request={request}
              onSave={onSaveOperatorComment}
              saving={savingOperatorComment}
            />
          ),
        },
      ]
    : [];

  return (
    <ViewModal
      title={request ? `Заявка № ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onClose={onClose}
      width={1000}
      // Switching records must not retain expanded rows from the previous history.
      destroyOnHidden
      footer={[
        ...(request && onRollbackToDone
          ? [
              // A confirmation rather than a reason modal: this rollback erases nothing (ADR 0135
              // section 6), so there is nothing to explain, but the request leaves the journal for
              // the working list and the user must know that before clicking.
              <Popconfirm
                key="rollback"
                title="Вернуть заявку в «Выполнена»?"
                description="Заявка вернётся в рабочий список, а её талоны — в разбор: их снова можно править и подтверждать. Из заявки ничего не стирается."
                okText="Вернуть"
                cancelText="Отмена"
                onConfirm={() => onRollbackToDone(request)}
              >
                <Button loading={rollingBack}>Вернуть в «Выполнена»</Button>
              </Popconfirm>,
            ]
          : []),
        ...(request && onEdit
          ? [
              <Button key="edit" type="primary" onClick={() => onEdit(request)}>
                Редактировать
              </Button>,
            ]
          : []),
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* ViewFields owns responsive layout; field descriptors only request full width. */}
          <ViewFields items={fields} />

          {request.files.length > 0 && (
            <div>
              <Typography.Text strong>Файлы</Typography.Text>
              <FileLinkList files={request.files} maxNameWidth={420} />
            </div>
          )}

          <WasteRequestTickets
            adding={addingTickets}
            canReview={canReviewTickets}
            containerRef={ticketsRef}
            onAdd={onAddTickets}
            request={request}
          />

          <div>
            <Typography.Text strong>История</Typography.Text>
            <div style={{ marginTop: 12 }}>
              {isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Each row keeps the status transition beside its changed values.
                <RequestHistoryTable
                  rows={rows}
                  labels={wasteRequestChangeLabels}
                  // Evidence rows open by default because it is the usual reason to open the card.
                  defaultExpandedKeys={rows.filter((r) => r.details).map((r) => r.key)}
                />
              ) : (
                <Typography.Text type="secondary">История недоступна</Typography.Text>
              )}
            </div>
          </div>
        </div>
      )}
    </ViewModal>
  );
}
