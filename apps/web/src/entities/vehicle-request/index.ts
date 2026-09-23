/**
 * Заказ техники: заявка на технику или грузоперевозку, её назначение, срок работ, закрытие фактом
 * и ключи запросов истории назначения. Снаружи берут `@entities/vehicle-request` — внутренние
 * модули слайса не видны, и перестроить его можно, не трогая потребителей.
 *
 * `waybillKeys` раздаётся отсюда, хотя журнал путевых листов — чужой домен и ручки его уже уехали
 * в `@entities/waybill`: почему ключ остался здесь и чем обошёлся бы его переезд поодиночке,
 * сказано над ним самим в `api/keys.ts`. Снять этот экспорт раньше его потребителей — погасить
 * журнал разом.
 */
export { vehicleRequestKeys, waybillKeys } from './api/keys';
export { vehicleRequestsApi } from './api/vehicleRequestsApi';
export type {
  AssignmentCommandResultDto,
  VehicleRequestCompletionResultDto,
  VehicleRequestPeriodResultDto,
} from './api/vehicleRequestsApi';
