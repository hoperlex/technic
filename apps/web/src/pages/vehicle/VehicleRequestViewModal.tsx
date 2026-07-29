import { Button, Descriptions, Modal, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { type ReactNode, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentRateLabel,
  assignmentTitle,
  type RequestHistoryEntryDto,
  requestStatusColors,
  requestStatusLabels,
  type VehicleRequestDto,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  vehicleRequestChangeLabels,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { AddressCell } from '../../components/AddressAutoComplete';
import { FileLinkList } from '../../components/FileLinks';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { UserAvatar } from '../../components/UserAvatar';
import { calendarDaysLabel } from '../../utils/date';
import { formatDateTime, formatDateTimeMaybe } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Карточка заявки на технику: поля только на чтение и история событий (ADR 0015). Открывается
 * кнопкой в «Действиях» — в таблице колонок на всё не хватает, а автор, адреса и то, кто и когда
 * заявку правил, нужны не в списке, а при разборе конкретной заявки. Правка — отдельным окном,
 * той же формой. Устроена как карточка заявки на вывоз (ADR 0012), только предъявлять при
 * закрытии здесь нечего: машин и талонов у заявок на технику нет.
 */
interface Props {
  /** null — окно закрыто; поля берутся из строки списка, отдельный запрос за ними не нужен. */
  request: VehicleRequestDto | null;
  onClose: () => void;
  /** Не передана — правка этой заявки недоступна (роль, статус или архив). */
  onEdit?: (r: VehicleRequestDto) => void;
}

function toRows(history: RequestHistoryEntryDto[] | undefined): HistoryRow[] {
  return (history ?? []).map((e) => ({ key: e.id, entry: e }));
}

/**
 * Срок: у спецтехники период работы, у грузоперевозки — дата подачи (и время, если задано).
 * К периоду приписано число календарных дней — та же подсказка, что и в форме заявки: по двум
 * датам длину аренды в уме считают с ошибкой, а решают по ней.
 */
function termOf(r: VehicleRequestDto): ReactNode {
  if (r.requestType !== 'special_equipment') {
    return formatDateTimeMaybe(r.scheduledAt, r.scheduledTimeUnspecified);
  }
  const period = r.dateTo
    ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
    : formatDateOnly(r.dateFrom);
  const days = calendarDaysLabel(r.dateFrom, r.dateTo);
  return (
    <Space size={6} wrap>
      <span>{period}</span>
      {days && <Typography.Text type="secondary">{days}</Typography.Text>}
    </Space>
  );
}

export function VehicleRequestViewModal({ request, onClose, onEdit }: Props) {
  const { data: history, isPending } = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'history'],
    queryFn: () => vehicleRequestsApi.history(request!.id),
    enabled: !!request,
  });

  const rows = useMemo(() => toRows(history), [history]);

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
            <Tag color={vehicleRequestTypeColors[request.requestType]}>
              {vehicleRequestTypeLabels[request.requestType]}
            </Tag>
          ),
        },
        {
          // Виза (ADR 0025): в карточке важно не только «есть ли», но и кто согласовал.
          key: 'approval',
          label: 'Согласование',
          span: 2,
          children: request.approvedAt ? (
            <Space size={8}>
              <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
                Завизирована
              </Tag>
              <span>
                {request.approvedByName ?? '—'} · {formatDateTime(request.approvedAt)}
              </span>
            </Space>
          ) : (
            <Tag color="orange" icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
              Ждёт визы руководителя строительства
            </Tag>
          ),
        },
        {
          key: 'object',
          label: 'Объект',
          span: 2,
          children: `${request.objectCode} — ${request.objectName}`,
        },
        { key: 'vehicleType', label: 'Тип ТС', children: request.vehicleTypeName },
        // Назначенная техника (ADR 0027): у «Новой» заявки её нет, у остальных это ответ на
        // вопрос «чем и почём» — вместе с тем, кто и когда назначил.
        {
          key: 'assignment',
          label: 'Техника',
          span: 2,
          children: request.assignment ? (
            <Space direction="vertical" size={2}>
              <Space size={8} wrap>
                <span>{assignmentTitle(request.assignment)}</span>
                <Tag color={vehicleOwnershipColors[request.assignment.ownership]}>
                  {vehicleOwnershipLabels[request.assignment.ownership]}
                </Tag>
                {request.assignment.lessorName && <Tag>{request.assignment.lessorName}</Tag>}
              </Space>
              <Typography.Text>
                {assignmentRateLabel(request.assignment) || 'Ставка не указана'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Назначил {request.assignment.assignedByName || '—'} ·{' '}
                {formatDateTime(request.assignment.assignedAt)}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              Не назначена — заявку ещё не брали в работу
            </Typography.Text>
          ),
        },
        {
          key: 'term',
          label: request.requestType === 'special_equipment' ? 'Период работы' : 'Подача',
          children: termOf(request),
        },
        // Объём/масса и адреса есть только у грузоперевозки: спецтехника заказывается на срок.
        ...(request.requestType === 'freight_transport'
          ? [
              {
                key: 'amount',
                label: 'Объём / масса',
                span: 2,
                children:
                  [
                    request.volumeM3 != null ? `${request.volumeM3} м³` : null,
                    request.weightTons != null ? `${request.weightTons} т` : null,
                  ]
                    .filter(Boolean)
                    .join(' / ') || '—',
              },
              {
                key: 'loading',
                label: 'Погрузка',
                span: 2,
                // Отметка о верификации адреса (ADR 0006) — та же, что в таблице.
                children: (
                  <AddressCell text={request.loadingLocation} meta={request.loadingAddress} />
                ),
              },
              {
                key: 'unloading',
                label: 'Разгрузка',
                span: 2,
                children: (
                  <AddressCell text={request.unloadingLocation} meta={request.unloadingAddress} />
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
                span: 2,
                children: request.cancelReason,
              },
            ]
          : []),
        { key: 'comment', label: 'Комментарий', span: 2, children: request.comment || '—' },
      ]
    : [];

  return (
    <Modal
      title={request ? `Заявка ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onCancel={onClose}
      width={760}
      centered
      mask={{ closable: false }}
      // Окно переоткрывают на соседней заявке — раскрытые строки прошлой истории не её дело.
      destroyOnHidden
      footer={[
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
      styles={{
        container: {
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100dvh - 48px)',
          overflow: 'hidden',
        },
        body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
      }}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Descriptions size="small" bordered column={2} items={fields} />

          {request.files.length > 0 && (
            <div>
              <Typography.Text strong>Файлы</Typography.Text>
              <FileLinkList files={request.files} maxNameWidth={420} />
            </div>
          )}

          <div>
            <Typography.Text strong>История</Typography.Text>
            <div style={{ marginTop: 12 }}>
              {isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Событие строкой: слева баблы статусов, детали — подстроками при раскрытии.
                <RequestHistoryTable rows={rows} labels={vehicleRequestChangeLabels} />
              ) : (
                <Typography.Text type="secondary">История недоступна</Typography.Text>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
