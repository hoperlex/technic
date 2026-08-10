# Эффекты мутирующих ручек модуля «Заявки на обслуживание»

Добор к `docs/reports/invalidation-audit.md`, пункт 1 раздела «Не разобрано»: там
`apps/api/src/routes/service-requests.ts` разобран поверхностно, и предполагался
кросс-эффект уровня `PATCH /vehicle-requests/:id/status` (запись в десять таблиц).

Снято 10.08.2026 по `main` (78562d3). Код не менялся.

## Главный вывод одной строкой

**Предположение не подтвердилось: записей в чужие таблицы у модуля нет вообще.** Ни одна из
19 мутирующих ручек не пишет ни в `office_equipment*`, ни в склады, ни к поставщикам, ни в
остатки, ни в какой-либо справочник. Все записи — в четыре собственные таблицы модуля плюс
общие `files`/`jobs`/`audit_log`.

Кросс-сущностный эффект у модуля другой природы: **не запись, а чтение**. Карточка единицы
оргтехники собирается из заявок и позиций их смет, поэтому любое действие по заявке делает
её устаревшей, не тронув ни одной строки `office_equipment`. Машинный обход по
`.insert/.update/.delete` такой эффект не видит в принципе. Подробности — в разделе
«Кросс-сущностные эффекты».

## Как снято

1. Прочитан целиком `apps/api/src/routes/service-requests.ts` (2289 строк). Найдено
   **19 мутирующих обработчиков**: 18 через `r.post`/`r.patch`/`r.put`/`r.delete` плюс
   `DELETE /:id/purge` через `registerPurgeRoute` (`services/directory-purge.ts:133`) —
   машинный обход её не видит, потому что регистрация лежит в вызове хелпера.
2. Собраны все `.insert(X)` / `.update(X)` / `.delete(X)` в файле — 22 места, все они
   прочитаны и сопоставлены с обработчиком.
3. Локальные хелперы разобраны отдельно и полностью: `applyTransition` (`:626`),
   `resolveWarrantyClaim` (`:516`), `assertNoOpenRequest` (`:594`),
   `assertEstimateReplaceable` (`:493`), `claimingRequestNumbers` (`:483`),
   `estimateItems` (`:716`), `resolveCustomerDepartment` (`:1295`).
4. Транзитивно (глубина 2–3) пройдены все импортируемые сервисы:
   `services/request-files.ts` (`assertFilesAttachable`, `assertTotalWithinLimit`,
   `markFilesActive`, `scheduleFilesDeletion`, `hardDeleteFiles`),
   `services/directory-purge.ts` (`registerPurgeRoute`),
   `services/service-request-diff.ts` и `services/service-request-history.ts`
   (обе — чистое чтение и форматирование, записей нет), `lib/audit.ts` (`writeAudit`).
5. Матрица сбросов `serviceResetOnTransition` прочитана в контрактах
   (`packages/contracts/src/service-requests.ts:184`) вместе с `SERVICE_ADMIN_ROLLBACKS`
   (`:91`) — по ней выписано, какие таблицы затрагивает каждая дуга, а не каждая ручка.
6. Проверка «а не пишет ли кто-то ещё»: `grep` по всему `apps/api/src` на
   `insert/update/delete` таблиц `serviceRequest*` — записей вне
   `routes/service-requests.ts` **нет**; и обратно, на `officeEquipment` — записи есть
   только в `routes/office-equipment.ts`, `routes/office-equipment-types.ts` и
   `services/directory-transfer/defs/office.ts`, то есть модуль заявок в них не пишет.
7. Каскады и триггеры: прочитано определение четырёх таблиц в `apps/api/src/db/schema.ts`
   (`:1200`, `:1357`, `:1440`, `:1472`) и единственная миграция модуля
   `apps/api/drizzle/0105_service_requests.sql`. Триггеров и функций в миграциях нет
   (`grep 'CREATE TRIGGER'` по `drizzle/*.sql` — пусто), суммы считаются `GENERATED`-колонками.
8. Дополнительно сверена сторона портала: ключи кэша
   (`apps/web/src/entities/service-request/api/keys.ts`) и все `invalidateQueries` в
   слайсах модуля — чтобы понять, покрыт ли найденный эффект.

## Свои таблицы модуля

Четыре, все с `ON DELETE CASCADE` на `service_requests.id`:

- `service_requests` — сама заявка;
- `service_request_items` — строки сметы (план и факт в одной строке, суммы `GENERATED`);
- `service_request_files` — связка с документами (виды: вложение, смета, акт, счёт, талон);
- `service_request_status_history` — история переходов.

Внешние ссылки заявки объявлены `RESTRICT`: `office_equipment_id`, `equipment_object_id`,
`customer_department_id`, `equipment_department_id`, `service_counterparty_id`, `created_by`.
Плюс `warranty_claim_item_id → service_request_items.id ON DELETE RESTRICT` — ссылка одной
заявки на строку сметы **другой** заявки (см. ниже).

## Таблица: что пишет каждая ручка

`audit_log` пишется почти везде (`writeAudit`) и в колонке не повторяется — как и в исходном
реестре, он вынесен за скобки. Так же вынесены `files` и `jobs` (отложенное удаление объектов
из хранилища).

| Метод + путь                   | Пишет в таблицы                                                                         | Через какой сервис                                                        | Кросс-сущностный? |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- |
| `POST /`                       | `service_requests`, `service_request_status_history`, `service_request_files`           | прямые `insert`; `assertFilesAttachable` + `markFilesActive` (`files`)    | нет (см. §Ч)      |
| `PATCH /:id`                   | `service_requests`                                                                      | прямой `update`; `resolveWarrantyClaim` — только чтение                   | нет (см. §Ч)      |
| `DELETE /:id` (в архив)        | `service_requests`                                                                      | прямой `update` (`deleted_at`)                                            | нет (см. §Ч)      |
| `PATCH /:id/service`           | `service_requests`, `service_request_items` (delete), `service_request_status_history`  | локальный `delete` при смене исполнителя + `applyTransition`              | нет (см. §Ч)      |
| `PATCH /:id/decline`           | `service_requests`, `service_request_status_history`                                    | `applyTransition` (сброс `executor`)                                      | нет (см. §Ч)      |
| `PATCH /:id/start`             | `service_requests`, `service_request_status_history`                                    | `applyTransition` (без сбросов)                                           | нет (см. §Ч)      |
| `PUT /:id/estimate`            | `service_request_items` (delete + insert), `service_requests`                           | прямые записи; `assertEstimateReplaceable` — чтение                       | нет (см. §Ч)      |
| `PATCH /:id/estimate/submit`   | `service_request_items` (только при `warrantyRepair`), `service_requests`, история      | локальные `delete`/`insert` + `applyTransition`                           | нет (см. §Ч)      |
| `PATCH /:id/estimate/approval` | `service_requests`, `service_request_status_history`                                    | `applyTransition` (при отказе — сброс `approval`)                         | нет (см. §Ч)      |
| `PATCH /:id/estimate/reopen`   | `service_requests`, `service_request_status_history`                                    | `applyTransition` (сброс `approval`)                                      | нет (см. §Ч)      |
| `PATCH /:id/complete`          | `service_request_items` (update по каждой строке), `service_requests`, история          | локальный цикл `update` + `applyTransition`                               | **да** (см. §Ч2)  |
| `PATCH /:id/accept`            | `service_requests`, `service_request_status_history`                                    | `applyTransition` (без сбросов)                                           | **да** (см. §Ч3)  |
| `PATCH /:id/rework`            | `service_request_items` (update: снятие факта и гарантий), `service_requests`, история  | `applyTransition`, сброс `completion`                                     | **да** (см. §Ч2)  |
| `PATCH /:id/status`            | `service_requests`, `service_request_status_history`, `service_request_items` (по дуге) | `applyTransition`, сбросы зависят от дуги (таблица дуг ниже)              | **да** (см. §Ч2)  |
| `PATCH /:id/service-comment`   | `service_requests`                                                                      | прямой `update`                                                           | нет               |
| `POST /:id/files`              | `service_request_files`                                                                 | `assertFilesAttachable` + `markFilesActive` (`files`)                     | нет               |
| `DELETE /:id/files/:fileId`    | `service_request_files`                                                                 | `scheduleFilesDeletion` (`files` update + `jobs` insert)                  | нет               |
| `POST /:id/restore`            | `service_requests`                                                                      | прямой `update`; `assertNoOpenRequest` — чтение                           | нет (см. §Ч)      |
| `DELETE /:id/purge`            | `service_requests` (+ каскадом три свои таблицы)                                        | `registerPurgeRoute` → `cfg.remove` → `hardDeleteFiles` (`files`, `jobs`) | нет (см. §Ч)      |

Ссылки в колонке «Кросс-сущностный?» ведут в раздел «Кросс-сущностные эффекты»:
§Ч — карточка оргтехники, §Ч2 — реестр гарантий, §Ч3 — снятие блокировки удаления.

## Переходы статуса: что затрагивает каждая дуга

`applyTransition` (`service-requests.ts:626`) сам по себе пишет ровно в три таблицы:
`service_requests` (update со сверкой `version`), `service_request_status_history` (insert) и —
**только при сбросе** — `service_request_items`. Никаких других таблиц он не касается ни на
одной дуге. Что именно сбрасывается, решает `serviceResetOnTransition`, а не маршрут.

| Дуга (from → to)                | Сброс                              | Трогает `service_request_items`?          |
| ------------------------------- | ---------------------------------- | ----------------------------------------- |
| `assigned → new` (отказ, откат) | `executor`                         | нет                                       |
| `* → cancelled` (отмена)        | `executor`, `approval`             | нет                                       |
| `cancelled → new` (откат)       | `executor`, `estimate`, `approval` | **да — `delete` всей сметы**              |
| `* → diagnostics`               | `approval`                         | нет                                       |
| `done → in_work` (доработка)    | `completion`                       | **да — `update`: факт и гарантии в NULL** |
| `accepted → done` (откат)       | `acceptance`                       | нет                                       |
| прочие (`new → assigned` и др.) | —                                  | нет                                       |

Две дуги здесь неочевидны и заслуживают отдельного внимания:

- **`cancelled → new`** (административное восстановление отменённой заявки) **стирает смету
  целиком**. Это единственный переход, физически удаляющий строки. Перед удалением стоит
  `assertEstimateReplaceable`: если по этой смете кто-то обратился по гарантии, переход
  отвечает 409 с номерами обращений, а не ошибкой целостности БД.
- **`done → in_work`** (`/rework` и одноимённый откат через `/status`) **обнуляет гарантии**
  всех строк — `performed`, `actual_quantity`, `warranty_until`, `warranty_until_manual`.
  Комментарий в коде объясняет почему: `CHECK` не допускает гарантию у невыполненной строки.
  Следствие для портала — в §Ч2.

Через `/status` доступны только отмена (`* → cancelled`) и откаты из
`SERVICE_ADMIN_ROLLBACKS`. Обе «тяжёлые» дуги выше достижимы именно оттуда, то есть
одна и та же ручка `/status` на разных телах запроса даёт разный набор затронутых таблиц.

## Кросс-сущностные эффекты

Главный результат. Все три эффекта — **не записи в чужие таблицы**, а изменение того, что
отдают чужие ручки. Поэтому их и не видно обходом по `.insert/.update/.delete`: искали не то.

### §Ч. Любое действие по заявке меняет карточку единицы оргтехники

`GET /office-equipment/:id` при наличии права `serviceRequests.read` дописывает в ответ секцию
`serviceHistory` (`apps/api/src/routes/office-equipment.ts:465`), которую собирает
`loadServiceHistory` (`:291`). В ней два блока, оба целиком из чужого модуля:

- последние 10 заявок по этой единице — номер, статус, даты, сумма по акту, исполнитель
  (`serviceRequests` + `counterparties`, `:296–319`);
- **действующие гарантии ремонтов** — строки `service_request_items`, у которых
  `performed = true`, `warranty_until IS NOT NULL` и срок ещё не истёк (`:328–345`).

**Почему неочевидно.** `office_equipment` — справочник, и по всем привычкам портала его кэш
гасится правкой справочника. Но здесь строка справочника не меняется вовсе: меняются заявки,
а карточка единицы просто читает их join-ом на лету. Со стороны фронта видно, что
`PATCH /service-requests/:id/complete` вернул обновлённую заявку — и совершенно не видно, что
у карточки принтера в справочнике теперь другая история ремонтов и другой список гарантий.

**Состояние на портале: не покрыто.** Все 11 мест мутаций модуля
(`features/assign-service`, `features/estimate-editor`, `features/estimate-approval`,
`features/service-complete`, `features/service-accept`, `pages/service/*`) гасят ровно один
ключ — `serviceRequestKeys.root`. Ключ оргтехники не гасит никто. Открытая рядом карточка
единицы будет показывать вчерашнюю историю ремонтов до перезагрузки страницы.

Затронуты **все 19 ручек**: заведение добавляет заявку в историю, любой переход меняет её
статус и суммы в срезе, `/complete` меняет ещё и список гарантий, архивирование и удаление
насовсем убирают строку из среза.

### §Ч2. Закрытие работ и возврат на доработку правят реестр гарантий

Реестр гарантий (`GET /service-requests/warranties`, `service-requests.ts:936`) —
**объединение двух источников**: гарантий поставщика на саму технику (`office_equipment.
warranty_until`) и гарантий ремонтов (`service_request_items.warranty_until`). Отдельной
таблицы у реестра нет, он собирается запросом.

- `PATCH /:id/complete` проставляет `warranty_until` каждой выполненной строке — либо из
  талона (`warranty_until_manual = true`), либо расчётом «дата выполнения + `warranty_months`».
  Это единственное место в проекте, где гарантии ремонтов появляются.
- `PATCH /:id/rework` и откат `done → in_work` через `/status` те же гарантии **снимают**
  (сброс `completion` в `applyTransition:661`).
- `cancelled → new` через `/status` удаляет строки вместе с гарантиями.

**Почему неочевидно.** Реестр гарантий — отдельная вкладка портала со своими фильтрами, и по
виду она сущность сама по себе. Кроме того, половина её строк приходит из справочника
оргтехники, то есть у вкладки два независимых источника устаревания.

**Состояние на портале: покрыто, но случайно повезло.** Ключ `warranties` заведён семейством
**внутри** корня `service-requests`, а не своим корнем — комментарий в
`apps/web/src/entities/service-request/api/keys.ts` этот выбор явно обосновывает. Поэтому
`invalidateQueries({ queryKey: serviceRequestKeys.root })` гасит его заодно. Тот же приём
спасает бейдж `waitingCount` (`GET /waiting-count`), который считается по всем видимым
заявкам и устаревает от любого перехода в любой чужой заявке.

### §Ч3. Приёмка и отмена разблокируют удаление единицы оргтехники

`DELETE /office-equipment/:id` и `DELETE /office-equipment/:id/purge` отказывают с 409, пока
по единице есть незакрытая заявка — `assertNoOpenServiceRequest`
(`apps/api/src/routes/office-equipment.ts:259`), плюс `RESTRICT` на самой ссылке
`service_requests.office_equipment_id`.

Значит, `PATCH /:id/accept` и отмена через `/status` — единственные два действия, после
которых удаление единицы начинает проходить; а `POST /service-requests/` — действие, после
которого оно перестаёт проходить. Ни в одной из этих ручек `office_equipment` не упоминается.

**Почему неочевидно.** Это эффект на **доступность чужого действия**, а не на данные. Кнопка
«Удалить» в справочнике оргтехники должна становиться активной или неактивной от действия в
другом разделе, причём условие живёт целиком на сервере.

Тот же уникальный индекс работает и в обратную сторону:
`service_requests_open_per_equipment_unique` (`schema.ts:1333`) допускает **одну** незакрытую
заявку на единицу. Поэтому `POST /` и `POST /:id/restore` проверяются
`assertNoOpenRequest`, а `/accept` и отмена освобождают место для следующей заявки.

### Особый случай: ссылка на смету чужой заявки

`service_requests.warranty_claim_item_id → service_request_items.id ON DELETE RESTRICT`
(`schema.ts:1247`, FK ставится отдельным `ALTER` в миграции 0105). Заявка Б обращается по
гарантии конкретной строки сметы заявки А. Записью это не является — ссылку пишет сама
заявка Б, — но обращение делает часть операций над заявкой А **невозможными**:

- `PUT /:id/estimate` (заявка А) → 409 «по гарантии этой сметы обратились: …»;
- `PATCH /:id/service` со сменой исполнителя (А) → тот же 409;
- `PATCH /:id/estimate/submit` с `warrantyRepair` (А) → тот же 409;
- `/status` по дуге `cancelled → new` (А) → тот же 409;
- `DELETE /:id/purge` (А) → 409 «по гарантии этой заявки обращались: …».

Всё это — `assertEstimateReplaceable` (`:493`) и `claimingRequestNumbers` (`:483`). Заявка А
может стать нередактируемой из-за действия в заявке Б, о котором её владелец не знает.

## Чего в модуле нет — проверено явно

Отрицательный результат тоже результат, и он был вопросом задачи:

- **`office_equipment` / `office_equipment_types`** — импортируются в маршруты
  (`service-requests.ts:80–81`), но исключительно для `select`: снимок предмета при заведении
  заявки, перепроверка гарантии поставщика в `PATCH /:id` и левая половина реестра гарантий.
  Ни одного `insert`/`update`/`delete` по ним. `warranty_until` единицы модуль **не двигает**:
  гарантия поставщика правится только карточкой оргтехники.
- **Склад (`warehouses`, `warehouse_*`), поставщики, остатки** — в модуле нет ни импорта, ни
  упоминания. Запчасти в смете (`kind = 'part'`) — свободный текст с количеством и ценой, со
  складским учётом не связаны никак. Списания при закрытии работ **не происходит**.
- **Сметы за пределами модуля** — `service_request_items` больше нигде не пишутся; читает их
  только карточка оргтехники (гарантии) и, по чтению, дайджесты рассылок.
- **Справочники** — молчаливых записей в справочные таблицы нет ни одной. Единственное, что
  модуль делает со справочниками, — снимает с них копии полей при заведении заявки
  (`equipment_name`, `equipment_serial_number`, `equipment_inventory_number`,
  `equipment_object_id`, `equipment_department_id`), чтобы позднее переименование техники не
  переписывало историю. Это запись в свою таблицу, не в справочник.
- **Триггеров и хранимых функций нет.** `amount` и `actual_amount` —
  `GENERATED ALWAYS AS`-колонки, `num` — `GENERATED ALWAYS AS IDENTITY`. Побочных записей они
  не делают.
- **Почта** — модуль писем не шлёт: `queueMail` в нём не вызывается. Заявки на обслуживание
  читаются дайджестами (`services/mailings/digest-sections.ts`,
  `services/mailings/digest-context.ts`), но по расписанию, а не из ручек модуля.

## Не разобрано

1. **Дайджесты рассылок.** `services/mailings/digest-*.ts` читают `serviceRequests` — какие
   именно секции и по какому расписанию, не смотрел. Мутирующих ручек модуля это не касается
   (эффект идёт в обратную сторону), но на полноту картины «кто зависит от заявок» влияет.
2. **`GET /` (список) и `GET /warranties` разобраны не полностью** — прочитаны на уровне
   источников данных, а не фильтров. Полный список того, какие поля чужих таблиц попадают в
   выдачу списка, не выписан; для §Ч это неважно (карточка оргтехники разобрана точно), но для
   обратной задачи «правка справочника → устарел список заявок» понадобится.
3. **`registerPurgeRoute` разобран по одному вызову.** Проверено, что `cfg.remove` модуля
   заявок делает `delete(serviceRequests)` + `hardDeleteFiles`. Общий код хелпера
   (`directory-purge.ts:133–170`) прочитан бегло: собственных записей, кроме `writeAudit`, в
   нём не нашлось, но построчно он не вычитан.
4. **Каскад проверен по схеме, не по базе.** Три `ON DELETE CASCADE` на `service_requests.id`
   прочитаны в `schema.ts`; что миграция 0105 создала ровно это, сверено по названиям, а не
   выполнением на живой базе.
5. **Сторона портала сверена только по `invalidateQueries`.** Вывод «ключ оргтехники не
   гасится» получен grep-ом по слайсам модуля заявок. Возможен обходной путь — например, общий
   инвалидатор в `shared/api` или `staleTime: 0` у карточки оргтехники, — который делает
   проблему §Ч ненаблюдаемой. Не проверено.
6. **Права и области видимости не разбирались.** `serviceRequestScopeWhere`,
   `serviceExecutorVisibilityWhere`, `officeEquipmentScopeWhere` из `lib/access.ts` прочитаны
   только по именам вызовов. Записей они не делают, но кто именно увидит эффект §Ч, зависит
   от них.
