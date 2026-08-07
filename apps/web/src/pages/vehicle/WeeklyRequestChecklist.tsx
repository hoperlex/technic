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
import type { WeeklyRequestHistoryEntryDto } from '../../api/resources';
import { EntityLink } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { vehicleRequestLink, waybillLink } from '../../utils/links';
import { formatDateTime } from '../../utils/format';
import { ItemWarnings } from './weeklyShared';

/**
 * Чек-лист готовности недели (§5 шаг 6) — экран, ради которого модуль и делается. Он отвечает не
 * «что согласовали», а «что из согласованного ещё не готово»: назначена ли машина, стоит ли виза
 * на порождённом заказе, выписан ли ЭСМ-2 за неделю, оформлен ли перегон.
 *
 * Арендная техника показывается нейтральным «ведёт арендодатель», а не красным «не выписано»
 * (Р19): портал на неё документов не выписывает вовсе, и неделя с арендой иначе выглядела бы
 * вечно незаконченной.
 */

type Can = (permission: Permission) => boolean;

/**
 * Клетка документа: состояние тегом и готовый текст из контрактов. Кнопка печати показывается
 * только при праве `waybills.read` (§5 шаг 6): штаб видит номер и состояние, но журнал бланков
 * ради одной кнопки ему не открывают. Печать живёт в самом журнале — туда ссылка и ведёт.
 */
function DocumentCell({ cell, can }: { cell: WeeklyDocumentCellDto; can: Can }) {
  const print = cell.state === 'issued' && cell.number ? waybillLink(can, cell.number) : null;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <Tag color={weeklyDocumentStateColors[cell.state]} style={{ marginInlineEnd: 0 }}>
        {cell.text}
      </Tag>
      {print && (
        <div>
          <EntityLink to={print} title="Открыть лист в журнале — оттуда его и печатают">
            <PrinterOutlined /> Печать
          </EntityLink>
        </div>
      )}
    </div>
  );
}

/** Машина строки: подпись сегодняшняя, расхождение со снимком — отдельной отметкой (Р14). */
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
  // Виза с порождённого заказа может слететь позже: содержательная правка лицом без права визы
  // её снимает (Р8). Без этой колонки «неделя согласована» читалось бы как «всё поедет».
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
    // Статуса порождённого заказа чек-лист не знает, а ссылка обязана вести туда, где заказ
    // показывают: пока неделю отрабатывают, он лежит в списке заявок. Право спрашивает общий
    // `vehicleRequestLink` — им же закрыт переход у ролей, которым список не положен.
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
      message={`Применено ${documents.applied}, пропущено ${documents.skipped}`}
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

/**
 * Строки применённой заявки со своими предупреждениями — тем же текстом, что видел составитель:
 * он объясняет, почему у аренды нет листов портала и откуда в сроке взялись дни до начала недели.
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
          <ItemWarnings warnings={item.warnings} />
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

/** Что событие истории означает человеку: переход статуса либо правка состава (Р17). */
function historyTitle(entry: WeeklyRequestHistoryEntryDto): string {
  if (entry.event === 'status') {
    const to = entry.toStatus ? weeklyRequestStatusLabels[entry.toStatus] : '—';
    const from = entry.fromStatus ? `${weeklyRequestStatusLabels[entry.fromStatus]} → ` : '';
    return `${from}${to}`;
  }
  return entry.event === 'items_changed' ? 'Состав изменён' : 'Строка снята';
}

/**
 * История заявки: и статусы, и правки состава. Своя, а не общая история заявок ТС: состав
 * меняется и без перехода — правкой черновика и уборкой строк при удалении заказа насовсем, — и
 * такое событие обязано объяснить пропавшую строку.
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
