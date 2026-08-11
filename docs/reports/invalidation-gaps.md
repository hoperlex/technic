# Расхождения инвалидации: реестр эффектов против фронта

Вход — `docs/reports/invalidation-audit.md` (снят 10.08.2026 со стороны API, `main` 78562d3).
Здесь вторая половина работы Р3: сверка со стороны `apps/web`. Снято 10.08.2026.

> **Статус на 11.08.2026: все десять расхождений закрыты.** Коммиты `6c1add7` (журнал и рейсы),
> `810670e` (карточка оргтехники), `303dcb4` (удаление насовсем и загрузка справочника).
> В строке 7 адрес ручки был неверен: недельные заявки чистит удаление типа насовсем, а не
> отвязка ТТХ — правка ушла туда, где эффект есть на самом деле.

## Что и как сверялось

1. Взята таблица кросс-сущностных эффектов реестра — 28 строк, 34 ручки.
2. Для каждой ручки в `apps/web/src` найден `useMutation`, который её зовёт: поиск по имени
   метода из `apps/web/src/api/resources.ts` (`vehicleRequestsApi.changeStatus`,
   `vehicleRoutesApi.issueWaybill` и т. п.).
3. У найденной мутации прочитан `onSuccess`, включая вынесенную инвалидацию: локальные
   `const invalidate = () => …` (`shared.tsx`, `VehicleTypeCardDrawer.tsx`), `refresh`,
   колбэк `onChanged`/`onSaved` из родителя, параметр `invalidate` хука `usePurgeAction`.
4. Таблицы БД сопоставлены с корнями ключей React Query.
5. Расхождение засчитано только там, где устаревающие данные действительно читаются отдельным
   `useQuery`; в таблице на это дана вторая ссылка.

### Что важно знать про кэш портала

- `staleTime` по умолчанию — 10 с (`apps/web/src/main.tsx:19`), `refetchOnWindowFocus` выключен.
  Значит недоинвалидация бьёт всегда, а не иногда: экран, открытый в те же 10 секунд, покажет
  устаревшее без всякой дозагрузки; открытый позже — покажет кэш и обновит его фоном.
- Ключи вложены префиксами: `['vehicle-requests']` гасит и `['vehicle-requests', id, 'waybills']`
  (`VehicleRequestViewModal.tsx:207`), и `['vehicle-requests', 'shifts', id]`
  (`VehicleShiftsModal.tsx:83`), и ленту `['vehicle-requests', 'feed', …]`. Поэтому у смен,
  перегонов и листов карточки отдельного дефекта не возникает — они под корнем заявки.
- Отдельные корни, которые префиксом не накрываются ничем: `['waybills']`, `['vehicle-routes']`,
  `['weekly-vehicle-requests']`, `['users']`, `garageKeys`, `officeEquipmentKeys`.
- Соответствие «таблица → ключ» не буквальное в обе стороны. DTO рейса несёт статус своего листа
  джойном, поэтому `POST /waybills/:id/cancel` не пишет в `vehicle_routes`, но кэш
  `['vehicle-routes']` после него содержательно устаревает. Такие случаи реестр по определению
  не видит, и один из них ниже — расхождение № 3.

## Подтверждённые расхождения

Порядок — по заметности: сверху то, что человек увидит скорее.

| Ручка                                       | Что меняет сверх своей таблицы                                 | Мутация на фронте                                                                                                            | Устаревающий запрос                                                                         | Что добавить                                        |
| ------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /vehicle-routes/:id/waybill`          | `waybills`, `waybill_requests`, `waybill_series`               | `VehicleRouteModal.tsx:160` → `afterChange` (`:118`) → `onChanged` = `VehicleRoutesTab.tsx:131`                              | `WaybillsPage.tsx:114` — `['waybills', query]`                                              | `['waybills']` в `refresh` рейсов                   |
| `POST /waybills/:id/cancel` (из журнала)    | статус листа виден в DTO рейса и карточке заявки               | `WaybillsPage.tsx:124`                                                                                                       | `VehicleRoutesTab.tsx:123` — `['vehicle-routes', query]`; `VehicleRequestViewModal.tsx:207` | `['vehicle-routes']` и `['vehicle-requests']`       |
| `POST /waybills/:id/cancel` (из рейса)      | `waybills`                                                     | `VehicleRouteModal.tsx:211` — гасит только `['vehicle-routes']`                                                              | `WaybillsPage.tsx:114` — `['waybills', query]`                                              | `['waybills']`                                      |
| `PATCH /vehicle-requests/:id` (смена срока) | `waybills` через `afterWorkPeriodChanged` → `syncEsm2Waybills` | `VehicleRequestsTab.tsx:836` — гасит только `['vehicle-requests']`                                                           | `WaybillsPage.tsx:114` — `['waybills', query]`                                              | `['waybills']`                                      |
| `POST /directories/:key/import`             | любой справочник по `:key`                                     | `DirectoryTransferTab.tsx:138` — гасит только `['directories', 'transfer']`                                                  | `VehiclesTab.tsx:120`, `DriversTab.tsx:130`, `ObjectsTab.tsx:29` и прочие                   | `qc.invalidateQueries()` целиком либо список корней |
| `DELETE /vehicle-categories/:id`            | `weekly_vehicle_request_items`, `weekly_vehicle_requests`      | `VehicleTypeCardDrawer.tsx:320` → `invalidate` (`:111`)                                                                      | `WeeklyRequestPage.tsx:58` — `['weekly-vehicle-requests', id]`                              | `['weekly-vehicle-requests']`                       |
| `DELETE /vehicle-types/:id/specs/:specId`   | то же + `vehicle_categories`                                   | `VehicleTypeCardDrawer.tsx:141` (`detachMut`) → тот же `invalidate` (`:111`)                                                 | `WeeklyRequestPage.tsx:58`                                                                  | `['weekly-vehicle-requests']`                       |
| `DELETE /objects/:id/purge`                 | `weekly_vehicle_requests`, `weekly_vehicle_request_items`      | `ObjectsTab.tsx:95` — `usePurgeAction`, `invalidate: [objectKeys.root]`                                                      | `WeeklyRequestPage.tsx:58`                                                                  | `['weekly-vehicle-requests']`                       |
| `DELETE /vehicle-requests/:id/purge`        | `weekly_vehicle_request_items` (`dropWeeklyItemsOfRequest`)    | `VehicleRequestsArchiveTab.tsx:93` — `invalidate: [['vehicle-requests']]`                                                    | `WeeklyRequestPage.tsx:58`                                                                  | `['weekly-vehicle-requests']`                       |
| Переходы `service-requests` (12 ручек)      | не таблица: карточка орг.техники несёт `serviceHistory`        | `serviceRequestActions.tsx:82`, `ServiceCompleteModal.tsx:77`, `ServiceAcceptModal.tsx:62` — всюду `serviceRequestKeys.root` | `OfficeEquipmentServiceHistory.tsx:26` — `officeEquipmentKeys.detail(id)`                   | `officeEquipmentKeys.root` — **сделано 10.08.2026** |

### Заметность построчно

1. **Выдача листа из карточки рейса** — самое заметное. Диспетчер выписывает лист и идёт в
   «Путевые листы» печатать: журнал открывается сразу после действия, обычно быстрее 10 секунд.
   Ровно тот же сценарий, что у двух уже исправленных дефектов.
2. **Аннулирование из журнала** — вторым номером: после аннулирования идут в рейс пересобирать
   состав, а список рейсов и карточка ещё считают лист выписанным (`frozen`,
   `VehicleRouteModal.tsx:82`) — рейс покажется замороженным, хотя он уже разморожен.
   Симметричная дыра: то же аннулирование из карточки рейса (строка 3) не гасит журнал.
3. **Правка срока заказа** — заметно реже: журнал листов открывают не сразу после правки заявки.
   Но эффект тот же, и в соседнем месте он уже учтён — `useEarlyEnd` (`shared.tsx:585`) гасит
   `['waybills']` за досрочное завершение, а обычная правка срока — нет.
4. **Импорт справочника** — виден, если сразу после импорта открыть тот же справочник; чаще
   спасает переход между страницами и 10-секундный `staleTime`.
   5–8. **Чистка недельных заявок** (категория, признак типа, площадка, заказ ТС) — редкие
   административные действия, а страница недельной заявки открывается отдельным адресом. Ниже всех
   по заметности, но расхождение настоящее: состав недели уже пуст, а страница показывает строки.
5. **Карточка орг.техники** — разные разделы портала; правит сервисная компания, смотрит владелец.

## Проверено, расхождений нет

- `PATCH /vehicle-requests/:id/status` — `VehicleRequestsTab.tsx:995`: заявки, рейсы, листы. Строки
  `waybill_series`, `vehicle_request_shifts`, `*_details`, `*_assignments`, `*_completions` из
  реестра отдельных ключей на фронте не имеют либо лежат под `['vehicle-requests']`.
- `PATCH /vehicle-requests/:id/assignment` — `VehicleRequestsTab.tsx:963`: три ключа на месте.
- `POST`/`PATCH`/`DELETE /vehicle-requests/:id/early-end` — `shared.tsx:585` (`useEarlyEnd`).
- `PATCH /vehicle-requests/:id/request-type` — `VehicleRequestsTab.tsx:836`: смены и детали под
  корнем заявки, рейсы ручка только читает.
- `POST /vehicle-requests/:id/relocations` — `VehicleRelocationModal.tsx:113`.
- `DELETE /vehicle-routes/:id` (снятие перегона) — `RequestRelocationsField.tsx:53`.
- `PATCH /vehicle-routes/:id` (перенос дня, пишет `freight_transport_request_details`) —
  `VehicleRouteEditModal.tsx:141` → `onSaved` → `VehicleRoutesTab.tsx:131`, заявки гасятся.
- `POST /vehicle-routes/:id/requests`, `DELETE /…/requests/:requestId`, `PUT /…/order` —
  `VehicleRouteModal.tsx:128/146/153` и `VehicleRouteTransferModal.tsx:125`.
- `POST /weekly-vehicle-requests/:id/approval` и `/status` — `WeeklyRequestPage.tsx:116`
  (`invalidate`): неделя, заявки ТС, листы. Самая длинная цепочка реестра закрыта полностью.
- `POST`/`PATCH /objects`, `POST`/`PATCH /counterparties` — обе стороны связки операторов гасятся:
  `ObjectsTab.tsx:77` и `CounterpartiesTab.tsx:140`.
- `POST`/`PATCH /departments` → `users` — `DepartmentsTab.tsx:96`.
- `DELETE /objects/:id`, `DELETE /departments/:id` — деактивация; недельные заявки чистит только
  ветка `registerPurgeRoute` (`objects.ts:220`), в реестре `DELETE /:id` указан ошибочно.
- `DELETE /departments/:id/purge` — `departments.ts:258` только читает `user_departments` для
  проверки ссылок, записи нет.
- `POST`/`PATCH /users`, `POST /users/:id/password`, `DELETE`/`restore`, `purge` — `UsersTab.tsx`
  (395, 404, 415, 424, 438, 445, 457): области и надстройки ролей своих ключей не имеют.
- `POST`/`PATCH`/`DELETE /drivers/:id` — `DriversTab.tsx:180`: `person_employments` и
  `person_specializations` отдельно не запрашиваются.
- `POST`/`PATCH /vehicle-categories`, `POST`/`PATCH /vehicle-types/:id/specs` —
  `VehicleTypeCardDrawer.tsx:111`: классификатор и категории гасятся.
- `POST`/`PATCH /container-types`, `/warehouses`, `/office-equipment*`, `/vehicle-specs`,
  `/waste-types`, `/waste-tariffs` — своя таблица, свой корень.
- `waste-requests` целиком (`WasteRequestsPage.tsx`, `WasteArchiveTab.tsx`) — все мутации гасят
  `['waste-requests']`, под этим корнем и срез «На объекте», и сводки, и архив.
- `POST /admin/mail/schedules/:id/run` — `MailingSchedulesBlock.tsx:477`: и прогоны, и расписание.
- `POST`/`DELETE /waybills/:id/files*` — `WaybillFiles.tsx:37`; `POST /waybills/print-batch` —
  `WaybillPrint.tsx:72`.
- Переходы `service-requests` по таблицам БД: `.update(officeEquipment)` в
  `apps/api/src/routes/service-requests.ts` нет вовсе (только чтения и джойны) — пункт 1 списка
  «Не разобрано» из реестра в части орг.техники закрывается: записи туда сервис не делает.

## Не сверено

1. **`POST /directories/:key/import` по ключам.** Расхождение зафиксировано целиком, но какой
   ключ какой набор кэшей рушит — не расписано; нужен `services/directory-transfer/defs/index.ts`.
2. **Почта, аудит, история** — по условию сверки пропущены. `mail_messages`, `audit_log`,
   `*_history` фронт списком не кэширует, кроме вкладки «Аудит» (`UsersAuditTab.tsx:106`), которая
   гасится вручную при переключении подвкладки (`UsersTab.tsx:1336`).
3. **`service-requests`, ветки `resolveWarrantyClaim`** (`service-requests.ts:516`) — по таблицам
   не перечитаны; реестр их тоже не разобрал. Расхождение № 9 найдено другим путём (через DTO
   карточки орг.техники), но сами гарантийные ветки могут дать ещё один эффект.
4. **`POST /drivers/:id/licenses` и импорт водителей** (`applyDriverImport`) — с конкретными
   ручками не сопоставлены, как и в реестре.
5. **Каскады БД** (`ON DELETE CASCADE`) — не учитывались ни там, ни здесь. Часть расхождений с
   недельными заявками могла бы вырасти именно отсюда.
6. **Расхождения не из реестра.** Отдельный класс, который сверка задела краем: гараж читает
   `garageKeys.drivers` / `garageKeys.vehicles` (`GarageDriversTab.tsx:75`,
   `GarageVehiclesTab.tsx:89`), а правки водителей и техники гасят только `['drivers']` и
   `['vehicles']` (`DriversTab.tsx:180`, `VehiclesTab.tsx:276`). Это не кросс-сущностный эффект
   бэка, а несовпадение ключей на фронте, и полного обхода такого рода здесь не делалось.
7. **Мутации, вызываемые не из `useMutation`** (прямые `await …Api.x()` вне хука) — точечно
   попадались (`weeklyShared.tsx:202`), сплошного обхода не было.
