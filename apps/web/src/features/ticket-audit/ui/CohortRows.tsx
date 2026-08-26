import type { ReactNode } from 'react';
import { Collapse, Space, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { TicketAuditCohortRow } from '@technic/contracts';
import { cohortKey, escalationModelView, primaryModelView, versionsLabel } from '../model/cohorts';
import { cohortCorrectedView, cohortUnreadableView } from '../model/numbers';
import { ModelCell } from './ModelCell';
import { Ratio } from './Ratio';

/**
 * Строки когорт — таблицей на десктопе и карточками на телефоне (§5.2 плана). Оба вида в одном
 * файле по той же причине, что у полей сводки: показатели у них общие, и разъедься они по двум
 * местам, столбец, добавленный в таблицу, молча не доехал бы до телефона.
 */

/** Заголовок столбца с определением показателя: число без определения читается как знание. */
function ColumnTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <Tooltip title={hint}>
      <span>{title}</span>
    </Tooltip>
  );
}

const COLUMN_HINTS = {
  primary:
    'Модель первого прохода — снимком из наблюдения, а не ссылкой на попытку: попытки убираются по сроку, и когорта годичной давности обязана читаться после уборки',
  escalation:
    'Модель второй ступени. Прочерк — эскалации в этой когорте не было: разбор кончился на первом проходе',
  versions:
    'Версии промпта и подготовки изображения: пара, а не два числа врозь — меняются они вместе, и когорту задаёт именно пара',
  runs: 'Машинных разборов: группа по пять полей за раз. По ним считается «сколько раз читали», а наблюдений в пять раз больше',
  corrected:
    'Человек изменил прочитанное моделью значение. Знаменатель — решённые наблюдения: исправленные и принятые как есть; спорные, предложения и ждущие решения в него не входят',
  unreadable:
    'Модель не вернула значение. Законная пустота (простой не несёт объёма) сюда не входит',
};

export function CohortTable({ rows }: { rows: TicketAuditCohortRow[] }) {
  const columns: TableColumnsType<TicketAuditCohortRow> = [
    {
      key: 'primary',
      title: <ColumnTitle title="Основная" hint={COLUMN_HINTS.primary} />,
      render: (_v, row) => <ModelCell view={primaryModelView(row)} />,
    },
    {
      key: 'escalation',
      title: <ColumnTitle title="Эскалация" hint={COLUMN_HINTS.escalation} />,
      render: (_v, row) => <ModelCell view={escalationModelView(row)} />,
    },
    {
      key: 'versions',
      title: <ColumnTitle title="Промпт/подг." hint={COLUMN_HINTS.versions} />,
      render: (_v, row) => <Typography.Text type="secondary">{versionsLabel(row)}</Typography.Text>,
    },
    {
      key: 'runs',
      title: <ColumnTitle title="Разборов" hint={COLUMN_HINTS.runs} />,
      align: 'right',
      render: (_v, row) => <Typography.Text>{row.runs}</Typography.Text>,
    },
    {
      key: 'corrected',
      title: <ColumnTitle title="Исправлено" hint={COLUMN_HINTS.corrected} />,
      render: (_v, row) => <Ratio view={cohortCorrectedView(row)} />,
    },
    {
      key: 'unreadable',
      title: <ColumnTitle title="Не прочитано" hint={COLUMN_HINTS.unreadable} />,
      render: (_v, row) => <Ratio view={cohortUnreadableView(row)} />,
    },
  ];
  return (
    <Table<TicketAuditCohortRow>
      rowKey={cohortKey}
      size="small"
      columns={columns}
      dataSource={rows}
      // Конфигураций за месяц единицы: листать нечего, а пагинация внизу читалась бы как обещание
      // второй страницы когорт, которой нет.
      pagination={false}
      // Узкое окно уводит вправо хвост таблицы, и порядок столбцов — это порядок их ухода:
      // конфигурация (кто читал) остаётся видна дольше всего, доли уезжают первыми.
      scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * Узкий экран: та же таблица карточками. В заголовке — конфигурация и доля исправлений, в
 * раскрытии — разборы, наблюдения и «не прочитано» (§5.2). Версии тоже в раскрытии: на телефоне
 * столбца для них нет, а без них две когорты одной модели с разными промптами выглядели бы
 * одинаковыми строками с разными числами.
 */
export function CohortCards({ rows }: { rows: TicketAuditCohortRow[] }) {
  return (
    <Collapse
      size="small"
      ghost
      items={rows.map((row) => ({
        key: cohortKey(row),
        label: (
          <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }} wrap>
            <ModelCell view={primaryModelView(row)} />
            <Ratio view={cohortCorrectedView(row)} />
          </Space>
        ),
        children: (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <CardLine title="Эскалация" hint={COLUMN_HINTS.escalation}>
              <ModelCell view={escalationModelView(row)} />
            </CardLine>
            <CardLine title="Промпт/подг." hint={COLUMN_HINTS.versions}>
              <Typography.Text>{versionsLabel(row)}</Typography.Text>
            </CardLine>
            <CardLine title="Разборов" hint={COLUMN_HINTS.runs}>
              <Typography.Text>{row.runs}</Typography.Text>
            </CardLine>
            <CardLine
              title="Наблюдений"
              hint="Разборов × пять полей бланка: знаменатель доли непрочитанного"
            >
              <Typography.Text>{row.observations}</Typography.Text>
            </CardLine>
            <CardLine title="Не прочитано" hint={COLUMN_HINTS.unreadable}>
              <Ratio view={cohortUnreadableView(row)} />
            </CardLine>
          </Space>
        ),
      }))}
    />
  );
}

/** Строка раскрытия: подпись показателя слева, значение справа — как ячейка таблицы, в столбик. */
function CardLine({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
      <ColumnTitle title={title} hint={hint} />
      {children}
    </Space>
  );
}
