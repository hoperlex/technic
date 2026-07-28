import {
  Button,
  Descriptions,
  Modal,
  Space,
  Spin,
  Table,
  type TableColumnsType,
  Tag,
  Typography,
} from 'antd';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  isPricedRequestType,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  requestTypeShort,
  sumVehicleVolume,
  type WasteRequestDto,
  type WasteRequestHistoryEntryDto,
  type WasteRequestVehicleDto,
  wasteRequestChangeLabels,
} from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { FileLinkList, FilesButton } from '../../components/FileLinks';
import { UserAvatar } from '../../components/UserAvatar';
import { formatDateTime, formatDateTimeMaybe, formatMoney } from '../../utils/format';

/**
 * Карточка заявки: поля только на чтение и история событий (ADR 0012). Открывается кнопкой в
 * «Действиях» — в таблице колонок на всё не хватает, а автор, цена за м³ и состав машин нужны
 * не в списке, а при разборе конкретной заявки. Правка — отдельным окном, той же формой.
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

/** События без перехода статуса тоже начинаются с бабла — иначе первая колонка рвётся. */
const KIND_TAGS: Record<string, { label: string; color?: string }> = {
  updated: { label: 'Правка' },
  operator: { label: 'Исполнитель', color: 'geekblue' },
  deleted: { label: 'Архив', color: 'red' },
  restored: { label: 'Из архива', color: 'green' },
};

const secondary = { fontSize: 12 } as const;

/** В Space тег ведёт свой отступ сам — собственный правый отступ ставит лишнюю дырку. */
const tagStyle = { marginInlineEnd: 0 } as const;

/**
 * Строка истории: событие и машины, заведённые при нём. Машины показываются у закрытия заявки —
 * там их и заводят (ADR 0011); в теле карточки они занимали место, а талоны всё равно
 * разбирают поштучно.
 */
interface HistoryRow {
  key: string;
  /** null — машины есть, а закрытия в истории нет: строка состояния, а не событие. */
  entry: WasteRequestHistoryEntryDto | null;
  vehicles: WasteRequestVehicleDto[];
}

function buildRows(
  history: WasteRequestHistoryEntryDto[] | undefined,
  vehicles: WasteRequestVehicleDto[],
): HistoryRow[] {
  const entries = history ?? [];
  // Повторное закрытие (после отката) — последнее слово о машинах, к нему их и цепляем.
  const closingIndex = entries.findLastIndex((e) => e.kind === 'status' && e.toStatus === 'done');
  const rows = entries.map<HistoryRow>((e, i) => ({
    key: e.id,
    entry: e,
    vehicles: i === closingIndex ? vehicles : [],
  }));
  // Машины у незакрытой заявки (их можно завести и правкой) без такой строки просто пропали бы.
  if (closingIndex < 0 && vehicles.length > 0) {
    rows.push({ key: 'vehicles', entry: null, vehicles });
  }
  return rows;
}

function StatusBubbles({ row }: { row: HistoryRow }) {
  const e = row.entry;
  if (!e) return <Tag style={tagStyle}>Машины</Tag>;
  if (e.kind === 'status' || e.kind === 'created') {
    // Заведение заявки — переход «ниоткуда»: слева пусто, справа статус, с которого она начата.
    const to = e.toStatus ?? 'new';
    return (
      <Space size={4} wrap>
        {e.fromStatus && (
          <>
            <Tag color={requestStatusColors[e.fromStatus]} style={tagStyle}>
              {requestStatusLabels[e.fromStatus]}
            </Tag>
            <Typography.Text type="secondary">→</Typography.Text>
          </>
        )}
        <Tag color={requestStatusColors[to]} style={tagStyle}>
          {requestStatusLabels[to]}
        </Tag>
      </Space>
    );
  }
  const tag = KIND_TAGS[e.kind];
  return (
    <Tag color={tag?.color} style={tagStyle}>
      {tag?.label ?? HISTORY_TITLES[e.kind]}
    </Tag>
  );
}

/** Строка свёрнутая: чем событие было. Значения изменений и машины — уже в раскрытой части. */
function summaryOf(row: HistoryRow): string {
  const e = row.entry;
  if (!e) return `машин: ${row.vehicles.length}`;
  // Комментарий к отмене — это её причина: без подписи он читается как обычная заметка.
  if (e.comment) return e.toStatus === 'cancelled' ? `Причина: ${e.comment}` : e.comment;
  if (row.vehicles.length > 0) return `машин: ${row.vehicles.length}`;
  // У назначения исполнителя суть — имя контрагента, а не то, что поле трогали.
  const operator = e.kind === 'operator' ? e.changes.find((c) => c.field === 'operator') : null;
  if (operator)
    return operator.to && operator.to !== '—' ? `назначен ${operator.to}` : 'снят исполнитель';
  if (e.changes.length > 0) {
    return e.changes.map((c) => wasteRequestChangeLabels[c.field] ?? c.field).join(', ');
  }
  // Правки до появления истории деталей не несут — молчать об этом хуже, чем сказать прямо.
  if (e.kind === 'updated') return 'состав изменений не записан';
  // Переход виден по баблам — повторять его словами незачем.
  return e.kind === 'status' ? '' : HISTORY_TITLES[e.kind];
}

function hasDetails(row: HistoryRow): boolean {
  return row.vehicles.length > 0 || !!row.entry?.comment || (row.entry?.changes.length ?? 0) > 0;
}

function HistoryDetails({ row }: { row: HistoryRow }) {
  const e = row.entry;
  const comment = e?.comment
    ? e.toStatus === 'cancelled'
      ? `Причина: ${e.comment}`
      : e.comment
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {comment && <Typography.Text>{comment}</Typography.Text>}
      {e?.changes.map((c, i) => (
        <Typography.Text key={`${c.field}-${i}`} type="secondary" style={secondary}>
          {wasteRequestChangeLabels[c.field] ?? c.field}:{' '}
          {c.from === null ? c.to : `${c.from} → ${c.to}`}
        </Typography.Text>
      ))}
      {/* Помеченные на удаление остаются в списке зачёркнутыми — иначе снятый талон нечем
          заметить. Талоны открываются отдельным окном: их смотрят по одному. */}
      {row.vehicles.map((v) => (
        <Space key={v.id} size={8} wrap>
          <Typography.Text delete={v.isDeleted} type={v.isDeleted ? 'secondary' : undefined}>
            {v.containerTypeName} — {v.volumeM3} м³
          </Typography.Text>
          <FilesButton
            files={v.files}
            title={`Талоны — ${v.containerTypeName}`}
            label={`талонов: ${v.files.length}`}
            emptyText="без талона"
          />
          {v.isDeleted && (
            <Typography.Text type="secondary" style={secondary}>
              помечена на удаление
            </Typography.Text>
          )}
        </Space>
      ))}
    </div>
  );
}

// Ширины держат колонки в пределах окна: шире суммы столбцы вытолкнули бы таблицу
// в горизонтальную прокрутку, а история читается только сверху вниз.
const historyColumns: TableColumnsType<HistoryRow> = [
  {
    key: 'bubbles',
    width: 190,
    render: (_v, row) => <StatusBubbles row={row} />,
  },
  {
    key: 'summary',
    render: (_v, row) => (
      <Typography.Text ellipsis={{ tooltip: true }} style={{ maxWidth: 250 }}>
        {summaryOf(row)}
      </Typography.Text>
    ),
  },
  {
    key: 'when',
    width: 190,
    align: 'right',
    render: (_v, row) =>
      row.entry && (
        // Время и автор — двумя строками: в одну длинное ФИО рвётся как попало.
        <div style={{ lineHeight: 1.4 }}>
          <Typography.Text type="secondary" style={secondary}>
            {formatDateTime(row.entry.at)}
          </Typography.Text>
          <div>
            <Typography.Text type="secondary" ellipsis style={{ ...secondary, maxWidth: 170 }}>
              {row.entry.actorName ?? '—'}
            </Typography.Text>
          </div>
        </div>
      ),
  },
];

export function WasteRequestViewModal({ request, onClose, onEdit }: Props) {
  const { data: history, isPending } = useQuery({
    queryKey: ['waste-requests', request?.id, 'history'],
    queryFn: () => wasteRequestsApi.history(request!.id),
    enabled: !!request,
  });

  const priced = request ? isPricedRequestType(request.requestType) : false;
  const activeVehicles = request?.vehicles.filter((v) => !v.isDeleted).length ?? 0;
  const rows = useMemo(
    () => buildRows(history, request?.vehicles ?? []),
    [history, request?.vehicles],
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
        // Итог по машинам: сами они с талонами — в истории, у закрытия заявки.
        ...(request.vehicles.length > 0
          ? [
              {
                key: 'hauled',
                label: 'Вывезено',
                children: `${sumVehicleVolume(request.vehicles)} м³ · машин: ${activeVehicles}`,
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
                <Table
                  size="small"
                  showHeader={false}
                  pagination={false}
                  rowKey="key"
                  columns={historyColumns}
                  dataSource={rows}
                  expandable={{
                    rowExpandable: hasDetails,
                    expandRowByClick: true,
                    expandedRowRender: (row) => <HistoryDetails row={row} />,
                    // Машины раскрыты сразу: за талонами карточку и открывают.
                    defaultExpandedRowKeys: rows
                      .filter((r) => r.vehicles.length > 0)
                      .map((r) => r.key),
                  }}
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
