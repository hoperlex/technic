import { Button } from 'antd';
import { ViewModal } from '@shared/ui';
import { VehicleMaintenanceBlock } from './VehicleMaintenanceBlock';

/** Машина глазами модуля ТО: идентификатор и то, как её зовут в списке, из которого открыли. */
export interface MaintenanceVehicle {
  id: string;
  label: string;
}

/**
 * Сводка ТО отдельным окном (Р14в): тот же блок, что стоит в карточке машины, но открытый из
 * списка техники — из справочника и из гаража, одним и тем же ключом адреса (`?maintenance=<id>`).
 *
 * Второго компонента для этого не заводится намеренно. Механику вкладка «Показания» не видна
 * вовсе, и его окно — это ровно блок обслуживания без статистики вокруг; напиши для него свою
 * разметку — и «пробег с ТО» показывался бы в двух местах по двум описаниям.
 */
export function VehicleMaintenanceModal({
  vehicle,
  on,
  onClose,
}: {
  /** `null` — окно закрыто. */
  vehicle: MaintenanceVehicle | null;
  /** День среза, если список смотрят не за сегодня (Р16). */
  on?: string;
  onClose: () => void;
}) {
  if (!vehicle) return null;
  return (
    <ViewModal
      title={`Обслуживание — ${vehicle.label}`}
      open
      onClose={onClose}
      width={900}
      destroyOnHidden
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <VehicleMaintenanceBlock vehicleId={vehicle.id} vehicleLabel={vehicle.label} on={on} />
    </ViewModal>
  );
}
