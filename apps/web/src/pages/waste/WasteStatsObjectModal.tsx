import { Modal, Table, Typography, type TableColumnsType } from 'antd';
import type { WasteStatsPositionDto, WasteStatsRowDto } from '@technic/contracts';
import { monthLabel } from '@shared/lib';
import { formatMoney } from '../../utils/format';
import { confirmedNotes, costNotes, volumeNotes, volumeText } from './wasteStatsNumbers';

/**
 * Детализация площадки за месяц — по видам отходов (план `docs/waste-stats-tab-plan.md`, §6.3).
 *
 * СВОЕГО ЗАПРОСА У ОКНА НЕТ (Р11): позиции приехали вместе со строкой таблицы. Поэтому сумма окна
 * равна строке по построению, а не по совпадению двух выборок, сделанных в разные секунды, — и
 * человеку, который открыл площадку, чтобы понять, из чего сложились её 412 м³, не приходится
 * доверять двум ответам сразу.
 *
 * Таблица здесь обычная `antd`, а не `DataTable`: страниц не нужно (видов отходов единицы), а
 * нужна сводная строка внизу — то единственное, чего у списочной таблицы портала нет.
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
  /** Подписи-доли второй строкой в ячейке: сама величина крупно, из чего она состоит — мельче. */
  const cell = (value: string, notes: string[]) => (
    <div style={{ lineHeight: 1.35 }}>
      <div>{value}</div>
      {notes.map((note) => (
        <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>
          {note}
        </Typography.Text>
      ))}
    </div>
  );

  const columns: TableColumnsType<WasteStatsPositionDto> = [
    { key: 'label', title: 'Вид отходов', dataIndex: 'label' },
    {
      key: 'volume',
      title: 'Объём',
      align: 'right',
      width: 170,
      render: (_v, r) => cell(volumeText(r.volumeM3), volumeNotes(r)),
    },
    {
      key: 'cost',
      title: 'Стоимость',
      align: 'right',
      width: 190,
      render: (_v, r) => cell(formatMoney(r.totalCost), costNotes(r)),
    },
    {
      key: 'confirmed',
      title: 'Подтверждено талонами',
      align: 'right',
      width: 190,
      render: (_v, r) => cell(volumeText(r.confirmedVolumeM3), confirmedNotes(r)),
    },
    {
      key: 'confirmedCost',
      title: 'Стоимость подтверждённого',
      align: 'right',
      width: 190,
      /*
       * Прочерк, а не ноль: талоны предъявили кубы, а цены закрытия у них нет — умножать не на что
       * (Р5). Ноль в этой клетке означал бы бесплатный вывоз.
       */
      render: (_v, r) => (r.confirmedCost == null ? '—' : formatMoney(r.confirmedCost)),
    },
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
         * Сводная строка складывает ровно то, что на экране, — и совпадает со строкой площадки в
         * таблице, потому что обе величины посчитаны сервером из одного набора заявок.
         */
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>Итого</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong>{volumeText(row.volumeM3)}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                <Typography.Text strong>{formatMoney(row.totalCost)}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">
                <Typography.Text strong>{volumeText(row.confirmedVolumeM3)}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                <Typography.Text strong>
                  {row.confirmedCost == null ? '—' : formatMoney(row.confirmedCost)}
                </Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    </Modal>
  );
}
