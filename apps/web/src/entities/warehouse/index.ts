/**
 * Склад поставщика: адрес, по которому с поставщиком работают (ADR 0051). Снаружи берут
 * `@entities/warehouse` — внутренние модули слайса не видны, и перестроить его можно, не трогая
 * потребителей.
 */
export { warehousesApi } from './api/warehousesApi';
export { warehouseKeys } from './api/keys';
export { warehouseOptionsQuery } from './api/queries';
