import { Alert, Table, Tag, Typography, type TableColumnType } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import {
  type Permission,
  type WeeklyDocumentCellDto,
  type WeeklyDocumentRowDto,
  weeklyDocumentStateColors,
  type WeeklyRequestDocumentsDto,
  type WeeklyRequestItemDto,
  weeklyItemResultColors,
  weeklyItemResultLabels,
  weeklyRequestStatusLabels,
} from '@technic/contracts';
import { WeeklyItemWarnings, type WeeklyRequestHistoryEntryDto } from '@entities/weekly-request';
import { EntityLink } from '@shared/ui';
import { formatDateOnly, formatDateTime, useIsMobile } from '@shared/lib';
import { waybillLink } from '@entities/waybill';
import { vehicleRequestLink } from '@entities/vehicle-request';

/**
 * Week readiness checklist (section 5 step 6), the screen the module exists for. It answers not
 * "what was approved" but "what of the approved is not ready yet": is a vehicle assigned, is the
 * generated order approved, is the week's ESM-2 issued, is the relocation arranged.
 *
 * Rented equipment shows a neutral "the lessor keeps it" rather than a red "not issued" (R19): the
 * portal issues no documents for it at all, and a week with rentals would otherwise look forever
 * unfinished.
 */

type Can = (permission: Permission) => boolean;

/**
 * Document cell: state as a tag and ready text from contracts. The print link is shown only with
 * waybills.read (section 5 step 6): the site office sees number and state, but the form journal is
 * not opened to it for one button. Printing lives in the journal itself, which is where the link
 * leads.
 *
 * A link per number, not to the first one (ADR 0142): a week where a month ends has two ESM-2
 * waybills, and one "Print" button would send the person to print half the week's paper.
 */
function DocumentCell({ cell, can }: { cell: WeeklyDocumentCellDto; can: Can }) {
  const prints =
    cell.state === 'issued'
      ? cell.numbers.flatMap((number) => {
          const link = waybillLink(can, number);
          return link ? [{ number, link }] : [];
        })
      : [];
  return (
    <div style={{ lineHeight: 1.35 }}>
      <Tag color={weeklyDocumentStateColors[cell.state]} style={{ marginInlineEnd: 0 }}>
        {cell.text}
      </Tag>
      {prints.map(({ number, link }) => (
        <div key={number}>
          <EntityLink to={link} title="Открыть лист в журнале — оттуда его и печатают">
            <PrinterOutlined /> Печать{prints.length > 1 ? ` № ${number}` : ''}
          </EntityLink>
        </div>
      ))}
    </div>
  );
}

/** The row's vehicle: today's label, with divergence from the snapshot as a separate mark (R14). */
function VehicleCell({ row }: { row: WeeklyDocumentRowDto }) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{row.vehicleLabel ?? 'не назначена'}</div>
      {row.vehicleChanged && (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          машина изменилась после согласования
        </Typography.Text>
      )}
    </div>
  );
}

function ApprovalCell({ row }: { row: WeeklyDocumentRowDto }) {
  if (row.kind === 'leave' || row.result === 'skipped') {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  // Approval of the generated order may drop later: a material edit by someone without the approval
  // right removes it (R8). Without this column "week approved" would read as "everything goes".
  return row.approved ? (
    <Tag color="green" style={{ marginInlineEnd: 0 }}>
      есть
    </Tag>
  ) : (
    <Tag color="orange" style={{ marginInlineEnd: 0 }}>
      ждёт заново
    </Tag>
  );
}

function RowTitle({ row }: { row: WeeklyDocumentRowDto }) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{row.title}</div>
      <Tag color={weeklyItemResultColors[row.result]} style={{ marginInlineEnd: 0 }}>
        {weeklyItemResultLabels[row.result]}
      </Tag>
      {!!row.skipReason && (
        <div>
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {row.skipReason}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}

export function WeeklyRequestChecklist({
  documents,
  can,
}: {
  documents: WeeklyRequestDocumentsDto | undefined;
  can: Can;
}) {
  const isMobile = useIsMobile();
  if (!documents) return null;
  const rows = documents.rows;

  const orderLink = (row: WeeklyDocumentRowDto) =>
    // The checklist does not know the generated order's status, while the link must lead where the
    // order is shown: while the week is worked it is in the request list. The right is asked by the
    // shared vehicleRequestLink, which also closes the link for roles not entitled to the list.
    row.requestId ? vehicleRequestLink(can, { id: row.requestId, status: 'confirmed' }) : null;

  const columns: TableColumnType<WeeklyDocumentRowDto>[] = [
    { key: 'title', title: 'Строка', width: 260, render: (_v, r) => <RowTitle row={r} /> },
    {
      key: 'order',
      title: 'Заказ',
      width: 120,
      render: (_v, r) =>
        r.displayNumber ? (
          <EntityLink to={orderLink(r)} title="Открыть заказ">
            {r.displayNumber}
          </EntityLink>
        ) : (
          '—'
        ),
    },
    { key: 'vehicle', title: 'Машина', width: 200, render: (_v, r) => <VehicleCell row={r} /> },
    {
      key: 'approved',
      title: 'Виза заказа',
      width: 120,
      render: (_v, r) => <ApprovalCell row={r} />,
    },
    {
      key: 'esm2',
      title: 'ЭСМ-2 за неделю',
      width: 200,
      render: (_v, r) => <DocumentCell cell={r.esm2} can={can} />,
    },
    {
      key: 'relocation',
      title: 'Перегон',
      width: 200,
      render: (_v, r) => <DocumentCell cell={r.relocation} can={can} />,
    },
    {
      key: 'reversal',
      title: 'Обратный ход',
      width: 260,
      render: (_v, r) => <ReversalCell row={r} />,
    },
  ];

  const summary = (
    <Alert
      type={documents.skipped > 0 ? 'warning' : 'success'}
      showIcon
      title={`Применено ${documents.applied}, пропущено ${documents.skipped}`}
      description={
        documents.skipped > 0
          ? 'Пропущенные строки объяснены причиной: это то, что площадка просила и не получила.'
          : undefined
      }
    />
  );

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {summary}
        <div className="list-cards">
          {rows.map((row) => (
            <div key={row.itemId} className="list-card">
              <div className="list-card__head">
                <Typography.Text strong>{row.title}</Typography.Text>
                <Tag color={weeklyItemResultColors[row.result]} style={{ marginInlineEnd: 0 }}>
                  {weeklyItemResultLabels[row.result]}
                </Tag>
              </div>
              <div className="list-card__primary">
                <EntityLink to={orderLink(row)} title="Открыть заказ">
                  {row.displayNumber ?? '—'}
                </EntityLink>
              </div>
              <div className="list-card__line">
                <VehicleCell row={row} />
              </div>
              <div className="list-card__line">
                Виза заказа: <ApprovalCell row={row} />
              </div>
              <div className="list-card__line">
                ЭСМ-2: <DocumentCell cell={row.esm2} can={can} />
              </div>
              <div className="list-card__line">
                Перегон: <DocumentCell cell={row.relocation} can={can} />
              </div>
              <div className="list-card__line">
                Обратный ход: <ReversalCell row={row} />
              </div>
              {!!row.skipReason && (
                <div className="list-card__line">
                  <Typography.Text type="danger">{row.skipReason}</Typography.Text>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {summary}
      <Table<WeeklyDocumentRowDto>
        rowKey="itemId"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
    </div>
  );
}

/**
 * How this row can be reversed and what blocks it (ADR 0218 decision 4).
 *
 * The server uses the same predicate as the annulment command. A checklist row has neither the
 * order's status and effective end nor its pending departure or later weekly decisions. The
 * portal therefore only displays the answer: a second version of the rule would silently drift
 * and promise a reversal that the command refuses.
 */
function ReversalCell({ row }: { row: WeeklyDocumentRowDto }) {
  const reversal = row.reversal;
  if (!reversal) return <Typography.Text type="secondary">—</Typography.Text>;
  if (reversal.state === 'reverted') {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {reversal.reason || 'Разворачивать нечего'}
      </Typography.Text>
    );
  }
  if (reversal.state === 'blocked') {
    return (
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        {reversal.reason}
      </Typography.Text>
    );
  }
  const text =
    reversal.reverse === 'shorten_to' && reversal.shortenTo
      ? `Срок вернётся к ${formatDateOnly(reversal.shortenTo)}`
      : reversal.reverse === 'cancel'
        ? 'Заказ будет отменён'
        : 'Решение об отъезде перестанет действовать';
  return <Tag color="green">{text}</Tag>;
}

/**
 * Rows of the applied request with their warnings, the same text the author saw: it explains why
 * rentals have no portal waybills and where days before the week start came from in the term.
 */
export function WeeklyRequestAgreed({ items }: { items: WeeklyRequestItemDto[] }) {
  return (
    <>
      {items.map((item) => (
        <div key={item.id} style={{ marginBottom: 6, lineHeight: 1.4 }}>
          <Typography.Text>
            {item.sourceDisplayNumber ?? item.vehicleTypeName ?? '—'} ·{' '}
            {item.currentVehicleLabel ?? 'машина не назначена'}
          </Typography.Text>
          <WeeklyItemWarnings warnings={item.warnings} />
          {!!item.skipReason && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {item.skipReason}
            </Typography.Text>
          )}
        </div>
      ))}
    </>
  );
}

/** What a history event means to a person: a status transition or a composition edit (R17). */
function historyTitle(entry: WeeklyRequestHistoryEntryDto): string {
  if (entry.event === 'status') {
    const to = entry.toStatus ? weeklyRequestStatusLabels[entry.toStatus] : '—';
    const from = entry.fromStatus ? `${weeklyRequestStatusLabels[entry.fromStatus]} → ` : '';
    return `${from}${to}`;
  }
  return entry.event === 'items_changed' ? 'Состав изменён' : 'Строка снята';
}

/**
 * Request history: statuses and composition edits. Its own rather than the shared vehicle-request
 * history: the composition changes without transitions too (draft edits, rows removed when an
 * order is deleted for good), and such an event must explain the vanished row.
 */
export function WeeklyRequestHistory({
  entries,
}: {
  entries: WeeklyRequestHistoryEntryDto[] | undefined;
}) {
  if (!entries || entries.length === 0) {
    return <Typography.Text type="secondary">Событий пока нет.</Typography.Text>;
  }
  return (
    <div className="history-list">
      {entries.map((entry) => (
        <div key={entry.id} className="history-item">
          <div className="history-item__head">
            <Typography.Text strong>{historyTitle(entry)}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDateTime(entry.changedAt)}
            </Typography.Text>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {entry.changedByName}
          </Typography.Text>
          {!!entry.comment && <div>{entry.comment}</div>}
        </div>
      ))}
    </div>
  );
}
