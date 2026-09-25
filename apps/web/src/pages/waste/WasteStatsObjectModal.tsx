import { Modal, Table, Typography, type TableColumnsType } from 'antd';
import type { WasteStatsPositionDto, WasteStatsRowDto } from '@technic/contracts';
import { monthLabel } from '@shared/lib';
import { figureColumns, figureSummaryCells } from './wasteStatsColumns';

/**
 * A site's month broken down by waste type (plan `docs/waste-stats-tab-plan.md`, §6.3; columns of
 * ADR 0209).
 *
 * THE WINDOW HAS NO REQUEST OF ITS OWN (R11): the positions came with the table row. So the window
 * adds up to the row by construction, not by the coincidence of two queries made seconds apart —
 * and whoever opened the site to see what its figures are made of does not have to trust two
 * answers at once.
 *
 * A plain antd table, not `DataTable`: there are only a few waste types and no pages are needed.
 * The columns and the "Итого" cells are the tab's own (`wasteStatsColumns.tsx`), so a figure reads
 * the same in the row and in the window.
 */
export function WasteStatsObjectModal({
  row,
  month,
  onClose,
}: {
  row: WasteStatsRowDto;
  month: string;
  onClose: () => void;
}) {
  const columns: TableColumnsType<WasteStatsPositionDto> = [
    { key: 'label', title: 'Вид отходов', dataIndex: 'label' },
    ...figureColumns<WasteStatsPositionDto>(),
  ];

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={1000}
      title={
        <div style={{ lineHeight: 1.35 }}>
          <div>{row.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal' }}>
            {row.code} · {monthLabel(month)}
          </Typography.Text>
        </div>
      }
    >
      <Table<WasteStatsPositionDto>
        rowKey="key"
        size="small"
        columns={columns}
        dataSource={row.positions}
        pagination={false}
        /*
         * The summary row prints the site row itself, not a sum of the positions on screen: both
         * were counted by the server from one set of requests, and the portal adds nothing up.
         */
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>Итого</Typography.Text>
              </Table.Summary.Cell>
              {figureSummaryCells(row, 1)}
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    </Modal>
  );
}
