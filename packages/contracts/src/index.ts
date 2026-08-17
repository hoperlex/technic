export * from './enums';
export * from './permissions';
export * from './permission-catalog';
export * from './grant-scope';
export * from './common';
export * from './links';
export * from './address';
export * from './time';
export * from './person-name';
export * from './email';
export * from './snils';
export * from './persons';
export * from './password';
export * from './registration-request';
export * from './auth';
export * from './users';
export * from './objects';
export * from './departments';
export * from './counterparties';
export * from './role-addons';
export * from './grants';
/*
 * Пока идёт переход надстроек в назначаемые полномочия (ADR 0106, шаги 1a–1e), предикат сквозной
 * области живёт в двух файлах: старый спрашивает надстройки учётки (`role-addons.ts`), новый — коды
 * её наборов (`grants.ts`). Одноимённые, они делают `export *` неоднозначным (TS2308), поэтому
 * источник назван явно — и с шага 1c назван **новый**.
 *
 * Это и есть «читателей переключили»: `lib/access.ts` спрашивает предикат по имени, и вместе с этой
 * строкой там сменился аргумент — `p.grantCodes` вместо `p.addons`. Одного изменения строки мало и
 * сделать его молча нельзя: типы подмены не заметят (`RoleAddon[]` присваивается в
 * `readonly string[]`), поэтому каждое место вызова пересмотрено глазами. На шаге 1e строка уходит
 * целиком вслед за `role-addons.ts`, и предикат остаётся один.
 */
export { hasModuleWideScope } from './grants';
export * from './warehouses';
export * from './warranty';
export * from './office-equipment';
export * from './office-equipment-history';
export * from './service-requests';
export * from './container-types';
export * from './vehicle-kinds';
export * from './vehicle-types';
export * from './vehicle-specs';
export * from './vehicle-categories';
export * from './vehicle-classifications';
export * from './vehicles';
export * from './directory-transfer';
export * from './files';
export * from './mailings';
export * from './mail-accounts';
export * from './module-mail';
export * from './request-history';
export * from './waste-tariffs';
export * from './waste-requests';
export * from './vehicle-routes';
export * from './cost-target';
export * from './vehicle-request-trips';
export * from './route-points';
export * from './waybill-task-rows';
export * from './vehicle-request-shifts';
export * from './vehicle-request-days';
export * from './vehicle-requests';
export * from './vehicle-request-feed';
export * from './weekly-vehicle-requests';
export * from './waybills';
export * from './garage';
export * from './driver-cabinet';
export * from './vehicle-readings';
export * from './vehicle-maintenance';
export * from './releases';
export * from './audit';
