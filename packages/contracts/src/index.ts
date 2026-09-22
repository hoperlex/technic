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
/* Рубильники приёма (`feature-flags.ts`) — перед ответами сессии, потому что приезжают именно в
 * них: ключ объявлен здесь, значение считает сервер, а правило «нет ключа — выключено» живёт рядом
 * с реестром, чтобы у портала не завелось второй копии (план
 * `docs/office-equipment-request-subject-plan.md`, Р10). */
export * from './feature-flags';
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
/* Бизнес-блоки истории (`office-equipment-blocks.ts`) — сразу за лентой, потому что читаются в том
 * же окне и поверх тех же таблиц, и отдельным файлом ровно потому, что моделью ленте не родня:
 * там размеченное объединение шести видов с общим правилом сравнения, здесь три плоские строки со
 * своими ключами порядка и несовместимыми курсорами (план `docs/office-equipment-history-blocks-plan.md`,
 * §4, Р8). Общий файл со временем стёр бы эту границу — вместе с ответом на вопрос, где живёт
 * правило «сумма ремонта видна не всем». */
export * from './office-equipment-blocks';
export * from './office-equipment-profiles';
/* Кандидаты (`office-equipment-candidates.ts`) — сразу за справочником, потому что читаются с ним
 * рядом, и отдельным файлом ровно потому, что кандидат не запись справочника: в `office_equipment`
 * он не лежит (план `docs/office-equipment-candidate-plan.md`, Р1), а общий файл со временем стёр
 * бы эту границу — ту самую, ради которой сообщение и отделено от карточки. */
export * from './office-equipment-candidates';
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
/* Журнал отправки писем: очередь `mail_messages` глазами администратора (ADR 0199). */
export * from './mail-log';
export * from './module-mail';
export * from './request-history';
export * from './waste-tariffs';
export * from './waste-requests';
/* Общий словарь распознавания (`recognition.ts`) — перед всеми заданиями, потому что общий для
 * них: чем читали, повторится ли сбой, чей он и какое это было задание. Заданий два — талоны
 * вывоза и чеки на автозапчасти, — а словарь один, иначе два его списка разъехались бы молча. */
export * from './recognition';
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
/* Статистика вывоза (`waste-stats.ts`) — после талонов, потому что опирается на оба соседа: объём
 * приходит от заявки, подтверждение — от талона (план `docs/waste-stats-tab-plan.md`). */
export * from './waste-stats';
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
export * from './fuel-norms';
export * from './vehicle-readings';
/* Чеки на автозапчасти (`auto-part-receipts.ts`) — на месте склада, который они заменили (план
 * `docs/auto-part-receipts-plan.md`, Р1). Контракты склада уехали выпуском 2 «Заморозка» вместе с
 * его ручками (Р22): читателей у них не осталось — пол `CLIENT_CONTRACT` отрезал старые вкладки
 * ещё до выката. Наследства чек не принял никакого: он не ссылается ни на позицию склада, ни на её
 * потолок количества — своя граница объявлена своим числом. */
export * from './auto-part-receipts';
/* Распознавание чека (`auto-part-receipt-recognition.ts`) — отдельным файлом от самого чека по той
 * же причине, по какой талоны отделены от заявки: предмет у него другой. Чек — это документ, а
 * здесь прочитанное моделью, которое ещё не документ и станет им только после нажатия
 * «Сохранить» (план `docs/auto-part-receipt-ocr-plan.md`). */
export * from './auto-part-receipt-recognition';
export * from './vehicle-maintenance';
export * from './releases';
export * from './manuals';
export * from './audit';
/* Сводная аналитика (`analytics.ts`) — последней: она ничего не определяет, а только сводит уже
 * определённое тремя модулями. Общий язык книги и будущего экрана аналитики
 * (план `docs/analytics-summary-export-plan.md`, Р14). */
export * from './analytics';
/* Телеметрия оргтехники (`device-telemetry.ts`) — общий язык почтового приёма и будущего
 * коллектора (план `docs/office-equipment-mail-telemetry-plan.md`, Р4). Ниже аналитики по той же
 * причине, по какой она сама стоит последней: этот файл ничего не определяет в предметной
 * области модуля, он описывает поток данных, который в неё входит. */
export * from './device-telemetry';
/* Опрос аппарата по сети (`device-poll.ts`) — сразу за телеметрией, потому что говорит на её
 * языке: словарь метрик, единицы и источник берутся оттуда, а здесь добавлено только то, чего у
 * письма нет, — адрес, исход попытки и сверка серийника (решение `docs/adr/0205-device-network-poll.md`). */
export * from './device-poll';
