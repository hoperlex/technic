import { Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import {
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  wasteFactLabel,
  type WasteRequestDto,
  wasteSubjectLabel,
} from '@technic/contracts';
import { type CardConfig } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { formatDate, formatDateTimeMaybe, formatMoney } from '../../utils/format';

/**
 * Как выглядит строка журнала закрытых заявок вывоза (ADR 0135) — отдельным модулем от самой
 * вкладки: описание столбцов и карточки телефона занимает больше места, чем вся её работа с
 * данными, и вместе они читались бы как один длинный файл ни о чём.
 */

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** Ключ колонки — он же поле сортировки на сервере (`WASTE_REQUEST_SORT_FIELDS`). */
export function wasteHistoryColumns(
  open: (r: WasteRequestDto) => void,
): TableColumnType<WasteRequestDto>[] {
  return [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 140,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            завёл {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    {
      // Журнал открывается датой подачи, а не датой закрытия: «когда вывозили» — то, по чему его
      // сводят с талонами и счетами. Вторая строка — когда заявку закрыли: план и факт расходятся,
      // и по журналу сводят оба. У отменённой закрытия нет, и строки тогда нет вовсе.
      key: 'deliveryAt',
      title: 'Когда',
      dataIndex: 'deliveryAt',
      width: 165,
      sorter: true,
      defaultSortOrder: 'descend',
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{formatDateTimeMaybe(r.deliveryAt, r.deliveryTimeUnspecified)}</div>
          {r.completion && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              закрыта {formatDate(r.completion.completedAt)}
            </Typography.Text>
          )}
        </div>
      ),
    },
    textColumn<WasteRequestDto>({
      key: 'objectName',
      title: 'Площадка',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_v, r) => <ObjectCell name={r.objectName} address={r.objectAddress} />,
    }),
    {
      key: 'requestType',
      title: 'Что вывозили',
      dataIndex: 'requestType',
      width: 200,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <Tag color={requestTypeColors[r.requestType]} style={{ whiteSpace: 'normal' }}>
            {requestTypeLabels[r.requestType]}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {wasteSubjectLabel(r)}
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'operatorName',
      title: 'Исполнитель',
      dataIndex: 'operatorName',
      width: 190,
      sorter: true,
      render: (_v, r) => r.operatorName ?? dash,
    },
    {
      // Факт вывоза (ADR 0035, ADR 0067): сколько увезли и во сколько это обошлось. У отменённой
      // заявки факта нет вовсе, у контейнерной операции — нет цены (ADR 0019).
      key: 'fact',
      title: 'Вывезено',
      width: 150,
      render: (_v, r) =>
        r.completion ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>{wasteFactLabel(r.completion)}</div>
            {r.completion.totalCost != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatMoney(r.completion.totalCost)}
              </Typography.Text>
            )}
          </div>
        ) : (
          dash
        ),
    },
    {
      key: 'status',
      title: 'Чем закончилась',
      dataIndex: 'status',
      width: 165,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          {/* Причина отмены — подсказкой на теге: столбца под неё нет, а без причины отменённая
              строка журнала не отвечает на «почему не поехали». */}
          <Tooltip title={r.cancelReason ? `Причина отмены: ${r.cancelReason}` : undefined}>
            <Tag color={requestStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
              {requestStatusLabels[r.status]}
            </Tag>
          </Tooltip>
          {r.completion && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                закрыл {r.completion.completedByName || '—'}
              </Typography.Text>
            </div>
          )}
        </div>
      ),
    },
    actionsColumn<WasteRequestDto>(
      (r) => (
        // Карточка — единственное место, где видны талоны, файлы и вся хронология заявки
        // (ADR 0012). Строка журнала отвечает «что было», карточка — «как к этому пришли».
        <RowActionButton title="Открыть карточку" icon={<EyeOutlined />} onClick={() => open(r)} />
      ),
      70,
    ),
  ];
}

/**
 * Строка журнала на телефоне (ADR 0030): чем закончилась заявка и сколько по ней вывезли — ради
 * этих двух ответов журнал и открывают.
 */
export function wasteHistoryCard(open: (r: WasteRequestDto) => void): CardConfig<WasteRequestDto> {
  return {
    title: (r) => r.displayNumber,
    badge: (r) => (
      <Tag color={requestStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
        {requestStatusLabels[r.status]}
      </Tag>
    ),
    primary: (r) => (r.completion ? wasteFactLabel(r.completion) : 'Без факта'),
    lines: [
      (r) => r.objectName,
      (r) => requestTypeLabels[r.requestType],
      (r) => formatDateTimeMaybe(r.deliveryAt, r.deliveryTimeUnspecified),
      (r) => (r.operatorName ? `Исполнитель: ${r.operatorName}` : null),
      (r) => (r.cancelReason ? `Причина отмены: ${r.cancelReason}` : null),
    ],
    onOpen: (r) => open(r),
    actions: (r) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => open(r),
      },
    ],
  };
}
