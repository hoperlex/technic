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
  type RequestHistoryKind,
  requestStatusColors,
  requestStatusLabels,
} from '@technic/contracts';
import { useIsMobile } from '@shared/lib';
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

const HISTORY_TITLES: Record<RequestHistoryKind, string> = {
  created: 'Заявка создана',
  updated: 'Заявка отредактирована',
  status: 'Смена статуса',
  operator: 'Смена исполнителя',
  approved: 'Заявка завизирована',
  approvalRevoked: 'Виза снята',
  assigned: 'Назначена техника',
  completed: 'Предъявлен факт выполнения',
  // Досрочное завершение (ADR 0044): сокращение срока — согласуемое изменение, поэтому запрос,
  // решение и отзыв читаются в истории как разные события, а не как одна «правка срока».
  earlyEndRequested: 'Запрошено досрочное завершение',
  earlyEndApproved: 'Досрочное завершение согласовано',
  earlyEndRejected: 'Досрочное завершение отклонено',
  earlyEndCancelled: 'Запрос на досрочное завершение снят',
  // Недельная заявка (ADR 0085): срок продлил пакет, завизированный руководителем строительства.
  // Читается отдельно от правки — правил не тот, кто ведёт заказ, и номер пакета здесь главное.
  weeklyExtended: 'Срок продлён недельной заявкой',
  // Подтверждение смен: подпись объекта под днём работы и её снятие. Заполнение часов события
  // не пишет — в истории читаются решения, а не черновики.
  shiftApproved: 'Смена согласована',
  shiftApprovalRevoked: 'Согласование смены снято',
  // Заявка на обслуживание оргтехники (ADR 0085): стороны три, и каждое решение читается своим
  // событием. «Смета предъявлена» и «смета согласована» — не одна правка: между ними стоит
  // решение о деньгах, и по истории должно быть видно, какую именно ревизию утвердили.
  serviceAssigned: 'Назначен сервис',
  serviceReassigned: 'Сервис заменён',
  serviceDeclined: 'Сервис отказался от заявки',
  estimateSubmitted: 'Смета предъявлена',
  estimateApproved: 'Смета согласована',
  estimateRejected: 'Смета отклонена',
  estimateReopened: 'Смета переоткрыта',
  accepted: 'Работы приняты',
  returnedToWork: 'Возвращена на доработку',
  documentAttached: 'Подшит документ',
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
  // Досрочное завершение (ADR 0044): ожидание визы — оранжевым, как «Ждёт визы» у самой заявки,
  // состоявшееся сокращение — зелёным, отказ и снятие — красным и серым.
  earlyEndRequested: { label: 'Досрочно', color: 'orange' },
  earlyEndApproved: { label: 'Досрочно', color: 'green' },
  earlyEndRejected: { label: 'Досрочно', color: 'red' },
  earlyEndCancelled: { label: 'Досрочно' },
  // Цвет тот же, что у назначения: это состоявшееся решение по заказу, а не ожидание.
  weeklyExtended: { label: 'Неделя', color: 'blue' },
  // Смены: принятый день — зелёным, как факт выполнения; снятая подпись — оранжевым, как снятая
  // виза заявки: работа не отменена, её приняли обратно на разбор.
  shiftApproved: { label: 'Смена', color: 'green' },
  shiftApprovalRevoked: { label: 'Смена', color: 'orange' },
  deleted: { label: 'Архив', color: 'red' },
  restored: { label: 'Из архива', color: 'green' },
};

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
function columnsWith(labels: Record<string, string>): TableColumnsType<HistoryRow> {
  return [
    {
      key: 'bubbles',
      width: 190,
      render: (_v, row) => <StatusBubbles row={row} />,
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
  defaultExpandedKeys,
}: {
  rows: HistoryRow[];
  labels: Record<string, string>;
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
              <StatusBubbles row={row} />
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
  /** Строки, раскрытые сразу на телефоне: за приложенными к ним файлами карточку и открывают. */
  defaultExpandedKeys,
}: {
  rows: HistoryRow[];
  labels: Record<string, string>;
  defaultExpandedKeys?: string[];
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <MobileHistoryList rows={rows} labels={labels} defaultExpandedKeys={defaultExpandedKeys} />
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
        columns={columnsWith(labels)}
        dataSource={rows}
      />
    </ConfigProvider>
  );
}
