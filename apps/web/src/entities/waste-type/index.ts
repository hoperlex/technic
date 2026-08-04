/**
 * Тип мусора — что вывозят с площадки. Собственной вкладки у справочника нет: тип заводится вместе
 * с первой ценой и правится строкой прайса (ADR 0017). Снаружи берут `@entities/waste-type`.
 */
export { wasteTypesApi } from './api/wasteTypesApi';
export { wasteTypeKeys } from './api/keys';
export { wasteTypeOptionsQuery } from './api/queries';
