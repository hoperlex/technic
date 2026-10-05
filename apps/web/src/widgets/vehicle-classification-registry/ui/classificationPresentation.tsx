import { Button, Space, Switch, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { EditOutlined, SettingOutlined } from '@ant-design/icons';
import {
  isOdometerMaintenance,
  type VehicleClassificationDto,
  type VehicleTypeDto,
} from '@technic/contracts';
import { actionsColumn, textColumn, type CardConfig } from '@shared/ui';

interface PresentationOptions {
  typeById: Map<string, VehicleTypeDto>;
  togglePending: boolean;
  onToggle: (row: VehicleClassificationDto, next: boolean) => void;
  onEdit: (type: VehicleTypeDto) => void;
  onOpenCard: (type: VehicleTypeDto) => void;
}

export function classificationColumns({
  typeById,
  togglePending,
  onToggle,
  onEdit,
  onOpenCard,
}: PresentationOptions): TableColumnType<VehicleClassificationDto>[] {
  return [
    textColumn<VehicleClassificationDto>({
      key: 'kindName',
      title: 'Вид',
      dataIndex: 'kindName',
      searchable: false,
      width: 200,
    }),
    {
      key: 'label',
      title: 'Тип/категория',
      dataIndex: 'label',
      sorter: true,
      ellipsis: true,
      render: (value: string, row) => (
        <Space size={6}>
          <span>{value}</span>
          {row.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        </Space>
      ),
    },
    {
      key: 'specCount',
      title: 'ТТХ',
      dataIndex: 'specCount',
      width: 90,
      sorter: false,
      render: (value: number) => (value > 0 ? <Tag color="blue">{value}</Tag> : <Tag>0</Tag>),
    },
    {
      key: 'isLinear',
      title: 'Линейная',
      width: 160,
      sorter: false,
      render: (_value, row) => {
        const type = typeById.get(row.vehicleTypeId);
        return (
          <Space orientation="vertical" size={2}>
            {type?.isLinear ? <Tag color="blue">по дням</Tag> : <span>—</span>}
            {type && type.frozenRequests > 0 ? (
              <Tooltip title="Эти заявки застало переключение признака: до закрытия они идут прежним режимом">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {type.frozenRequests} на прежнем режиме
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      key: 'maintenanceBasis',
      title: 'ТО',
      width: 120,
      sorter: false,
      render: (_value, row) =>
        isOdometerMaintenance(typeById.get(row.vehicleTypeId)?.maintenanceBasis ?? 'none') ? (
          <Tag color="blue">по пробегу</Tag>
        ) : (
          <Tooltip title="У этого типа ТО не ведётся: срок обслуживания портал не считает и не подсвечивает">
            <span>—</span>
          </Tooltip>
        ),
    },
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      sorter: true,
      render: (value: boolean, row) => {
        // A category cannot become available while its owning type is inactive.
        const blocked = !!row.vehicleCategoryId && !row.typeIsActive;
        const control = (
          <Switch
            size="small"
            checked={value}
            disabled={blocked}
            loading={togglePending}
            onChange={(next) => onToggle(row, next)}
          />
        );
        return blocked ? (
          <Tooltip title={`Тип «${row.typeName}» неактивен — активируйте сначала его`}>
            {control}
          </Tooltip>
        ) : (
          control
        );
      },
    },
    actionsColumn<VehicleClassificationDto>((row) => {
      const type = typeById.get(row.vehicleTypeId);
      return (
        <Space size={4}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            title="ТТХ и категории типа"
            disabled={!type}
            onClick={() => type && onOpenCard(type)}
          />
          <Button
            size="small"
            icon={<EditOutlined />}
            title={`Редактировать тип «${row.typeName}»`}
            disabled={!type}
            onClick={() => type && onEdit(type)}
          />
        </Space>
      );
    }),
  ];
}

export function classificationCard({
  typeById,
  onToggle,
  onEdit,
  onOpenCard,
}: PresentationOptions): CardConfig<VehicleClassificationDto> {
  return {
    title: (row) => row.label,
    badge: (row) => (
      <Tag color={row.isActive ? 'green' : 'default'}>{row.isActive ? 'Да' : 'Нет'}</Tag>
    ),
    primary: (row) => (
      <Space size={6} wrap>
        <span>{row.kindName}</span>
        {row.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        {typeById.get(row.vehicleTypeId)?.isLinear ? <Tag color="blue">линейная</Tag> : null}
        {isOdometerMaintenance(typeById.get(row.vehicleTypeId)?.maintenanceBasis ?? 'none') ? (
          <Tag color="blue">ТО по пробегу</Tag>
        ) : null}
      </Space>
    ),
    lines: [
      (row) => (row.specCount > 0 ? `ТТХ: ${row.specCount}` : 'ТТХ не заведены'),
      (row) => {
        const frozen = typeById.get(row.vehicleTypeId)?.frozenRequests ?? 0;
        return frozen > 0 ? `${frozen} на прежнем режиме` : '';
      },
    ],
    onOpen: (row) => {
      const type = typeById.get(row.vehicleTypeId);
      if (type) onOpenCard(type);
    },
    actions: (row) => {
      const type = typeById.get(row.vehicleTypeId);
      return [
        {
          key: 'card',
          label: 'ТТХ и категории типа',
          disabled: !type,
          onClick: () => type && onOpenCard(type),
        },
        {
          key: 'edit',
          label: `Редактировать тип «${row.typeName}»`,
          disabled: !type,
          onClick: () => type && onEdit(type),
        },
        {
          key: 'toggle',
          label: row.isActive ? 'Деактивировать' : 'Активировать',
          danger: row.isActive,
          disabled: !!row.vehicleCategoryId && !row.typeIsActive,
          onClick: () => onToggle(row, !row.isActive),
        },
      ];
    },
  };
}
