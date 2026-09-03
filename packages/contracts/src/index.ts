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
export * from './office-equipment-purchases';
export * from './office-equipment-history';
export * from './service-requests';
export * from './container-types';
export * from './vehicle-kinds';
export * from './vehicle-types';
export * from './vehicle-specs';
export * from './vehicle-categories';
export * from './vehicle-classifications';
export * from './vehicles';
/* Прицепы (`vehicle-trailers.ts`) — сразу за техникой, потому что читаются с ней рядом, и
 * отдельным файлом ровно потому, что прицеп не единица техники: в `vehicles` он не лежит
 * (план `docs/vehicle-trailers-plan.md`, Р7), и общий файл со временем стёр бы эту границу. */
export * from './vehicle-trailers';
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
/* Аудит распознавания (`waste-ticket-audit.ts`) — снова отдельным файлом и по той же причине, что
 * талоны отделены от заявки: круг читателей у него свой и ещё уже. Разбирают талоны многие, а
 * смотрят на цену и качество чтения единицы, и право там сквозное (ADR 0137). */
export * from './waste-ticket-audit';
export * from './vehicle-routes';
export * from './cost-target';
export * from './vehicle-request-trips';
export * from './route-points';
export * from './waybill-task-rows';
export * from './vehicle-request-shifts';
export * from './vehicle-request-days';
export * from './vehicle-requests';
export * from './vehicle-request-feed';
/* Механизация (`mech-requests.ts`) — после заявки на технику, потому что читается с ней рядом и
 * заимствует у неё две вещи: склонение отработанного и набор закрытых статусов. Отдельным файлом,
 * а не частью «Заказа ТС», потому что общего у модулей только это: у аренды малой механизации свой
 * цикл, своя область и свой заказчик (план `docs/mechanization-module-plan.md`, Р1, Р10). */
export * from './mech-requests';
/* Справочник моделей механизации — сразу за заявкой: этап Э2 сделает его источником поля
 * «Модель», а пока справочник живёт сам по себе (план `docs/mechanization-models-directory-plan.md`). */
export * from './mech-models';
export * from './weekly-vehicle-requests';
export * from './waybills';
/* Бюджет печати (`print-budget.ts`) — сразу за путевым листом: печатают именно его, и лестница
 * сроков читается вместе с бланком, а не в разделе транспорта. */
export * from './print-budget';
/* Периоды назначения (`assignment-periods.ts`) — после заявки и путевого листа, потому что читаются
 * они вместе: история назначения объясняет, чей состав напечатан в каком бланке. Двери появляются на
 * этапе 3 плана `docs/assignment-periods-plan.md`; словарь и тела выписаны раньше — у фичи пять
 * дверей с общим рукопожатием, и разойдись их схемы, разошлись бы и последствия. */
export * from './assignment-periods';
export * from './garage';
export * from './driver-cabinet';
export * from './vehicle-readings';
/* Чеки на автозапчасти (`auto-part-receipts.ts`) — на месте склада, который они заменили (план
 * `docs/auto-part-receipts-plan.md`, Р1). Контракты склада уехали выпуском 2 «Заморозка» вместе с
 * его ручками (Р22): читателей у них не осталось — пол `CLIENT_CONTRACT` отрезал старые вкладки
 * ещё до выката. Наследства чек не принял никакого: он не ссылается ни на позицию склада, ни на её
 * потолок количества — своя граница объявлена своим числом. */
export * from './auto-part-receipts';
export * from './vehicle-maintenance';
export * from './releases';
export * from './manuals';
export * from './audit';
