/**
 * Подбор заказчика «Объект/отдел» (план `docs/department-requests-plan.md`, §9 п. 1).
 *
 * Сценарий, а не сущность, и потому слой `features`: поле складывает две оси области и два
 * справочника — объекты и отделы, — а слайсу `entities` соседи по слою не видны. Спрашивают его
 * два модуля, заказ ТС и оргтехника, и вторая копия разошлась бы с первой на первой же правке
 * правил состава.
 *
 * Ключ заказчика (`CostTargetKey`) собирается и разбирается только контрактами
 * (`@technic/contracts`): своей реализации формата в портале нет.
 */
export { RequestCustomerSelect } from './ui/RequestCustomerSelect';
export type { RequestCustomerSelectProps } from './ui/RequestCustomerSelect';
export {
  useRequestCustomerOptions,
  DEPARTMENTS_GROUP_LABEL,
  OBJECTS_GROUP_LABEL,
  SITE_GROUP_LABEL,
} from './model/useRequestCustomerOptions';
export type {
  RequestCustomerGroup,
  RequestCustomerInput,
  RequestCustomerOption,
  RequestCustomerOptions,
  RequestCustomerPair,
  RequestCustomerSaved,
  RequestCustomerSite,
} from './model/useRequestCustomerOptions';
/** Фильтр списка тем же подбором (Р9): пара параметров одним полем и один вид на два экрана. */
export { useRequestCustomerFilter } from './model/useRequestCustomerFilter';
export type {
  RequestCustomerFilter,
  RequestCustomerFilterInput,
} from './model/useRequestCustomerFilter';
/** Поле заказчика оргтехники (Р11, Р11а, Р11б, Р12) — со своей осью и своей площадкой. */
export { ServiceRequestCustomerField } from './ui/ServiceRequestCustomerField';
export type { ServiceRequestCustomerFieldProps } from './ui/ServiceRequestCustomerField';
export { useServiceRequestCustomer } from './model/useServiceRequestCustomer';
export type {
  ServiceRequestCustomer,
  ServiceRequestCustomerEquipment,
  ServiceRequestCustomerInput,
  ServiceRequestCustomerSnapshot,
} from './model/useServiceRequestCustomer';
