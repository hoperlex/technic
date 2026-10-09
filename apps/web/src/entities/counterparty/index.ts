/**
 * Контрагент: организация, с которой портал работает в любой из её ролей — заказчик и подрядчик
 * работ, оператор вывоза, арендодатель, поставщик, сервисная компания (ADR 0010, 0038). Снаружи
 * берут `@entities/counterparty` — внутренние модули слайса не видны, и перестроить его можно, не
 * трогая потребителей.
 */
export { counterpartiesApi } from './api/counterpartiesApi';
export { counterpartyKeys } from './api/keys';
export {
  counterpartyActiveVehicleLessorsQuery,
  counterpartyOperatorGridQuery,
  counterpartyOptionsQuery,
  counterpartyActiveOptionsQuery,
  counterpartyActiveOperatorOptionsQuery,
  counterpartySupplierOptionsQuery,
  counterpartyVehicleLessorOptionsQuery,
  serviceCompanyOptionsQuery,
  mechLessorOptionsQuery,
} from './api/queries';
export { counterpartyTypeOptions } from './model/options';
export { counterpartyErrorMessage } from './model/errorMessage';
export { operatorOptionsForObject } from './model/operatorOptions';
