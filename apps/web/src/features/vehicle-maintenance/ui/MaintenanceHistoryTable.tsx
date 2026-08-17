import { Button, Space, Table, Tooltip, Typography, type TableColumnsType } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { VehicleMaintenanceDto } from '@technic/contracts';
import { FilesCell } from '../../../components/FileLinks';
import { SHOWN_DATE, kmText } from '../model/maintenanceText';

/**
 * Журнал обслуживания машины (Р10, Р30): история хранится целиком, и показывается она тоже целиком.
 *
 * Порядок — серверный (свежие сверху), и сортировки у таблицы нет намеренно: записи упорядочены по
 * дате обслуживания, а при совпадении — по времени заведения, и переставить их местами на портале
 * значило бы получить второй ответ на вопрос «какая запись предыдущая» — тот самый, по которому
 * считается пробег с ТО.
 *
 * Страниц нет по той же причине, по какой их нет в ответе: записей ТО у машины десятки за всю
 * жизнь.
 */

export function MaintenanceHistoryTable({
  items,
  canWrite,
  onEdit,
  onRemove,
}: {
  items: VehicleMaintenanceDto[];
  canWrite: boolean;
  onEdit: (record: VehicleMaintenanceDto) => void;
  onRemove: (record: VehicleMaintenanceDto) => void;
}) {
  const columns: TableColumnsType<VehicleMaintenanceDto> = [
    {
      key: 'performedOn',
      title: 'Дата ТО',
      width: 120,
      render: (_v, r) => dayjs(r.performedOn).format(SHOWN_DATE),
    },
    {
      key: 'odometerKm',
      title: 'Пробег в акте',
      width: 140,
      align: 'right',
      // Прочерк — это «прибор не работал, якоря расчёта нет», а не ноль на счётчике (Р11а).
      render: (_v, r) =>
        r.odometerKm === null ? (
          <Tooltip title="В акте пробега нет: пробег с этого ТО известен только снизу">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ) : (
          kmText(r.odometerKm)
        ),
    },
    {
      key: 'documentNumber',
      title: 'Документ',
      width: 160,
      ellipsis: true,
      render: (_v, r) => r.documentNumber || '—',
    },
    {
      key: 'note',
      title: 'Примечание',
      ellipsis: true,
      render: (_v, r) => r.note || '—',
    },
    {
      key: 'files',
      title: 'Скан',
      width: 80,
      align: 'center',
      // Скрепка с числом, по нажатию — список со ссылками: акт подшивают, чтобы потом его
      // прочитать, и счётчик без ссылки заставлял бы открывать запись на правку ради просмотра.
      render: (_v, r) => <FilesCell files={r.files} />,
    },
    {
      key: 'author',
      title: 'Кто внёс',
      width: 190,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.createdByName}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(r.createdAt).format(`${SHOWN_DATE} HH:mm`)}
            {/* Правку показываем отдельной строкой: акт правят задним числом, и «кто внёс» с
                «кто правил» — разные ответы. */}
            {r.updatedByName ? ` · правил ${r.updatedByName}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            title: 'Действия',
            width: 100,
            render: (_v: unknown, r: VehicleMaintenanceDto) => (
              <Space>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  aria-label="Изменить запись ТО"
                  onClick={() => onEdit(r)}
                />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="Удалить запись ТО"
                  onClick={() => onRemove(r)}
                />
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Table<VehicleMaintenanceDto>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={items}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: 'Записей о ТО ещё нет' }}
    />
  );
}
