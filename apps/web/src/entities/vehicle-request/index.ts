/**
 * Заказ техники: заявка на технику или грузоперевозку, её назначение, срок работ, закрытие фактом
 * и ключи запросов раздела. Снаружи берут `@entities/vehicle-request` — внутренние модули слайса
 * не видны, и перестроить его можно, не трогая потребителей.
 *
 * Ключей отсюда раздаётся два корня, и это не оплошность: подсказка рейса (`routePrefillKeys`)
 * живёт под собственным корнем, потому что отвечает о рейсах дня, а не о заявке, — разбор в
 * `api/keys.ts`. Оба спрашивает один слайс, поэтому и вход у них один.
 */
export { vehicleRequestKeys, routePrefillKeys } from './api/keys';
export { vehicleRequestsApi } from './api/vehicleRequestsApi';
export type {
  AssignmentCommandResultDto,
  VehicleRequestCompletionResultDto,
  VehicleRequestPeriodResultDto,
} from './api/vehicleRequestsApi';
