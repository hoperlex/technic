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
import { formatDateTime, useIsMobile } from '@shared/lib';
import { waybillLink } from '@entities/waybill';
import { vehicleRequestLink } from '@entities/vehicle-request';

/**
 * Readiness answers what remains after approval: assignment, order approval, ESM-2 and relocation.
 * Rental paperwork is neutral because the lessor owns it; marking it missing would make every
 * rental week appear permanently incomplete.
 */

type Can = (permission: Permission) => boolean;

/**
 * Link every printable sheet for readers with waybill access. A month boundary may split one week
 * into two ESM-2 sheets, so linking only the first would hide half the required paperwork.
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

/** Show today's vehicle label and mark divergence from the approved snapshot separately. */
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
  // A later material edit may revoke approval on the generated order; week approval alone does
  // not guarantee that the vehicle will be dispatched.
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
    // The checklist has no generated-order status, so use the common permission-aware list link.
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

/** Preserve the warnings the author saw, including rental ownership and pre-week date context. */
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

/** Translate either a status transition or a composition edit into a history label. */
function historyTitle(entry: WeeklyRequestHistoryEntryDto): string {
  if (entry.event === 'status') {
    const to = entry.toStatus ? weeklyRequestStatusLabels[entry.toStatus] : '—';
    const from = entry.fromStatus ? `${weeklyRequestStatusLabels[entry.fromStatus]} → ` : '';
    return `${from}${to}`;
  }
  return entry.event === 'items_changed' ? 'Состав изменён' : 'Строка снята';
}

/** Composition edits have their own history because rows may change without a status transition. */
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
