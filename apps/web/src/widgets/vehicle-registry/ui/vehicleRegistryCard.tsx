import { Tag } from 'antd';
import {
  assignmentRateLabel,
  rentalActivationBlockReason,
  type VehicleDto,
  vehicleClassificationLabel,
  vehicleLabel,
  vehicleStatusColors,
  vehicleStatusLabels,
  vehicleTitle,
} from '@technic/contracts';
import type { ActionSheetItem, CardConfig } from '@shared/ui';
import type { VehicleRegistryActions } from '../model/types';

interface ExtraActions {
  maintenanceItems: (target: { id: string; label: string }) => ActionSheetItem[];
  openFuelNorms: (target: { id: string | null; label?: string }) => void;
}

/** Build a phone card that preserves desktop identity and lifecycle actions (ADR 0042). */
export function vehicleRegistryCard(
  actions: VehicleRegistryActions,
  extra: ExtraActions,
): CardConfig<VehicleDto> {
  return {
    // Owned vehicles are recognized by registration; rental offers by their short description.
    title: (record) => vehicleLabel(record),
    badge: (record) => (
      <Tag color={vehicleStatusColors[record.status]}>{vehicleStatusLabels[record.status]}</Tag>
    ),
    primary: (record) =>
      vehicleClassificationLabel({
        typeName: record.typeName,
        categoryName: record.categoryName,
      }),
    lines: [
      (record) => (record.ownership === 'own' ? record.modelName : record.lessorName),
      (record) => assignmentRateLabel(record) || null,
      // Touch has no reliable tooltip, so a blocked rental offer states its reason as a line.
      (record) => rentalActivationBlockReason(record),
      (record) => (record.deletedAt ? 'В архиве' : null),
    ],
    onOpen: (record) => (record.deletedAt ? undefined : actions.edit(record)),
    actions: (record) =>
      record.deletedAt
        ? [
            ...(actions.canRestore
              ? [
                  {
                    key: 'restore',
                    label: 'Восстановить',
                    onClick: () => actions.restore(record.id),
                  },
                ]
              : []),
            ...(actions.purge.allowed
              ? [
                  {
                    key: 'purge',
                    label: 'Удалить окончательно',
                    danger: true,
                    onClick: () => actions.purge.confirm(record.id, vehicleTitle(record)),
                  },
                ]
              : []),
          ]
        : [
            ...extra.maintenanceItems({ id: record.id, label: vehicleTitle(record) }),
            {
              key: 'fuel-norms',
              label: 'Нормы расхода',
              onClick: () => extra.openFuelNorms({ id: record.id, label: vehicleTitle(record) }),
            },
            { key: 'edit', label: 'Редактировать', onClick: () => actions.edit(record) },
            {
              key: 'delete',
              label: 'В архив',
              danger: true,
              onClick: () => actions.remove(record),
            },
          ],
  };
}
