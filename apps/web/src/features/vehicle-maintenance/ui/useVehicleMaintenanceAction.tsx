import { useState, type ReactNode } from 'react';
import { Button, Tooltip } from 'antd';
import { ToolOutlined } from '@ant-design/icons';
import type { ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../../auth/AuthContext';
import { useMaintenanceAddress } from '../model/maintenanceAddress';
import { VehicleMaintenanceModal, type MaintenanceVehicle } from './VehicleMaintenanceModal';

/**
 * Вход в сводку ТО из строки списка техники (Р14в, Р15).
 *
 * Хуком, а не компонентом, потому что вход у строки два: кнопка в колонке действий на десктопе и
 * пункт в шите действий на телефоне (ADR 0030). Оба открывают одно и то же окно, и держать его
 * состояние в двух местах значило бы получить два окна на одну машину.
 *
 * **Открытая машина названа в адресе** (`useMaintenanceAddress`), тем же ключом, что и в гараже.
 * Раньше она жила в `useState`, и окно из справочника нельзя было ни прислать ссылкой, ни закрыть
 * шагом назад, а перезагрузка теряла его совсем. Ключ вкладки справочников в адресе пока не живёт,
 * поэтому целиком — «раздел, вкладка и машина» — ссылка соберётся вместе с ним; «назад» и
 * переживший переход выбор работают уже сейчас.
 *
 * Право спрашивается здесь же: без `vehicleMaintenance.read` кнопки нет — иначе она вела бы в 403.
 * Само окно право проверяет ещё раз, и это не дублирование: блок открывают и не отсюда.
 */
export function useVehicleMaintenanceAction(on?: string): {
  /** Есть ли право вообще: списку это нужно, чтобы не заводить пустую колонку действий. */
  allowed: boolean;
  button: (vehicle: MaintenanceVehicle) => ReactNode;
  items: (vehicle: MaintenanceVehicle) => ActionSheetItem[];
  /** Окно сводки: рисуется один раз рядом со списком, а не в каждой строке. */
  modal: ReactNode;
} {
  const { can } = useAuth();
  const allowed = can('vehicleMaintenance.read');
  const address = useMaintenanceAddress(allowed);

  /**
   * В состоянии остаётся только подпись машины, по строке которой нажали, — открыто ли окно и про
   * кого оно, знает адрес. Присланная ссылка называет машину, строки которой на экране может не
   * быть вовсе: тогда имени у окна до ответа сводки нет, и это ровно то же поведение, что в гараже.
   */
  const [named, setNamed] = useState<MaintenanceVehicle | null>(null);
  const open = (vehicle: MaintenanceVehicle) => {
    setNamed(vehicle);
    address.open(vehicle.id);
  };
  const opened: MaintenanceVehicle | null = address.id
    ? { id: address.id, label: named?.id === address.id ? named.label : 'машина' }
    : null;

  return {
    allowed,
    button: (vehicle) =>
      allowed ? (
        <Tooltip title="Техобслуживание">
          <Button
            size="small"
            icon={<ToolOutlined />}
            aria-label={`Обслуживание — ${vehicle.label}`}
            onClick={() => open(vehicle)}
          />
        </Tooltip>
      ) : null,
    items: (vehicle) =>
      allowed ? [{ key: 'maintenance', label: 'Обслуживание', onClick: () => open(vehicle) }] : [],
    modal: <VehicleMaintenanceModal vehicle={opened} on={on} onClose={address.close} />,
  };
}
