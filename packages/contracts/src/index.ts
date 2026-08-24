export * from './enums';
export * from './permissions';
export * from './permission-catalog';
export * from './grant-scope';
export * from './common';
export * from './links';
/* Разделы портала (`portal-sections.ts`) — рядом с адресами по той же причине: их спрашивают меню,
 * маршруты и стартовая страница, и ответ обязан быть один. */
export * from './portal-sections';
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
export * from './role-migration';
export * from './warehouses';
export * from './warranty';
export * from './office-equipment';
export * from './office-equipment-models';
export * from './office-equipment-consumables';
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
/* Талоны вывоза (`waste-tickets.ts`) — сразу за заявкой, потому что вне её не существуют: ручки
 * вложены в заявку, а талон без неё это файл без смысла (ADR 0114). Отдельным файлом, а не частью
 * `waste-requests.ts`, ровно по обратной причине — заявку читают все роли модуля, а талоны только
 * право разбора, и смешанные в одном файле, эти два круга читателей однажды смешались бы и в
 * коде. */
export * from './waste-ticket-number';
export * from './waste-tickets';
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
/* Периоды назначения (`assignment-periods.ts`) — после заявки и путевого листа, потому что читаются
 * они вместе: история назначения объясняет, чей состав напечатан в каком бланке. Двери появляются на
 * этапе 3 плана `docs/assignment-periods-plan.md`; словарь и тела выписаны раньше — у фичи пять
 * дверей с общим рукопожатием, и разойдись их схемы, разошлись бы и последствия. */
export * from './assignment-periods';
export * from './garage';
export * from './driver-cabinet';
export * from './vehicle-readings';
/* Склад автозапчастей (`auto-parts.ts`) — перед обслуживанием, потому что акт на него ссылается:
 * строка расхода берёт потолок количества отсюда, а движение склада заводится актом (план
 * `docs/auto-parts-plan.md`, Р4). Обратной ссылки нет и не будет — склад существует и без акта. */
export * from './auto-parts';
export * from './vehicle-maintenance';
export * from './releases';
export * from './manuals';
export * from './audit';
