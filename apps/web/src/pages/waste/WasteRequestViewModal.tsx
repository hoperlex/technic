import { Button, Descriptions, Modal, Space, Spin, Tag, Typography } from 'antd';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  type FileDto,
  isPricedRequestType,
  type RequestHistoryEntryDto,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  requestTypeShort,
  sumVehicleVolume,
  type WasteRequestDto,
  type WasteRequestVehicleDto,
  wasteRequestChangeLabels,
} from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { FileLinkList, FilesButton } from '../../components/FileLinks';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
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

const secondary = { fontSize: 12 } as const;

/**
 * Машины и талоны показываются у закрытия заявки, а не в теле карточки: и машины (ADR 0011),
 * и талоны заявки (ADR 0013) заводятся именно при переходе в «Выполнена» — к нему они
 * и цепляются, а разбирают их всё равно поштучно.
 */
function ClosingFact({
  vehicles,
  tickets,
}: {
  vehicles: WasteRequestVehicleDto[];
  tickets: FileDto[];
}) {
  return (
    <>
      {/* Помеченные на удаление остаются в списке зачёркнутыми — иначе снятый талон нечем
          заметить. Талоны открываются отдельным окном: их смотрят по одному. */}
      {vehicles.map((v) => (
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
      {/* Талоны заявки без машин: у контейнерной операции ходка одна, и делить талоны не по чему
          (ADR 0013). Кнопкой — как у машин: список открывается окном, файлы смотрят по одному. */}
      {tickets.length > 0 && (
        <Space size={8} wrap>
          <Typography.Text>Талоны заявки</Typography.Text>
          <FilesButton files={tickets} title="Талоны заявки" label={`талонов: ${tickets.length}`} />
        </Space>
      )}
    </>
  );
}

/** Чем предъявлен факт выполнения: машинами (ADR 0011) или талонами заявки (ADR 0013). */
function factOf(vehicles: WasteRequestVehicleDto[], tickets: FileDto[]): string {
  if (vehicles.length > 0) return `машин: ${vehicles.length}`;
  return tickets.length > 0 ? `талонов: ${tickets.length}` : '';
}

function buildRows(
  history: RequestHistoryEntryDto[] | undefined,
  vehicles: WasteRequestVehicleDto[],
  tickets: FileDto[],
): HistoryRow[] {
  const entries = history ?? [];
  // Повторное закрытие (после отката) — последнее слово о факте, к нему его и цепляем.
  const closingIndex = entries.findLastIndex((e) => e.kind === 'status' && e.toStatus === 'done');
  // Закрытие без единой машины и талона (контейнерная операция, талон донесут позже) не должно
  // раскрываться в пустоту — тогда факта у строки просто нет.
  const fact: Partial<HistoryRow> =
    vehicles.length > 0 || tickets.length > 0
      ? {
          fact: factOf(vehicles, tickets),
          details: <ClosingFact vehicles={vehicles} tickets={tickets} />,
        }
      : {};
  const rows = entries.map<HistoryRow>((e, i) => ({
    key: e.id,
    entry: e,
    ...(i === closingIndex ? fact : {}),
  }));
  // Машины у незакрытой заявки (их можно завести и правкой) без такой строки просто пропали бы;
  // талоны без закрытия означают обрезанную историю — молчать о них так же нельзя.
  if (closingIndex < 0 && (vehicles.length > 0 || tickets.length > 0)) {
    rows.push({
      key: 'fact',
      entry: null,
      tag: vehicles.length > 0 ? 'Машины' : 'Талоны',
      ...fact,
    });
  }
  return rows;
}

export function WasteRequestViewModal({ request, onClose, onEdit }: Props) {
  const { data: history, isPending } = useQuery({
    queryKey: ['waste-requests', request?.id, 'history'],
    queryFn: () => wasteRequestsApi.history(request!.id),
    enabled: !!request,
  });

  /**
   * Блок «объём — тип мусора — стоимость» показывается по самим данным, а не по типу заявки:
   * тарифицируется только вывоз самосвалами (ADR 0019), но у замены и снятия, заведённых до
   * этого решения, цена сохранена — прятать её значило бы потерять историю сумм.
   */
  const priced =
    request != null && (isPricedRequestType(request.requestType) || request.amount != null);
  const activeVehicles = request?.vehicles.filter((v) => !v.isDeleted).length ?? 0;
  const rows = useMemo(
    () => buildRows(history, request?.vehicles ?? [], request?.tickets ?? []),
    [history, request?.vehicles, request?.tickets],
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

          {/* Талоны стоят отдельным блоком от документов заявки: это не сопроводительная
              бумага, а подтверждение вывоза (ADR 0013). У вывоза самосвалами список пуст —
              там талоны висят на машинах и показаны в истории, у их закрытия. */}
          {request.tickets.length > 0 && (
            <div>
              <Typography.Text strong>Талоны</Typography.Text>
              <FileLinkList files={request.tickets} maxNameWidth={420} />
            </div>
          )}

          <div>
            <Typography.Text strong>История</Typography.Text>
            <div style={{ marginTop: 12 }}>
              {isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Событие строкой: слева баблы статусов, детали — подстроками при раскрытии.
                <RequestHistoryTable
                  rows={rows}
                  labels={wasteRequestChangeLabels}
                  // Машины и талоны раскрыты сразу: за ними карточку и открывают.
                  defaultExpandedKeys={rows.filter((r) => r.details).map((r) => r.key)}
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
