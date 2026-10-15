import {
  allowedVehicleRequestTypes,
  type canOrderVehicleRequestType,
  type VehicleRequestType,
  vehicleRequestTypeLabels,
} from '@technic/contracts';

/** The hint names what the dispatcher needs to plan: cargo for freight, work for on-site equipment. */
export const COMMENT_HINTS: Record<VehicleRequestType, { label: string; placeholder: string }> = {
  special_equipment: {
    label: 'Комментарий (планируемые задачи)',
    placeholder:
      'Например: разработка котлована под фундамент, погрузка грунта в самосвалы; заезд с ул. Ленина, работы с 08:00',
  },
  freight_transport: {
    label: 'Комментарий (опишите груз)',
    placeholder:
      'Например: плиты перекрытия ПК 60-15, 12 шт, 14 т; погрузка краном поставщика, на объекте нужен манипулятор',
  },
};

export function canOrderOptions(user: Parameters<typeof canOrderVehicleRequestType>[0]) {
  return allowedVehicleRequestTypes(user).map((value) => ({
    value,
    label: vehicleRequestTypeLabels[value],
  }));
}
