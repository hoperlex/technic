import { useState, type ReactNode } from 'react';
import {
  ConfigProvider,
  Space,
  Table,
  type TableColumnsType,
  Tag,
  type ThemeConfig,
  Typography,
} from 'antd';
import {
  type RequestHistoryEntryDto,
  requestStatusColors,
  requestStatusLabels,
} from '@technic/contracts';
import { useIsMobile } from '@shared/lib';
import { HISTORY_TITLES, KIND_TAGS } from '@entities/request-history';
import { formatDateTime } from '../utils/format';

/**
 * История заявки списком, а не лентой (ADR 0012): слева баблы статусов со стрелкой (у событий
 * без перехода — тег вида события), в середине суть события со значениями изменений, справа
 * «когда · кто».
 *
 * На широком экране событие показывается целиком, без раскрытия: кнопка-раскрывашка занимала
 * колонку и сдвигала весь список вправо, а прятала она две-три строки. На телефоне раскрытие
 * остаётся — там колонки и так сложены в карточку (ADR 0030), и место экономить есть на чём.
 *
 * Общая для обоих модулей заявок: события у них одной формы, различаются только подписи полей
 * и то, чем заявка закрывается (машины и талоны у вывоза мусора — ADR 0011, 0013).
 */

const secondary = { fontSize: 12 } as const;

/**
 * Событие занимает несколько строк, поэтому вертикальный отступ ячейки урезан до 4 px: иначе
 * десяток правок растёт вниз втрое. Правится токеном таблицы, а не CSS поверх antd, и только
 * внутри истории — остальные мелкие таблицы остаются как были. Объект собран один раз:
 * новый на каждый рендер сбрасывал бы кэш стилей antd.
 */
const historyTableTheme: ThemeConfig = { components: { Table: { cellPaddingBlockSM: 4 } } };

/** В Space тег ведёт свой отступ сам — собственный правый отступ ставит лишнюю дырку. */
const tagStyle = { marginInlineEnd: 0 } as const;

/** Строка истории: событие и предъявленный при нём факт. */
export interface HistoryRow {
  key: string;
  /** null — факт есть, а события в истории нет: строка состояния, а не событие. */
  entry: RequestHistoryEntryDto | null;
  /** Бабл строки состояния; у события баблы задаёт сам переход или вид события. */
  tag?: string;
  /** Короткая суть вместо перечня полей: чем предъявлен факт («машин: 3»). */
  fact?: string;
  /** Подстроки при раскрытии сверх комментария и перечня изменений. */
  details?: ReactNode;
}

/**
 * Подписи и цвета статусов модуля. По умолчанию — общий перечень заявок («Вывоз мусора», «Заказ
 * ТС»), но у модуля обслуживания оргтехники цикл свой (ADR 0085), и его статусы этот словарь не
 * знает: без параметра переход подписывался бы чужими словами или пустотой.
 */
export interface HistoryStatusDict {
  labels: Record<string, string>;
  colors: Record<string, string>;
}

const DEFAULT_STATUS_DICT: HistoryStatusDict = {
  labels: requestStatusLabels,
  colors: requestStatusColors,
};

function StatusBubbles({ row, statuses }: { row: HistoryRow; statuses: HistoryStatusDict }) {
  const e = row.entry;
  if (!e) return <Tag style={tagStyle}>{row.tag ?? '—'}</Tag>;
  if (e.kind === 'status' || e.kind === 'created') {
    // Заведение заявки — переход «ниоткуда»: слева пусто, справа статус, с которого она начата.
    const to = e.toStatus ?? 'new';
    return (
      <Space size={4} wrap>
        {e.fromStatus && (
          <>
            <Tag color={statuses.colors[e.fromStatus]} style={tagStyle}>
              {statuses.labels[e.fromStatus]}
            </Tag>
            <Typography.Text type="secondary">→</Typography.Text>
          </>
        )}
        <Tag color={statuses.colors[to]} style={tagStyle}>
          {statuses.labels[to]}
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

/** Комментарий к отмене — это её причина: без подписи он читается как обычная заметка. */
function commentOf(entry: RequestHistoryEntryDto | null | undefined): string | null {
  if (!entry?.comment) return null;
  return entry.toStatus === 'cancelled' ? `Причина: ${entry.comment}` : entry.comment;
}

/** Строка свёрнутая (телефон): чем событие было. Значения изменений и факт — в раскрытой части. */
function summaryOf(row: HistoryRow, labels: Record<string, string>): string {
  const e = row.entry;
  if (!e) return row.fact ?? '';
  const comment = commentOf(e);
  if (comment) return comment;
  if (row.fact) return row.fact;
  // У назначения исполнителя суть — имя контрагента, а не то, что поле трогали.
  const operator = e.kind === 'operator' ? e.changes.find((c) => c.field === 'operator') : null;
  if (operator)
    return operator.to && operator.to !== '—' ? `назначен ${operator.to}` : 'снят исполнитель';
  // У назначения техники — сама машина: ставки видны при раскрытии, а в строке важно, чем взяли.
  const vehicle = e.kind === 'assigned' ? e.changes.find((c) => c.field === 'vehicle') : null;
  if (vehicle?.to) return vehicle.to;
  if (e.changes.length > 0) return e.changes.map((c) => labels[c.field] ?? c.field).join(', ');
  // Правки до появления истории деталей не несут — молчать об этом хуже, чем сказать прямо.
  if (e.kind === 'updated') return 'состав изменений не записан';
  // Переход виден по баблам — повторять его словами незачем.
  return e.kind === 'status' ? '' : HISTORY_TITLES[e.kind];
}

function hasDetails(row: HistoryRow): boolean {
  return !!row.details || !!row.entry?.comment || (row.entry?.changes.length ?? 0) > 0;
}

/** Что правка изменила: у появившегося значения «было» нет — стрелка из пустоты только мешает. */
function ChangeLines({
  row,
  labels,
}: {
  row: HistoryRow;
  labels: Record<string, string>;
}): ReactNode {
  return row.entry?.changes.map((c, i) => (
    <Typography.Text key={`${c.field}-${i}`} type="secondary" style={secondary}>
      {labels[c.field] ?? c.field}: {c.from === null ? c.to : `${c.from} → ${c.to}`}
    </Typography.Text>
  ));
}

function HistoryDetails({ row, labels }: { row: HistoryRow; labels: Record<string, string> }) {
  const comment = commentOf(row.entry);
  return (
    <div className="history-cell">
      {comment && <Typography.Text>{comment}</Typography.Text>}
      <ChangeLines row={row} labels={labels} />
      {row.details}
    </div>
  );
}

/**
 * Событие целиком, без раскрытия: суть, значения изменений и предъявленный факт идут одной
 * колонкой. Короткая суть при них лишняя — «Исполнитель: — → ООО „Ромашка“» и «Вывезено 3 м³»
 * говорят то же самое подробнее, и одно и то же читалось бы дважды подряд.
 */
function HistoryContent({ row, labels }: { row: HistoryRow; labels: Record<string, string> }) {
  const comment = commentOf(row.entry);
  const spoken = (row.entry?.changes.length ?? 0) > 0 || !!row.details;
  const headline = comment ?? (spoken ? null : summaryOf(row, labels));
  return (
    <div className="history-cell">
      {headline && <Typography.Text>{headline}</Typography.Text>}
      <ChangeLines row={row} labels={labels} />
      {row.details}
    </div>
  );
}

// Ширины держат колонки в пределах окна: шире суммы столбцы вытолкнули бы таблицу
// в горизонтальную прокрутку, а история читается только сверху вниз.
function columnsWith(
  labels: Record<string, string>,
  statuses: HistoryStatusDict,
): TableColumnsType<HistoryRow> {
  return [
    {
      key: 'bubbles',
      width: 190,
      render: (_v, row) => <StatusBubbles row={row} statuses={statuses} />,
    },
    {
      key: 'summary',
      render: (_v, row) => <HistoryContent row={row} labels={labels} />,
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
}

/**
 * Событие на телефоне — карточка, а не строка из трёх колонок (ADR 0030): 190 + 250 + 190 px
 * там не помещаются, и время с автором уезжают под горизонтальную прокрутку. Модель прежняя
 * (ADR 0012): свёрнутое событие отвечает «что произошло», подробности раскрываются касанием.
 */
function MobileHistoryList({
  rows,
  labels,
  statuses,
  defaultExpandedKeys,
}: {
  rows: HistoryRow[];
  labels: Record<string, string>;
  statuses: HistoryStatusDict;
  defaultExpandedKeys?: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(defaultExpandedKeys ?? []));
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="history-list">
      {rows.map((row) => {
        const summary = summaryOf(row, labels);
        const expandable = hasDetails(row);
        const open = expanded.has(row.key);
        return (
          <div
            key={row.key}
            className={`history-item${expandable ? ' history-item--expandable' : ''}`}
            onClick={expandable ? () => toggle(row.key) : undefined}
          >
            <div className="history-item__head">
              <StatusBubbles row={row} statuses={statuses} />
              {row.entry && (
                <Typography.Text type="secondary" style={secondary}>
                  {formatDateTime(row.entry.at)}
                </Typography.Text>
              )}
            </div>
            {summary && <div>{summary}</div>}
            {row.entry && (
              <Typography.Text type="secondary" style={secondary}>
                {row.entry.actorName ?? '—'}
              </Typography.Text>
            )}
            {expandable &&
              (open ? (
                <HistoryDetails row={row} labels={labels} />
              ) : (
                <Typography.Link style={secondary}>Подробнее</Typography.Link>
              ))}
          </div>
        );
      })}
    </div>
  );
}

export function RequestHistoryTable({
  rows,
  /** Подписи полей модуля: сервер шлёт технические ключи (`wasteRequestChangeLabels`). */
  labels,
  /** Подписи и цвета статусов модуля; по умолчанию — общий перечень заявок. */
  statuses = DEFAULT_STATUS_DICT,
  /** Строки, раскрытые сразу на телефоне: за приложенными к ним файлами карточку и открывают. */
  defaultExpandedKeys,
}: {
  rows: HistoryRow[];
  labels: Record<string, string>;
  statuses?: HistoryStatusDict;
  defaultExpandedKeys?: string[];
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <MobileHistoryList
        rows={rows}
        labels={labels}
        statuses={statuses}
        defaultExpandedKeys={defaultExpandedKeys}
      />
    );
  }

  return (
    <ConfigProvider theme={historyTableTheme}>
      <Table
        className="history-table"
        size="small"
        showHeader={false}
        pagination={false}
        rowKey="key"
        columns={columnsWith(labels, statuses)}
        dataSource={rows}
      />
    </ConfigProvider>
  );
}
