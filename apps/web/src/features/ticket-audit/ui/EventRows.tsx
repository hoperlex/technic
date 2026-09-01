import type { ReactNode } from 'react';
import { Collapse, Space, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { wasteTicketFieldLabels, type TicketAuditEventRow } from '@technic/contracts';
import { modelSnapshotView, versionsLabel } from '../model/cohorts';
import {
  ACTOR_LOST_NOTE,
  ACTOR_MACHINE_NOTE,
  NOT_APPLICABLE_NOTE,
  TICKET_AUDIT_EVENT_HINTS,
  TICKET_AUDIT_EVENT_LABELS,
  UNREADABLE_NOTE,
  eventActorView,
  eventMoment,
  eventValueLines,
  type EmptyValueView,
  type EventValueLine,
} from '../model/eventRows';
import { ModelCell } from './ModelCell';
import { TicketScanButton } from './TicketScan';

/**
 * Строки ленты — таблицей на десктопе и карточками на телефоне (§5.3 плана). Оба вида в одном
 * файле по той же причине, что у полей сводки и когорт: показывают они одно и то же, и разъедься
 * они по двум местам, столбец, добавленный в таблицу, молча не доехал бы до телефона.
 *
 * Порядок строк задаёт сервер (время события по убыванию) и клиент его не трогает: лента — журнал,
 * а не таблица показателей, и всякая своя сортировка означала бы «что-то произошло не тогда».
 */

/** Ширины столбцов. Числом в одном месте: таблица шире окна, и порядок ухода вправо — решение. */
const WIDTHS = {
  moment: 96,
  request: 84,
  field: 84,
  event: 156,
  values: 300,
  model: 168,
  scan: 132,
};

export function EventTable({ rows }: { rows: readonly TicketAuditEventRow[] }) {
  const columns: TableColumnsType<TicketAuditEventRow> = [
    {
      key: 'moment',
      title: 'Когда',
      width: WIDTHS.moment,
      render: (_v, row) => <MomentCell at={row.at} />,
    },
    {
      key: 'request',
      title: 'Заявка',
      width: WIDTHS.request,
      render: (_v, row) => <RequestCell num={row.requestNum} />,
    },
    {
      key: 'field',
      title: 'Поле',
      width: WIDTHS.field,
      render: (_v, row) => (
        <Typography.Text strong>{wasteTicketFieldLabels[row.field]}</Typography.Text>
      ),
    },
    {
      key: 'event',
      title: 'Событие',
      width: WIDTHS.event,
      render: (_v, row) => (
        <Space orientation="vertical" size={0}>
          <EventLabel row={row} />
          <ActorLine row={row} />
        </Space>
      ),
    },
    {
      key: 'values',
      title: 'Значения',
      width: WIDTHS.values,
      render: (_v, row) => <ValueLines row={row} />,
    },
    {
      key: 'model',
      title: 'Модель',
      width: WIDTHS.model,
      render: (_v, row) => (
        <Space orientation="vertical" size={0}>
          <ModelCell view={modelSnapshotView(row.model)} />
          <Typography.Text type="secondary">{versionsLabel(row)}</Typography.Text>
        </Space>
      ),
    },
    {
      key: 'scan',
      title: 'Скан',
      width: WIDTHS.scan,
      render: (_v, row) => <TicketScanButton fileId={row.fileId} pageNo={row.pageNo} />,
    },
  ];

  return (
    <Table<TicketAuditEventRow>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={rows}
      // Постраничность своя, общая с карточками телефона: у таблицы и списка карточек она обязана
      // быть одной, иначе «страница 3» на двух видах означала бы разные события.
      pagination={false}
      // Узкое окно уводит вправо хвост таблицы, и порядок столбцов — это порядок их ухода: когда,
      // что и с какими значениями остаётся видно дольше всего, конфигурация уезжает первой.
      scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * Узкий экран: то же карточками. В заголовке — время, поле, событие и обе строки значений; в
 * раскрытии — модель, версии, автор, заявка и кнопка скана (§5.3). Значения стоят в заголовке
 * намеренно: за ними ленту и читают, а раскрывать каждую карточку ради «было/стало» — это лента,
 * которую нельзя пролистать глазами.
 */
export function EventCards({ rows }: { rows: readonly TicketAuditEventRow[] }) {
  return (
    <Collapse
      size="small"
      ghost
      items={rows.map((row) => ({
        key: row.id,
        label: (
          <Space orientation="vertical" size={2} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <MomentCell at={row.at} inline />
              <Typography.Text strong>{wasteTicketFieldLabels[row.field]}</Typography.Text>
              <EventLabel row={row} />
            </Space>
            <ValueLines row={row} />
          </Space>
        ),
        children: (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            <CardLine title="Модель">
              <ModelCell view={modelSnapshotView(row.model)} />
            </CardLine>
            <CardLine title="Промпт/подг.">
              <Typography.Text>{versionsLabel(row)}</Typography.Text>
            </CardLine>
            <CardLine title="Автор">
              <ActorLine row={row} />
            </CardLine>
            <CardLine title="Заявка">
              <RequestCell num={row.requestNum} />
            </CardLine>
            <CardLine title="Скан">
              <TicketScanButton fileId={row.fileId} pageNo={row.pageNo} />
            </CardLine>
          </Space>
        ),
      }))}
    />
  );
}

/** Строка раскрытия: подпись слева, значение справа — как ячейка таблицы, поставленная в столбик. */
function CardLine({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
      <Typography.Text type="secondary">{title}</Typography.Text>
      {children}
    </Space>
  );
}

/**
 * Момент события: день и время. День печатается с годом — период бывает и через Новый год, а
 * «26.08» без года в ленте, открытой по чужой ссылке, читается как «на днях».
 */
function MomentCell({ at, inline = false }: { at: string; inline?: boolean }) {
  const moment = eventMoment(at);
  if (inline)
    return (
      <Typography.Text type="secondary">
        {moment.day} {moment.time}
      </Typography.Text>
    );
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text>{moment.day}</Typography.Text>
      <Typography.Text type="secondary">{moment.time}</Typography.Text>
    </Space>
  );
}

/** Имя события с его определением: «правка» и «арбитраж» — слова из разных процессов. */
function EventLabel({ row }: { row: TicketAuditEventRow }) {
  return (
    <Tooltip title={TICKET_AUDIT_EVENT_HINTS[row.event]}>
      <Typography.Text>{TICKET_AUDIT_EVENT_LABELS[row.event]}</Typography.Text>
    </Tooltip>
  );
}

/**
 * Кто совершил событие. Машина, человек и «учётки больше нет» названы врозь: сведи мы их к
 * прочерку, машинное чтение читалось бы как потерянный след человека.
 */
function ActorLine({ row }: { row: TicketAuditEventRow }) {
  const view = eventActorView(row);
  if (view.kind === 'named') return <Typography.Text type="secondary">{view.name}</Typography.Text>;
  return (
    <Tooltip title={view.kind === 'machine' ? ACTOR_MACHINE_NOTE : ACTOR_LOST_NOTE}>
      <Typography.Text type="secondary">
        {view.kind === 'machine' ? 'машина' : 'учётка удалена'}
      </Typography.Text>
    </Tooltip>
  );
}

/**
 * Заявка, в которой лежал талон. Её может уже не быть: ссылка обнуляется при откате заявки, а
 * событие остаётся — качество модели свойство прочитанного листа, а не живой записи.
 */
function RequestCell({ num }: { num: string | null }) {
  if (num === null)
    return (
      <Tooltip title="Заявки больше нет: её ссылка обнуляется при удалении, а событие переживает и заявку, и талон">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  return <Typography.Text>М-{num}</Typography.Text>;
}

/**
 * Значения события — ДВУМЯ СТРОКАМИ, а не одной со стрелкой (§5.3).
 *
 * Значение поля бывает адресом в сто знаков, и «было → стало» одной строкой обрезается ровно там,
 * где начинается разница. Столбиком каждое переносится целиком: подпись держит свою ширину,
 * значение занимает остаток и переносится по словам, а длинное слово ломается — иначе оно
 * растянуло бы столбец и уехало за край окна.
 */
function ValueLines({ row }: { row: TicketAuditEventRow }) {
  return (
    <Space orientation="vertical" size={0} style={{ width: '100%' }}>
      {eventValueLines(row).map((line) => (
        <ValueLine key={line.label} line={line} />
      ))}
    </Space>
  );
}

function ValueLine({ line }: { line: EventValueLine }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' }}>
      <Typography.Text type="secondary" style={{ flex: '0 0 auto' }}>
        {line.label}
      </Typography.Text>
      {line.value === null ? (
        <EmptyValue view={line.empty} />
      ) : (
        <Typography.Text style={{ wordBreak: 'break-word', whiteSpace: 'normal' }}>
          {line.value}
        </Typography.Text>
      )}
    </div>
  );
}

/**
 * Что стоит вместо пустого значения.
 *
 * «Не прочитано» печатается обычным текстом, а не прочерком: это исход чтения, такой же ответ
 * модели, как цифра, и по нему считается доля непрочитанного. «Графы нет» и прочерк — приглушённо:
 * там нечего разбирать. Одинаковый прочерк на все три случая прятал бы самую частую жалобу на
 * модель за той же чёрточкой, что и бумагу, на которой графы не было.
 */
function EmptyValue({ view }: { view: EmptyValueView }) {
  if (view.kind === 'unreadable')
    return (
      <Tooltip title={UNREADABLE_NOTE}>
        <Typography.Text>не прочитано</Typography.Text>
      </Tooltip>
    );
  if (view.kind === 'not-applicable')
    return (
      <Tooltip title={NOT_APPLICABLE_NOTE}>
        <Typography.Text type="secondary">графы нет</Typography.Text>
      </Tooltip>
    );
  return (
    <Tooltip title={view.hint}>
      <Typography.Text type="secondary">—</Typography.Text>
    </Tooltip>
  );
}
