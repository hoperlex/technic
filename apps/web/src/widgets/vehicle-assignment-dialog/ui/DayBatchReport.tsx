import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnType } from 'antd';
import {
  dayBatchOutcomeLabels,
  dayBatchRemainderMessage,
  type VehicleRequestDayBatchOutcome,
  type VehicleRequestDayBatchResultDto,
  type VehicleRequestDayBatchRowDto,
} from '@technic/contracts';
import { ViewModal } from '@shared/ui';
import { formatDateOnly } from '@shared/lib';

/**
 * Report of the "4-P for the whole period" batch (ADR 0207 decision 7): what the batch did for each
 * day of the term.
 *
 * A table, not a `Modal.confirm`: there can be fifty rows mixing three different news — route
 * created, waybill issued, day skipped with a reason. Fifty sentences in a confirmation body are
 * unreadable, and reading them is mandatory: the dispatcher finishes skipped days by hand, and
 * there is no other place that says which.
 *
 * Separate from both dialogs that call the batch: the report is the same for the take-into-work
 * checkbox and the days-table button. It shows **after** the action, when the first dialog is
 * already closed — not a second form step but a receipt.
 */

/**
 * Outcome colour. `planned` and `issued` are separate not for detail: the first spends a route row,
 * the second also a strict-reporting form number, and in the report those are different news.
 */
const outcomeColors: Record<VehicleRequestDayBatchOutcome, string> = {
  planned: 'blue',
  issued: 'green',
  skipped: 'gold',
  failed: 'red',
};

const columns: TableColumnType<VehicleRequestDayBatchRowDto>[] = [
  {
    key: 'date',
    title: 'День',
    width: 120,
    render: (_v, row) => formatDateOnly(row.date),
  },
  {
    key: 'outcome',
    title: 'Исход',
    width: 140,
    // Labels come from the contracts dictionary: outcomes are a closed list there, and a
    // portal-side translation would silently diverge the moment the server added another outcome.
    render: (_v, row) => (
      <Tag color={outcomeColors[row.outcome]} style={{ marginInlineEnd: 0 }}>
        {dayBatchOutcomeLabels[row.outcome]}
      </Tag>
    ),
  },
  {
    key: 'route',
    title: 'Рейс',
    width: 110,
    // For a skipped day this is the route that did not accept it: without the number, "no task rows
    // left in the route" does not say which route.
    render: (_v, row) => row.routeNumber ?? <Typography.Text type="secondary">—</Typography.Text>,
  },
  {
    key: 'waybill',
    title: 'Лист',
    width: 190,
    render: (_v, row) =>
      row.waybillNumber ?? <Typography.Text type="secondary">не выписан</Typography.Text>,
  },
  {
    key: 'reason',
    title: 'Причина',
    render: (_v, row) => (
      <Typography.Text type={row.outcome === 'failed' ? 'danger' : undefined}>
        {row.reason ?? ''}
      </Typography.Text>
    ),
  },
];

interface Props {
  /** The batch answer; `null` — nothing to show, the dialog is closed. */
  result: VehicleRequestDayBatchResultDto | null;
  onClose: () => void;
}

export function DayBatchReport({ result, onClose }: Props) {
  /*
   * Counts come from the answer, not recounted from rows: the server counts them in the same loop
   * that issues, while the portal would count shown rows. Once they diverge (a portion, an
   * interruption halfway), the header would lie exactly where it is read instead of the table.
   */
  const summary = result
    ? [
        { label: 'Выписано листов', value: result.issued, color: 'green' },
        { label: 'Заведено рейсов', value: result.planned, color: 'blue' },
        { label: 'Пропущено', value: result.skipped, color: 'gold' },
        { label: 'Ошибок', value: result.failed, color: 'red' },
      ]
    : [];

  return (
    <ViewModal
      title="Выписка 4-П на период: что получилось"
      open={!!result}
      onClose={onClose}
      width={860}
      // Content is rebuilt on every opening: a second batch is another report, and the table scroll
      // left from the first would show the wrong rows.
      destroyOnHidden
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Space size={[8, 8]} wrap>
          {summary.map((s) => (
            // Zero is shown like the others: "skipped 0" is an answer, while a missing tag reads as
            // "not counted".
            <Tag key={s.label} color={s.value > 0 ? s.color : undefined}>
              {s.label}: {s.value}
            </Tag>
          ))}
        </Space>

        {result && result.remaining > 0 ? (
          // The remainder of the term — in the same words the portal promised before the click (ADR
          // 0207 decision 11). Without this line "the batch ended" reads as "everything is done",
          // and a quarter-long order would silently stay half-planned.
          <Alert type="info" showIcon title={dayBatchRemainderMessage(result.remaining)} />
        ) : null}

        <Table
          rowKey="date"
          size="small"
          dataSource={result?.rows ?? []}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content', y: 420 }}
        />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Пропущенные дни остаются за диспетчером: их ставят по одному в таблице «Дни работ», где
          видно, чем занят рейс машины на эту дату. Повторное нажатие пачки доберёт остаток.
        </Typography.Text>
      </div>
    </ViewModal>
  );
}
