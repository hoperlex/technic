import { Collapse, Space, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { wasteTicketFieldLabels, type TicketAuditFieldRow } from '@technic/contracts';
import {
  correctedView,
  disputedView,
  resolvedDisputeView,
  unreadableView,
  type RatioView,
} from '../model/numbers';
import { Ratio } from './Ratio';

/**
 * Пять строк сводки — по числу полей бланка — таблицей на десктопе и карточками на телефоне
 * (§5.1 плана). Оба вида в одном файле намеренно: показатели у них одни и те же, и разъедься они
 * по двум местам, столбец, добавленный в таблицу, молча не доехал бы до телефона.
 */

/** Заголовки столбцов с определением показателя: число без определения читается как знание. */
function ColumnTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <Tooltip title={hint}>
      <span>{title}</span>
    </Tooltip>
  );
}

const COLUMN_HINTS = {
  corrected:
    'Человек изменил прочитанное моделью значение. Знаменатель — решённые наблюдения: исправленные и принятые как есть; спорные, предложения и ждущие решения в него не входят',
  resolvedDispute:
    'Поле было спорным и пустым, человек назвал значение. Это не исправление: портал не предложил значения, а честно попросил решить',
  unreadable:
    'Модель не вернула значение. Законная пустота (простой не несёт объёма) сюда не входит',
  disputed: 'Проходы каскада прочитали поле по-разному',
};

export function FieldTable({ rows }: { rows: TicketAuditFieldRow[] }) {
  const columns: TableColumnsType<TicketAuditFieldRow> = [
    {
      key: 'field',
      title: 'Поле',
      width: 130,
      render: (_v, row) => (
        <Typography.Text strong>{wasteTicketFieldLabels[row.field]}</Typography.Text>
      ),
    },
    {
      key: 'corrected',
      title: <ColumnTitle title="Исправлено" hint={COLUMN_HINTS.corrected} />,
      render: (_v, row) => <Ratio view={correctedView(row)} />,
    },
    {
      key: 'resolvedDispute',
      title: <ColumnTitle title="Решено человеком" hint={COLUMN_HINTS.resolvedDispute} />,
      render: (_v, row) => <Ratio view={resolvedDisputeView(row)} />,
    },
    {
      key: 'unreadable',
      title: <ColumnTitle title="Не прочитано" hint={COLUMN_HINTS.unreadable} />,
      render: (_v, row) => <Ratio view={unreadableView(row)} />,
    },
    {
      key: 'disputed',
      title: <ColumnTitle title="Спорных" hint={COLUMN_HINTS.disputed} />,
      render: (_v, row) => <Ratio view={disputedView(row)} />,
    },
  ];
  return (
    <Table<TicketAuditFieldRow>
      rowKey="field"
      size="small"
      columns={columns}
      dataSource={rows}
      // Строк ровно пять — по числу полей бланка: листать нечего, а пагинация внизу читалась бы
      // как обещание шестой страницы.
      pagination={false}
      // Узкое окно на десктопе уводит вправо хвост таблицы, и порядок столбцов — это порядок их
      // ухода: первым скрывается «Спорных», затем «Не прочитано», затем «Решено человеком».
      // Тот же порядок у раскрытия карточки на телефоне (§5.1 плана).
      scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * Узкий экран: таблица разворачивается карточками. В заголовке карточки — поле и доля исправлений
 * с числами, остальное уходит в раскрытие, и порядок там задан планом (§5.1): спорные, не
 * прочитано, решено человеком. Порядок и есть порядок скрытия столбцов — первым уходит то, чего у
 * двух полей из пяти вовсе нет.
 */
export function FieldCards({ rows }: { rows: TicketAuditFieldRow[] }) {
  return (
    <Collapse
      size="small"
      ghost
      items={rows.map((row) => ({
        key: row.field,
        label: (
          <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
            <Typography.Text strong>{wasteTicketFieldLabels[row.field]}</Typography.Text>
            <Ratio view={correctedView(row)} />
          </Space>
        ),
        children: (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            <CardLine title="Спорных" hint={COLUMN_HINTS.disputed} view={disputedView(row)} />
            <CardLine
              title="Не прочитано"
              hint={COLUMN_HINTS.unreadable}
              view={unreadableView(row)}
            />
            <CardLine
              title="Решено человеком"
              hint={COLUMN_HINTS.resolvedDispute}
              view={resolvedDisputeView(row)}
            />
          </Space>
        ),
      }))}
    />
  );
}

/** Строка раскрытия: подпись показателя слева, числа справа — как ячейка таблицы, только в столбик. */
function CardLine({ title, hint, view }: { title: string; hint: string; view: RatioView }) {
  return (
    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
      <ColumnTitle title={title} hint={hint} />
      <Ratio view={view} />
    </Space>
  );
}
