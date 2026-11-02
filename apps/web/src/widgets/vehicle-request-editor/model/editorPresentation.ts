import {
  allowedVehicleRequestTypes,
  type canOrderVehicleRequestType,
  type VehicleRequestType,
  vehicleRequestTypeLabels,
} from '@technic/contracts';

/**
 * The hint names what the dispatcher needs to plan: work for on-site equipment, handling conditions
 * for freight — its cargo has a required field of its own on each trip (ADR 0239), and asking for it
 * here too would split one answer between two places.
 */
export const COMMENT_HINTS: Record<VehicleRequestType, { label: string; placeholder: string }> = {
  special_equipment: {
    label: 'Комментарий (планируемые задачи)',
    placeholder:
      'Например: разработка котлована под фундамент, погрузка грунта в самосвалы; заезд с ул. Ленина, работы с 08:00',
  },
  freight_transport: {
    label: 'Комментарий',
    placeholder:
      'Например: погрузка краном поставщика, на объекте нужен манипулятор; заезд с ул. Ленина',
  },
};

export function canOrderOptions(user: Parameters<typeof canOrderVehicleRequestType>[0]) {
  return allowedVehicleRequestTypes(user).map((value) => ({
    value,
    label: vehicleRequestTypeLabels[value],
  }));
}
