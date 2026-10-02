import { Button, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  containerOwnerMismatch,
  isPricedRequestType,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  usesContainerGroup,
  usesContainerType,
  wasteFactLabel,
  type WasteRequestDto,
  wasteRequestChangeLabels,
  wasteSubjectLabel,
} from '@technic/contracts';
import { wasteRequestKeys, wasteRequestsApi } from '@entities/waste-request';
import { WasteRequestCommentField } from '@features/waste-request-comment';
import { useAuth } from '@entities/session';
import { FileLinkList } from '@entities/file';
import { RequestHistoryTable } from '@entities/request-history';
import { ResponsibleValue } from '@entities/user-account';

import { formatDateTime, formatMoney, useScrollIntoViewWhen } from '@shared/lib';
import { UserAvatar, ViewFields, ViewModal } from '@shared/ui';
import { formatDateTimeMaybe } from '@entities/request';
import { buildWasteRequestHistoryRows } from './viewHistory';
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
  /** Omitted when this role or request state cannot edit the executor comment. */
  onSaveOperatorComment?: (r: WasteRequestDto, operatorComment: string) => void;
  savingOperatorComment?: boolean;
  /**
   * Roll a completed request back to Done (ADR 0135). The action belongs beside its evidence and
   * history because terminal requests are absent from the working-list status menu.
   */
  onRollbackToDone?: (r: WasteRequestDto) => void;
  rollingBack?: boolean;
  /** Attach late tickets beside existing evidence to avoid uploading the same scan twice. */
  onAddTickets?: (r: WasteRequestDto, ticketFileIds: string[]) => void;
  addingTickets?: boolean;
  /** A ticket-column entry scrolls directly to review (ADR 0195). */
  focus?: 'tickets' | null;
}

const secondary = { fontSize: 12 } as const;

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
  // External executors may complete work but cannot inspect recognition diagnostics (ADR 0114).
  const { can } = useAuth();
  const canReviewTickets = can('wasteRequests.ticketReview');
  const ticketsRef = useScrollIntoViewWhen<HTMLDivElement>(focus === 'tickets', request?.id);

  const { data: history, isPending } = useQuery({
    queryKey: wasteRequestKeys.history(request?.id),
    queryFn: () => wasteRequestsApi.history(request!.id),
    enabled: !!request,
  });

  // Legacy container requests can retain prices, so visibility follows stored data as well as type.
  const priced =
    request != null && (isPricedRequestType(request.requestType) || request.amount != null);
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
        // The arriving operator needs the site contact, not only its address.
        {
          key: 'responsible',
          label: 'Ответственный',
          children: (
            <ResponsibleValue name={request.responsibleName} phone={request.responsiblePhone} />
          ),
        },
        // Only container operations still own a container subject (ADR 0022, ADR 0067).
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
        ...(priced
          ? [
              {
                key: 'volume',
                label: 'Объём',
                children: request.volumeM3 != null ? `${request.volumeM3} м³` : '—',
              },
              { key: 'wasteType', label: 'Тип мусора', children: request.wasteTypeName ?? '—' },
              {
                key: 'amount',
                label: 'Стоимость',
                children:
                  request.amount == null ? (
                    // Name a missing tariff explicitly so it cannot be read as a free service.
                    request.wasteTypeId == null ? (
                      '—'
                    ) : (
                      <Typography.Text type="warning">
                        тариф не задан — стоимость не рассчитана
                      </Typography.Text>
                    )
                  ) : (
                    <div style={{ lineHeight: 1.3 }}>
                      {/* Without an operator, ADR 0026 uses the cheapest tariff; “from” signals
                          that assigning an operator will refine the price. */}
                      <div>
                        {request.operatorCounterpartyId ? '' : 'от '}
                        {formatMoney(request.amount)}
                      </div>
                      {request.pricePerM3 != null && (
                        <Typography.Text type="secondary" style={secondary}>
                          {formatMoney(request.pricePerM3)}/м³
                        </Typography.Text>
                      )}
                    </div>
                  ),
              },
            ]
          : []),
        // Completion is actual quantity and cost; legacy vehicle composition stays in history.
        ...(request.completion
          ? [
              {
                key: 'hauled',
                label: 'Вывезено',
                full: true,
                children: (
                  <div style={{ lineHeight: 1.3 }}>
                    <div>
                      {wasteFactLabel(request.completion)}
                      {request.completion.totalCost != null
                        ? ` · ${formatMoney(request.completion.totalCost)}`
                        : ''}
                    </div>
                    {request.completion.totalCost != null &&
                      request.amount != null &&
                      request.completion.totalCost !== request.amount && (
                        <Typography.Text type="secondary" style={secondary}>
                          заявка оформлялась на {formatMoney(request.amount)}
                        </Typography.Text>
                      )}
                    {request.completion.totalCost == null && (
                      <Typography.Text type="secondary" style={secondary}>
                        стоимость не указана — цены в прайсе не было
                      </Typography.Text>
                    )}
                  </div>
                ),
              },
            ]
          : []),
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
              // This rollback erases nothing, but confirmation makes the list transition explicit.
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
