/**
 * Отдел: офисное подразделение, от имени которого заказывают технику (ADR 0040). Снаружи берут
 * `@entities/department` — внутренние модули слайса не видны, и перестроить его можно, не трогая
 * потребителей.
 */
export { departmentsApi } from './api/departmentsApi';
export { departmentKeys } from './api/keys';
export { departmentOptionsQuery, departmentPlatformQuery } from './api/queries';
