import { Button, Descriptions, List, Modal, Space, Spin, Tag, Timeline, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  isPricedRequestType,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  requestTypeShort,
  type WasteRequestDto,
  type WasteRequestHistoryEntryDto,
  wasteRequestChangeLabels,
} from '@technic/contracts';
import { filesApi, wasteRequestsApi } from '../../api/resources';
import { UserAvatar } from '../../components/UserAvatar';
import { formatBytes, formatDateTime, formatDateTimeMaybe, formatMoney } from '../../utils/format';

/**
 * Карточка заявки: поля только на чтение и история событий (ADR 0012). Открывается кликом по
 * номеру в списке — там колонок на всё не хватает, а автор, цена за м³ и состав машин нужны
 * не в таблице, а при разборе конкретной заявки. Правка — отдельным окном, той же формой.
 */
interface Props {
  /** null — окно закрыто; поля берутся из строки списка, отдельный запрос за ними не нужен. */
  request: WasteRequestDto | null;
  onClose: () => void;
  /** Не передана — правка этой заявки недоступна (роль, статус или архив). */
  onEdit?: (r: WasteRequestDto) => void;
}

const HISTORY_TITLES: Record<WasteRequestHistoryEntryDto['kind'], string> = {
  created: 'Заявка создана',
  updated: 'Заявка отредактирована',
  status: 'Смена статуса',
  operator: 'Смена исполнителя',
  deleted: 'Перемещена в архив',
  restored: 'Восстановлена из архива',
};

/** Цвета ленты: у Timeline своя палитра, `gold` тега здесь выглядел бы выцветшим. */
const STATUS_DOT_COLORS: Record<RequestStatus, string> = {
  new: 'blue',
  confirmed: '#faad14',
  done: 'green',
  cancelled: 'red',
};

function dotColor(e: WasteRequestHistoryEntryDto): string {
  switch (e.kind) {
    case 'status':
      return e.toStatus ? STATUS_DOT_COLORS[e.toStatus] : 'blue';
    case 'created':
      return 'blue';
    case 'deleted':
      return 'red';
    case 'restored':
      return 'green';
    default:
      return 'gray';
  }
}

function entryTitle(e: WasteRequestHistoryEntryDto): string {
  if (e.kind === 'status' && e.toStatus) {
    const from = e.fromStatus ? requestStatusLabels[e.fromStatus] : '—';
    return `${from} → ${requestStatusLabels[e.toStatus]}`;
  }
  return HISTORY_TITLES[e.kind];
}

const secondary = { fontSize: 12 } as const;

function HistoryContent({ entry }: { entry: WasteRequestHistoryEntryDto }) {
  // Комментарий к отмене — это её причина: без подписи он читается как обычная заметка.
  const comment = entry.comment
    ? entry.toStatus === 'cancelled'
      ? `Причина: ${entry.comment}`
      : entry.comment
    : null;
  // Правки до появления истории деталей не несут — молчать об этом хуже, чем сказать прямо.
  const noDetails = entry.kind === 'updated' && entry.changes.length === 0;
  if (!comment && !noDetails && entry.changes.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {comment && <Typography.Text>{comment}</Typography.Text>}
      {entry.changes.map((c, i) => (
        <Typography.Text key={`${c.field}-${i}`} type="secondary" style={secondary}>
          {wasteRequestChangeLabels[c.field] ?? c.field}:{' '}
          {c.from === null ? c.to : `${c.from} → ${c.to}`}
        </Typography.Text>
      ))}
      {noDetails && (
        <Typography.Text type="secondary" style={secondary}>
          Состав изменений не записан
        </Typography.Text>
      )}
    </div>
  );
}

export function WasteRequestViewModal({ request, onClose, onEdit }: Props) {
  const { data: history, isPending } = useQuery({
    queryKey: ['waste-requests', request?.id, 'history'],
    queryFn: () => wasteRequestsApi.history(request!.id),
    enabled: !!request,
  });

  const priced = request ? isPricedRequestType(request.requestType) : false;
  const activeVehicles = request?.vehicles.filter((v) => !v.isDeleted).length ?? 0;

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
          span: 2,
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
        {
          key: 'containerType',
          label: 'Контейнер / машина',
          span: priced ? 1 : 2,
          children: request.containerTypeName ?? '—',
        },
        // Тип мусора, объём и цена есть только у тарифицируемых операций (ADR 0009).
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
                children: (
                  <div style={{ lineHeight: 1.3 }}>
                    <div>{formatMoney(request.amount)}</div>
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
      title={
        request ? `Заявка № ${request.num}-${requestTypeShort[request.requestType]}` : 'Заявка'
      }
      open={!!request}
      onCancel={onClose}
      width={760}
      centered
      mask={{ closable: false }}
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
            <List
              size="small"
              header={<Typography.Text strong>Файлы</Typography.Text>}
              dataSource={request.files}
              renderItem={(f) => (
                <List.Item
                  actions={[
                    <Button
                      key="dl"
                      type="link"
                      size="small"
                      onClick={() => void filesApi.download(f.id)}
                    >
                      Скачать
                    </Button>,
                  ]}
                >
                  <Typography.Text ellipsis style={{ maxWidth: 420 }}>
                    {f.filename}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={secondary}>
                    {formatBytes(f.size)}
                  </Typography.Text>
                </List.Item>
              )}
            />
          )}

          {/* Машины и талоны (ADR 0011): помеченные на удаление остаются в списке зачёркнутыми —
              иначе снятый талон нечем заметить. */}
          {request.vehicles.length > 0 && (
            <List
              size="small"
              header={
                <Space size={8}>
                  <Typography.Text strong>Машины и талоны</Typography.Text>
                  <Typography.Text type="secondary" style={secondary}>
                    активных: {activeVehicles}
                  </Typography.Text>
                </Space>
              }
              dataSource={request.vehicles}
              renderItem={(v) => (
                <List.Item>
                  <Typography.Text
                    delete={v.isDeleted}
                    type={v.isDeleted ? 'secondary' : undefined}
                  >
                    {v.containerTypeName} — {v.volumeM3} м³
                  </Typography.Text>
                  <Typography.Text type="secondary" style={secondary}>
                    {v.files.length > 0 ? `талонов: ${v.files.length}` : 'без талона'}
                    {v.isDeleted ? ' · помечена на удаление' : ''}
                  </Typography.Text>
                </List.Item>
              )}
            />
          )}

          <div>
            <Typography.Text strong>История</Typography.Text>
            <div style={{ marginTop: 12 }}>
              {isPending ? (
                <Spin size="small" />
              ) : history && history.length > 0 ? (
                <Timeline
                  items={history.map((e) => ({
                    key: e.id,
                    color: dotColor(e),
                    title: (
                      <Space size={8} wrap>
                        <Typography.Text strong>{entryTitle(e)}</Typography.Text>
                        <Typography.Text type="secondary" style={secondary}>
                          {formatDateTime(e.at)} · {e.actorName ?? '—'}
                        </Typography.Text>
                      </Space>
                    ),
                    content: <HistoryContent entry={e} />,
                  }))}
                />
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
