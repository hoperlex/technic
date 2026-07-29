import type { ReactNode } from 'react';
import { Space, Table, type TableColumnsType, Tag, Typography } from 'antd';
import {
  type RequestHistoryEntryDto,
  type RequestHistoryKind,
  requestStatusColors,
  requestStatusLabels,
} from '@technic/contracts';
import { formatDateTime } from '../utils/format';

/**
 * История заявки списком с раскрытием, а не лентой (ADR 0012). Свёрнутая строка отвечает на
 * «что произошло»: слева баблы статусов со стрелкой (у событий без перехода — тег вида события),
 * дальше короткая суть и «когда · кто». Значения изменений, причина отмены и предъявленный факт
 * показываются подстроками при раскрытии — иначе карточка на десятке правок превращается
 * в простыню.
 *
 * Общая для обоих модулей заявок: события у них одной формы, различаются только подписи полей
 * и то, чем заявка закрывается (машины и талоны у вывоза мусора — ADR 0011, 0013).
 */

const HISTORY_TITLES: Record<RequestHistoryKind, string> = {
  created: 'Заявка создана',
  updated: 'Заявка отредактирована',
  status: 'Смена статуса',
  operator: 'Смена исполнителя',
  approved: 'Заявка завизирована',
  approvalRevoked: 'Виза снята',
  assigned: 'Назначена техника',
  completed: 'Предъявлен факт выполнения',
  deleted: 'Перемещена в архив',
  restored: 'Восстановлена из архива',
};

/** События без перехода статуса тоже начинаются с бабла — иначе первая колонка рвётся. */
const KIND_TAGS: Record<string, { label: string; color?: string }> = {
  updated: { label: 'Правка' },
  operator: { label: 'Исполнитель', color: 'geekblue' },
  // Виза (ADR 0025): тем же зелёным, что и в списке заявок, — событие и состояние читаются одинаково.
  approved: { label: 'Виза', color: 'green' },
  approvalRevoked: { label: 'Виза снята', color: 'orange' },
  // Назначение техники (ADR 0027) идёт вместе с переводом в работу — тем же цветом, что «В работе».
  assigned: { label: 'Техника', color: 'gold' },
  // Факт выполнения (ADR 0029) — вместе с закрытием, и цвет тот же, что у «Выполнена».
  completed: { label: 'Факт', color: 'green' },
  deleted: { label: 'Архив', color: 'red' },
  restored: { label: 'Из архива', color: 'green' },
};

const secondary = { fontSize: 12 } as const;

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

function StatusBubbles({ row }: { row: HistoryRow }) {
  const e = row.entry;
  if (!e) return <Tag style={tagStyle}>{row.tag ?? '—'}</Tag>;
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

/** Строка свёрнутая: чем событие было. Значения изменений и факт — уже в раскрытой части. */
function summaryOf(row: HistoryRow, labels: Record<string, string>): string {
  const e = row.entry;
  if (!e) return row.fact ?? '';
  // Комментарий к отмене — это её причина: без подписи он читается как обычная заметка.
  if (e.comment) return e.toStatus === 'cancelled' ? `Причина: ${e.comment}` : e.comment;
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

function HistoryDetails({ row, labels }: { row: HistoryRow; labels: Record<string, string> }) {
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
          {labels[c.field] ?? c.field}: {c.from === null ? c.to : `${c.from} → ${c.to}`}
        </Typography.Text>
      ))}
      {row.details}
    </div>
  );
}

// Ширины держат колонки в пределах окна: шире суммы столбцы вытолкнули бы таблицу
// в горизонтальную прокрутку, а история читается только сверху вниз.
function columnsWith(labels: Record<string, string>): TableColumnsType<HistoryRow> {
  return [
    {
      key: 'bubbles',
      width: 190,
      render: (_v, row) => <StatusBubbles row={row} />,
    },
    {
      key: 'summary',
      render: (_v, row) => (
        <Typography.Text ellipsis={{ tooltip: true }} style={{ maxWidth: 250 }}>
          {summaryOf(row, labels)}
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
}

export function RequestHistoryTable({
  rows,
  /** Подписи полей модуля: сервер шлёт технические ключи (`wasteRequestChangeLabels`). */
  labels,
  /** Строки, раскрытые сразу: за приложенными к ним файлами карточку и открывают. */
  defaultExpandedKeys,
}: {
  rows: HistoryRow[];
  labels: Record<string, string>;
  defaultExpandedKeys?: string[];
}) {
  return (
    <Table
      size="small"
      showHeader={false}
      pagination={false}
      rowKey="key"
      columns={columnsWith(labels)}
      dataSource={rows}
      expandable={{
        rowExpandable: hasDetails,
        expandRowByClick: true,
        expandedRowRender: (row) => <HistoryDetails row={row} labels={labels} />,
        defaultExpandedRowKeys: defaultExpandedKeys,
      }}
    />
  );
}
