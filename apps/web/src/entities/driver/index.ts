/**
 * Водитель: человек, которого сажают за машину и на чьё имя выписывают путевой лист и бланк ЭСМ-2.
 * Снаружи берут `@entities/driver` — внутренние модули слайса не видны, и перестроить его можно,
 * не трогая потребителей.
 */
export { driversApi } from './api/driversApi';
export { driverKeys, licenseCategoryKeys } from './api/keys';
export { machinistOptionsQuery } from './api/queries';
