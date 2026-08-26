import type { ReactNode } from 'react';
import { Collapse, Space, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { wasteTicketFieldLabels, type TicketAuditAccuracyField } from '@technic/contracts';
import {
  ACCURACY_ARBITRATION_NOTE,
  ACCURACY_DENOMINATOR_NOTE,
  ACCURACY_MATCHED_NOTE,
} from '../model/accuracy';
import { accuracyFieldView } from '../model/numbers';
import { Ratio } from './Ratio';

/**
 * Три строки точности — по числу полей, которые сверяет слепая перепроверка, — таблицей на
 * десктопе и карточками на телефоне (§5.5 плана). Оба вида в одном файле по той же причине, что у
 * когорт и полей сводки: показатели у них общие, и разъедься они по двум местам, столбец,
 * добавленный в таблицу, молча не доехал бы до телефона.
 *
 * Полей три, а не пять: вслепую перепроверяются номер, дата и объём. Вид работ и адрес в выборку не
 * входят вовсе, и строк с прочерками здесь нет — «поля нет в таблице» честнее, чем «поле есть, но
 * ни одного числа по нему».
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
  right: `Верных чтений: совпадения плюс расхождения, где арбитр признал правой машину. ${ACCURACY_DENOMINATOR_NOTE}`,
  matched: ACCURACY_MATCHED_NOTE,
  diverged: `Два чтения разошлись. Само по себе расхождение не значит, что ошиблась машина: пока его не разобрал арбитр, неизвестно, кто был прав, и бывает, что оба ошиблись. ${ACCURACY_ARBITRATION_NOTE}`,
};

export function AccuracyTable({ rows }: { rows: TicketAuditAccuracyField[] }) {
  const columns: TableColumnsType<TicketAuditAccuracyField> = [
    {
      key: 'field',
      title: 'Поле',
      width: 130,
      render: (_v, row) => (
        <Typography.Text strong>{wasteTicketFieldLabels[row.field]}</Typography.Text>
      ),
    },
    {
      key: 'right',
      title: <ColumnTitle title="Верно" hint={COLUMN_HINTS.right} />,
      // Процент печатается от тридцати разобранных полей и ни одним меньше: на трёх десятках
      // проверок доля скачет на десятки процентов от одного расхождения. Решает это `Ratio`
      // общими правилами чисел — своего порога у экрана нет и быть не должно.
      render: (_v, row) => <Ratio view={accuracyFieldView(row)} />,
    },
    {
      key: 'matched',
      title: <ColumnTitle title="Совпало" hint={COLUMN_HINTS.matched} />,
      align: 'right',
      render: (_v, row) => <Typography.Text>{row.matched}</Typography.Text>,
    },
    {
      key: 'diverged',
      title: <ColumnTitle title="Расхождений" hint={COLUMN_HINTS.diverged} />,
      align: 'right',
      render: (_v, row) => <DivergedCell row={row} />,
    },
  ];
  return (
    <Table<TicketAuditAccuracyField>
      rowKey="field"
      size="small"
      columns={columns}
      dataSource={rows}
      // Строк ровно три: листать нечего, а пагинация внизу читалась бы как обещание четвёртого поля.
      pagination={false}
      scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * Расхождения с числом неразобранных рядом. Неразобранное расхождение не стоит ни в числителе, ни
 * в знаменателе точности — по нему никто не назвал верного значения, — и не сказать о нём значило
 * бы предложить читать «2 расхождения» как «2 ошибки машины».
 */
function DivergedCell({ row }: { row: TicketAuditAccuracyField }) {
  const awaiting = row.diverged - row.arbitrated;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <Typography.Text>{row.diverged}</Typography.Text>
      {awaiting > 0 ? (
        <Tooltip title="Расхождения, которых арбитр ещё не разбирал: в точность они не идут ни верными, ни неверными">
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
            ждут {awaiting}
          </Typography.Text>
        </Tooltip>
      ) : null}
    </span>
  );
}

/**
 * Узкий экран: та же таблица карточками. В заголовке — поле и «верно / n», в раскрытии совпадения,
 * расхождения и исходы (§5.5). Исходы здесь построчные, в отличие от общего блока под таблицей:
 * на телефоне общий блок уезжает под сгиб, а вопрос «кто был прав по объёму» задают, глядя именно
 * на строку объёма.
 */
export function AccuracyCards({ rows }: { rows: TicketAuditAccuracyField[] }) {
  return (
    <Collapse
      size="small"
      ghost
      items={rows.map((row) => ({
        key: row.field,
        label: (
          <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }} wrap>
            <Typography.Text strong>{wasteTicketFieldLabels[row.field]}</Typography.Text>
            <Ratio view={accuracyFieldView(row)} />
          </Space>
        ),
        children: (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <CardLine title="Совпало" hint={COLUMN_HINTS.matched}>
              <Typography.Text>{row.matched}</Typography.Text>
            </CardLine>
            <CardLine title="Расхождений" hint={COLUMN_HINTS.diverged}>
              <DivergedCell row={row} />
            </CardLine>
            <CardLine
              title="права машина"
              hint="Арбитр назвал значение, совпавшее с машинным чтением"
            >
              <Typography.Text>{row.machineRight}</Typography.Text>
            </CardLine>
            <CardLine
              title="прав проверяющий"
              hint="Арбитр назвал значение, совпавшее с чтением проверяющего"
            >
              <Typography.Text>{row.checkerRight}</Typography.Text>
            </CardLine>
            <CardLine
              title="ошиблись оба"
              hint="Арбитр назвал значение, которого не предлагал ни один из двоих. Исход, которого не бывает, если считать спор выбором из двух"
            >
              <Typography.Text>{row.bothWrong}</Typography.Text>
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
