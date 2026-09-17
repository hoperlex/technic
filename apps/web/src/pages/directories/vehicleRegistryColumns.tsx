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
 * Колонки реестра техники.
 *
 * Отдельным модулем потому, что состав колонок здесь — не оформление, а правило: переключатель
 * принадлежности убирает неприменимые колонки (у аренды нет госномера и марки, у своей нет цен), а
 * архивная строка меняет весь набор действий. Рядом с формой карточки и мутациями вкладки это
 * правило терялось среди `Form.Item`.
 */

/** Деньги в таблице: прочерк вместо нуля — цена не задана, а не «бесплатно». */
const money = (v: number | null) =>
  v == null ? '—' : `${v.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽`;

/** Всё, чем строка таблицы отвечает наружу: вкладка держит и состояние, и сами действия. */
export interface VehicleColumnsDeps {
  /** Выбранная принадлежность; пусто — общий список, и тогда колонка принадлежности нужна. */
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
    // Колонку принадлежности показываем только в общем списке: в отфильтрованном она одинакова.
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
      // У предложения с неактивным арендодателем рядом со статусом висит причина, по которой его
      // нельзя включить, — иначе выключенный вариант в форме выглядел бы поломкой.
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
    // Ширина задана явно: в живой ветви теперь четыре кнопки, в архивной — тег и две, и
    // умолчание в 130 px рвало бы их на две строки.
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
