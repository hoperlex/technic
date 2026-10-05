import { Button, Space, Tag, Tooltip, type TableColumnsType } from 'antd';
import {
  DashboardOutlined,
  DeleteFilled,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  type VehicleDto,
  type VehicleOwnership,
  type VehicleStatus,
  rentalActivationBlockReason,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  vehicleStatusColors,
  vehicleStatusLabels,
  vehicleTitle,
} from '@technic/contracts';
import type { ReactNode } from 'react';
import { actionsColumn, badgeColumn, textColumn } from '@shared/ui';

/**
 * Fleet registry columns. Their shape is a rule rather than decoration: ownership hides fields
 * that cannot apply (rentals have no registration/model here; owned vehicles have no rates), and
 * an archived row replaces the complete action set.
 */

/** A missing rate is a dash, not zero: “not specified” must not read as “free”. */
const money = (v: number | null) =>
  v == null ? '—' : `${v.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽`;

/** Every action a registry row delegates to its composing features. */
export interface VehicleColumnsDeps {
  /** Selected ownership; empty means the mixed list needs an ownership column. */
  ownershipFilter: VehicleOwnership | undefined;
  showOwnColumns: boolean;
  showRentalColumns: boolean;
  canRestore: boolean;
  restore: (id: string) => void;
  purge: {
    allowed: boolean;
    pending: boolean;
    confirm: (id: string, label: string) => void;
  };
  maintenanceButton: (target: { id: string; label: string }) => ReactNode;
  onFuelNorms: (target: { id: string; label: string }) => void;
  onEdit: (vehicle: VehicleDto) => void;
  onDelete: (vehicle: VehicleDto) => void;
}

export function vehicleRegistryColumns({
  ownershipFilter,
  showOwnColumns,
  showRentalColumns,
  canRestore,
  restore,
  purge,
  maintenanceButton,
  onFuelNorms,
  onEdit,
  onDelete,
}: VehicleColumnsDeps): TableColumnsType<VehicleDto> {
  return [
    // Ownership is useful only in the mixed list; after filtering every row has the same value.
    ...(ownershipFilter
      ? []
      : [
          badgeColumn<VehicleDto>({
            key: 'ownership',
            title: 'Принадлежность',
            dataIndex: 'ownership',
            labels: vehicleOwnershipLabels,
            colors: vehicleOwnershipColors,
            width: 150,
          }),
        ]),
    {
      key: 'typeName',
      title: 'Тип',
      dataIndex: 'typeName',
      width: 180,
      ellipsis: true,
      sorter: true,
    },
    {
      key: 'categoryName',
      title: 'Категория',
      width: 200,
      ellipsis: true,
      sorter: true,
      render: (_v: unknown, r: VehicleDto) => r.categoryName ?? '—',
    },
    ...(showOwnColumns
      ? [
          textColumn<VehicleDto>({
            key: 'registrationNumber',
            title: 'Госномер',
            dataIndex: 'registrationNumber',
            searchable: false,
            width: 140,
            render: (_v, r) => r.registrationNumber ?? '—',
          }),
          {
            key: 'modelName',
            title: 'Марка/модель',
            width: 180,
            ellipsis: true,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => r.modelName ?? '—',
          },
        ]
      : []),
    ...(showRentalColumns
      ? [
          {
            key: 'lessorName',
            title: 'Арендодатель',
            width: 220,
            ellipsis: true,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => r.lessorName ?? '—',
          },
          {
            key: 'description',
            title: 'Описание',
            width: 180,
            ellipsis: true,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => r.description || '—',
          },
          {
            key: 'pricePerHour',
            title: '₽/час',
            width: 120,
            align: 'right' as const,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) => money(r.pricePerHour),
          },
          {
            key: 'pricePerShift',
            title: '₽/смена',
            width: 140,
            align: 'right' as const,
            sorter: true,
            render: (_v: unknown, r: VehicleDto) =>
              r.pricePerShift == null ? (
                '—'
              ) : (
                <Tooltip
                  title={r.shiftHours ? `Смена ${r.shiftHours} ч` : 'Длительность смены не задана'}
                >
                  {money(r.pricePerShift)}
                </Tooltip>
              ),
          },
        ]
      : []),
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 160,
      sorter: true,
      // State why an inactive lessor blocks activation; otherwise the disabled editor option looks
      // like a broken control.
      render: (v: VehicleStatus, r: VehicleDto) => {
        const reason = rentalActivationBlockReason(r);
        return (
          <Space size={4}>
            <Tag color={vehicleStatusColors[v]}>{vehicleStatusLabels[v]}</Tag>
            {reason ? (
              <Tooltip title={reason}>
                <ExclamationCircleOutlined style={{ color: '#faad14' }} />
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    // Live rows have four buttons and archived rows a tag plus two; the old default wrapped them.
    actionsColumn<VehicleDto>((r) =>
      r.deletedAt ? (
        <Space>
          <Tag>в архиве</Tag>
          {canRestore ? (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              title="Восстановить"
              onClick={() => restore(r.id)}
            />
          ) : null}
          {purge.allowed ? (
            <Button
              size="small"
              danger
              icon={<DeleteFilled />}
              title="Удалить окончательно"
              loading={purge.pending}
              onClick={() => purge.confirm(r.id, vehicleTitle(r))}
            />
          ) : null}
        </Space>
      ) : (
        <Space>
          {maintenanceButton({ id: r.id, label: vehicleTitle(r) })}
          <Button
            size="small"
            icon={<DashboardOutlined />}
            title="Нормы расхода топлива"
            onClick={() => onFuelNorms({ id: r.id, label: vehicleTitle(r) })}
          />
          <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(r)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(r)} />
        </Space>
      ),
    ),
  ];
}
