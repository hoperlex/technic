/**
 * Кабинет водителя (ADR 0102, ADR 0103): задание и отчёт дня одного человека. Снаружи берут
 * `@entities/driver-cabinet` — внутренние модули слайса не видны.
 *
 * A slice of its own rather than a module of `pages/driver`: the cabinet's keys and handles are an
 * entity's (ADR 0228 rule 4), and the cache check reads the home root of a write from the slice
 * that declares the handle. While both lived in the page, `open` and `submit` had no home root at
 * all, and a submit that forgot its own report key would have passed unnoticed.
 */
export { driverCabinetApi } from './api/driverCabinetApi';
export { cabinetRead, driverCabinetKeys } from './api/keys';
