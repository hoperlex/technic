# Карта кода: логические области портала

Дерево каталогов не совпадает с логикой работы: один сценарий проходит через контракты, маршруты и сервисы api, схему, слои портала, worker и тесты. Эта карта отвечает на вопрос «куда идти с таким изменением» — и только на него.

Чего здесь нет: перечня файлов и символов (его дешевле получить `rg` и языковым сервером) и копии машинных реестров. Состав разделов портала лежит в [portal-sections.ts](../packages/contracts/src/portal-sections.ts), матрица прав — в [permissions.ts](../packages/contracts/src/permissions.ts) и [access-model.md](access-model.md); карта на них ссылается, а не переписывает.

Полноту карты стережёт `pnpm check:docs`: каждый идентификатор раздела портала назначен ровно одному блоку, каждый файл `apps/api/src/routes/*.ts` покрыт хотя бы одним, и все названные пути существуют. Устаревший путь здесь — дефект, а не история: карта описывает сегодняшнее состояние.

Домены те же, что у [указателя решений](adr/README.md), — иначе вышли бы две несовпадающие классификации одного портала.

## Вывоз мусора

- Домен: `вывоз-мусора`
- Источник истины: [waste-requests.ts](../packages/contracts/src/waste-requests.ts), [waste-tariffs.ts](../packages/contracts/src/waste-tariffs.ts), [waste-tickets.ts](../packages/contracts/src/waste-tickets.ts)
- Разделы портала: `waste`
- API-маршруты: [waste-requests.ts](../apps/api/src/routes/waste-requests.ts), [waste-tariffs.ts](../apps/api/src/routes/waste-tariffs.ts), [waste-types.ts](../apps/api/src/routes/waste-types.ts), [waste-tickets.ts](../apps/api/src/routes/waste-tickets.ts)
- Остальной API: [waste-request-vehicles.ts](../apps/api/src/services/waste-request-vehicles.ts), [waste-pricing.ts](../apps/api/src/services/waste-pricing.ts)
- Web: [waste](../apps/web/src/pages/waste), [waste-request](../apps/web/src/entities/waste-request), [waste-ticket-attach](../apps/web/src/features/waste-ticket-attach)
- Тесты: `waste-request-*.db.test.ts`, `waste-tickets*.db.test.ts`, `waste-contracts.test.ts`
- Решения: [ADR 0009](adr/0009-waste-pricing.md), [ADR 0035](adr/0035-waste-fact-by-volume.md), [ADR 0135](adr/0135-waste-request-completed.md)

## Заказ ТС

- Домен: `заказ-тс`
- Источник истины: [vehicle-requests.ts](../packages/contracts/src/vehicle-requests.ts), [weekly-vehicle-requests.ts](../packages/contracts/src/weekly-vehicle-requests.ts), [assignment-periods.ts](../packages/contracts/src/assignment-periods.ts)
- Разделы портала: `vehicle-requests`
- API-маршруты: [vehicle-requests.ts](../apps/api/src/routes/vehicle-requests.ts), [vehicle-request-assignment.ts](../apps/api/src/routes/vehicle-request-assignment.ts), [vehicle-request-assignment-correction.ts](../apps/api/src/routes/vehicle-request-assignment-correction.ts), [vehicle-request-assignment-repair.ts](../apps/api/src/routes/vehicle-request-assignment-repair.ts), [vehicle-request-period.ts](../apps/api/src/routes/vehicle-request-period.ts), [vehicle-routes.ts](../apps/api/src/routes/vehicle-routes.ts), [weekly-vehicle-requests.ts](../apps/api/src/routes/weekly-vehicle-requests.ts)
- Остальной API: [assignment-command.ts](../apps/api/src/services/assignment-command.ts), [assignment-period.ts](../apps/api/src/services/assignment-period.ts)
- Web: [vehicle](../apps/web/src/pages/vehicle), [vehicle-request](../apps/web/src/entities/vehicle-request)
- Тесты: `vehicle-request-*.db.test.ts`, `weekly-*.db.test.ts`, `assignment-*.db.test.ts`
- Решения: [ADR 0004](adr/0004-vehicle-requests.md), [ADR 0104](adr/0104-vehicle-request-lead-time.md), [ADR 0173](adr/0173-vehicle-request-copy.md)

## Путевые листы и ЭСМ

- Домен: `путевые-листы`
- Источник истины: [waybills.ts](../packages/contracts/src/waybills.ts), [waybill-task-rows.ts](../packages/contracts/src/waybill-task-rows.ts)
- Разделы портала: `waybills`
- API-маршруты: [waybills.ts](../apps/api/src/routes/waybills.ts)
- Остальной API: [esm2-plan.ts](../apps/api/src/services/esm2-plan.ts), [waybill-esm2.ts](../apps/api/src/services/waybill-esm2.ts)
- Web: [waybills](../apps/web/src/pages/waybills)
- Тесты: `waybill-*.db.test.ts`, `esm2-*.db.test.ts`, `waybill-contracts.test.ts`
- Решения: [ADR 0037](adr/0037-freight-transport-waybill.md), [ADR 0060](adr/0060-esm2-weekly-waybill.md), [ADR 0148](adr/0148-print-timeout-ladder.md)

## Механизация

- Домен: `механизация`
- Источник истины: [mech-requests.ts](../packages/contracts/src/mech-requests.ts), [mech-models.ts](../packages/contracts/src/mech-models.ts)
- Разделы портала: `mechanization`
- API-маршруты: [mech-requests.ts](../apps/api/src/routes/mech-requests.ts), [mech-models.ts](../apps/api/src/routes/mech-models.ts)
- Остальной API: [mech-request-guards.ts](../apps/api/src/services/mech-request-guards.ts), [mech-request-list.ts](../apps/api/src/services/mech-request-list.ts)
- Web: [mech](../apps/web/src/pages/mech), [mech-request](../apps/web/src/entities/mech-request)
- Тесты: `mech-*.db.test.ts`, `mech-ordering-grant.db.test.ts`
- Решения: [ADR 0152](adr/0152-mechanization-module.md), [ADR 0171](adr/0171-mechanization-site-approval.md), [ADR 0175](adr/0175-mechanization-assignable-grant.md)

## Орг.техника и обслуживание

- Домен: `оргтехника`
- Источник истины: [service-requests.ts](../packages/contracts/src/service-requests.ts), [office-equipment.ts](../packages/contracts/src/office-equipment.ts), [office-equipment-profiles.ts](../packages/contracts/src/office-equipment-profiles.ts)
- Разделы портала: `office-equipment`
- API-маршруты: [service-requests.ts](../apps/api/src/routes/service-requests.ts), [office-equipment.ts](../apps/api/src/routes/office-equipment.ts), [office-equipment-types.ts](../apps/api/src/routes/office-equipment-types.ts), [office-equipment-models.ts](../apps/api/src/routes/office-equipment-models.ts), [office-equipment-candidates.ts](../apps/api/src/routes/office-equipment-candidates.ts), [office-equipment-consumables.ts](../apps/api/src/routes/office-equipment-consumables.ts), [office-equipment-purchases.ts](../apps/api/src/routes/office-equipment-purchases.ts), [internal-service-requests.ts](../apps/api/src/routes/internal-service-requests.ts), [office-equipment-telemetry.ts](../apps/api/src/routes/office-equipment-telemetry.ts), [internal-device-mail.ts](../apps/api/src/routes/internal-device-mail.ts), [device-mail-review.ts](../apps/api/src/routes/device-mail-review.ts), [device-mail-identities.ts](../apps/api/src/routes/device-mail-identities.ts), [device-mail-rules.ts](../apps/api/src/routes/device-mail-rules.ts)
- Остальной API: [service-request-mail.ts](../apps/api/src/services/service-request-mail.ts), [service-request-mail-audience.ts](../apps/api/src/services/service-request-mail-audience.ts), [service-estimate-revision.ts](../apps/api/src/services/service-estimate-revision.ts) (формат действующей ревизии объёма работ и SQL-редакция правила закрывающего документа)
- Web: [service](../apps/web/src/pages/service), [service-request](../apps/web/src/entities/service-request)
- Тесты: `service-request-*.db.test.ts`, `service-estimate-*.test.ts`, `service-corridors.test.ts`, `office-equipment-*.db.test.ts`
- Решения: [ADR 0085](adr/0085-office-equipment-module.md), [ADR 0125](adr/0125-service-request-cycle-changes.md), [ADR 0174](adr/0174-service-request-internal-repair-without-estimate.md)

## Гараж, показания и ТО

- Домен: `гараж`
- Источник истины: [garage.ts](../packages/contracts/src/garage.ts), [vehicle-readings.ts](../packages/contracts/src/vehicle-readings.ts), [vehicle-maintenance.ts](../packages/contracts/src/vehicle-maintenance.ts)
- Разделы портала: `garage`
- API-маршруты: [garage.ts](../apps/api/src/routes/garage.ts), [vehicle-readings.ts](../apps/api/src/routes/vehicle-readings.ts), [vehicle-readings-stats.ts](../apps/api/src/routes/vehicle-readings-stats.ts), [vehicle-maintenance.ts](../apps/api/src/routes/vehicle-maintenance.ts)
- Остальной API: [readings-intake.ts](../apps/api/src/services/readings-intake.ts), [vehicle-maintenance.ts](../apps/api/src/services/vehicle-maintenance.ts)
- Web: [garage](../apps/web/src/pages/garage), [vehicle-reading](../apps/web/src/entities/vehicle-reading)
- Тесты: `vehicle-readings*.db.test.ts`, `vehicle-maintenance*.db.test.ts`, `garage-*.db.test.ts`
- Решения: [ADR 0076](adr/0076-garage-day-view.md), [ADR 0103](adr/0103-vehicle-readings.md), [ADR 0126](adr/0126-assignment-periods.md)

## Кабинет водителя

- Домен: `кабинет-водителя`
- Источник истины: [driver-cabinet.ts](../packages/contracts/src/driver-cabinet.ts)
- Разделы портала: `driver-cabinet`
- API-маршруты: [driver.ts](../apps/api/src/routes/driver.ts)
- Остальной API: [driver-assignment.ts](../apps/api/src/services/driver-assignment.ts)
- Web: [driver](../apps/web/src/pages/driver)
- Тесты: `driver-cabinet*.db.test.ts`, `driver-routes-mail.db.test.ts`
- Решения: [ADR 0102](adr/0102-driver-cabinet.md), [ADR 0129](adr/0129-driver-cabinet-readings-first.md)

## Справочники и обмен

- Домен: `справочники`
- Источник истины: [counterparties.ts](../packages/contracts/src/counterparties.ts), [objects.ts](../packages/contracts/src/objects.ts), [vehicles.ts](../packages/contracts/src/vehicles.ts), [persons.ts](../packages/contracts/src/persons.ts)
- Разделы портала: `directories`
- API-маршруты: [counterparties.ts](../apps/api/src/routes/counterparties.ts), [objects.ts](../apps/api/src/routes/objects.ts), [departments.ts](../apps/api/src/routes/departments.ts), [warehouses.ts](../apps/api/src/routes/warehouses.ts), [container-types.ts](../apps/api/src/routes/container-types.ts), [vehicles.ts](../apps/api/src/routes/vehicles.ts), [vehicle-models.ts](../apps/api/src/routes/vehicle-models.ts), [vehicle-types.ts](../apps/api/src/routes/vehicle-types.ts), [vehicle-kinds.ts](../apps/api/src/routes/vehicle-kinds.ts), [vehicle-categories.ts](../apps/api/src/routes/vehicle-categories.ts), [vehicle-classifications.ts](../apps/api/src/routes/vehicle-classifications.ts), [vehicle-specs.ts](../apps/api/src/routes/vehicle-specs.ts), [vehicle-trailers.ts](../apps/api/src/routes/vehicle-trailers.ts), [drivers.ts](../apps/api/src/routes/drivers.ts), [manuals.ts](../apps/api/src/routes/manuals.ts), [directory-transfer.ts](../apps/api/src/routes/directory-transfer.ts)
- Остальной API: [directory-purge.ts](../apps/api/src/services/directory-purge.ts), [directory-transfer](../apps/api/src/services/directory-transfer)
- Web: [directories](../apps/web/src/pages/directories)
- Тесты: `directory-*.db.test.ts`, `vehicles-*.db.test.ts`, `drivers-*.db.test.ts`
- Решения: [ADR 0001](adr/0001-vehicle-classification.md), [ADR 0051](adr/0051-suppliers-and-warehouses.md), [ADR 0138](adr/0138-vehicle-trailers-registry.md)

## Автозапчасти

- Домен: `автозапчасти`
- Источник истины: [auto-part-receipts.ts](../packages/contracts/src/auto-part-receipts.ts)
- Разделы портала: —
- API-маршруты: [auto-part-receipts.ts](../apps/api/src/routes/auto-part-receipts.ts)
- Остальной API: [auto-part-receipts.ts](../apps/api/src/services/auto-part-receipts.ts), [auto-part-receipts-read.ts](../apps/api/src/services/auto-part-receipts-read.ts)
- Web: [auto-part-receipt](../apps/web/src/entities/auto-part-receipt)
- Тесты: `auto-part-*.db.test.ts`
- Решения: [ADR 0134](adr/0134-auto-parts.md), [ADR 0154](adr/0154-auto-part-receipts.md)

## Доступ: права, полномочия, область

- Домен: `доступ`
- Текущее состояние: [access-model.md](../docs/access-model.md)
- Источник истины: [permissions.ts](../packages/contracts/src/permissions.ts), [permission-catalog.ts](../packages/contracts/src/permission-catalog.ts), [grants.ts](../packages/contracts/src/grants.ts), [grant-scope.ts](../packages/contracts/src/grant-scope.ts)
- Разделы портала: —
- API-маршруты: [auth.ts](../apps/api/src/routes/auth.ts), [grants.ts](../apps/api/src/routes/grants.ts), [user-grants.ts](../apps/api/src/routes/user-grants.ts)
- Остальной API: [auth](../apps/api/src/auth), [access.ts](../apps/api/src/lib/access.ts), [access-manifest.ts](../apps/api/src/lib/access-manifest.ts)
- Web: [auth](../apps/web/src/auth)
- Тесты: `permissions.test.ts`, `access-conditions.test.ts`, `grants-*.test.ts`, `role-migration-*.test.ts`
- Решения: [ADR 0021](adr/0021-permissions-model.md), [ADR 0106](adr/0106-assignable-permission-grants.md), [ADR 0112](adr/0112-site-role-and-role-grants.md)

## Администрирование: учётки, аудит и служебные выгрузки

- Домен: `учётки-и-аудит`
- Источник истины: [users.ts](../packages/contracts/src/users.ts), [audit.ts](../packages/contracts/src/audit.ts), [registration-request.ts](../packages/contracts/src/registration-request.ts), [analytics.ts](../packages/contracts/src/analytics.ts) (общий язык сводной аналитики: разряды работы, счётчики, деньги вилкой)
- Разделы портала: `admin`
- API-маршруты: [users.ts](../apps/api/src/routes/users.ts), [audit.ts](../apps/api/src/routes/audit.ts), [analytics.ts](../apps/api/src/routes/analytics.ts)
- Остальной API: [audit.ts](../apps/api/src/lib/audit.ts), [user-audit-diff.ts](../apps/api/src/services/user-audit-diff.ts), [analytics](../apps/api/src/services/analytics) (слой атомов «модуль × заказчик × день × позиция»: загрузчики трёх модулей, группировки, нарезка периода — считает один раз и для книги, и для ручки `GET /analytics/summary`), [analytics-export.ts](../apps/api/src/services/analytics-export.ts) и [analytics-export-charts.ts](../apps/api/src/services/analytics-export-charts.ts) (семь листов книги и витрина графиков), [readings-admin-export.ts](../apps/api/src/services/readings-admin-export.ts) (книга показаний той же вкладки), [xlsx.ts](../apps/api/src/lib/xlsx.ts) (писатель книг: числа, стили, сводная, графики)
- Web: [admin](../apps/web/src/pages/admin) (в нём реестр выгрузок [ExportsTab.tsx](../apps/web/src/pages/admin/ExportsTab.tsx) — одна вкладка на все книги), [user-account](../apps/web/src/entities/user-account), [analytics](../apps/web/src/entities/analytics)
- Тесты: `users-*.db.test.ts`, `user-audit*.db.test.ts`, `audit-*.db.test.ts`, `analytics-*.test.ts`, `analytics-facts-*.db.test.ts`, `exports-tab.test.tsx`
- Решения: [ADR 0063](adr/0063-user-archive-lifecycle.md), [ADR 0088](adr/0088-user-audit-tab.md), [ADR 0109](adr/0109-user-audit-changes.md), [ADR 0180](adr/0180-readings-admin-export.md), [ADR 0182](adr/0182-analytics-summary-export.md)

## Почта и рассылки

- Домен: `почта`
- Источник истины: [module-mail.ts](../packages/contracts/src/module-mail.ts), [mailings.ts](../packages/contracts/src/mailings.ts), [mail-accounts.ts](../packages/contracts/src/mail-accounts.ts)
- Разделы портала: —
- API-маршруты: [admin-mail.ts](../apps/api/src/routes/admin-mail.ts), [admin-mailings.ts](../apps/api/src/routes/admin-mailings.ts), [module-mail.ts](../apps/api/src/routes/module-mail.ts), [internal-mail.ts](../apps/api/src/routes/internal-mail.ts)
- Остальной API: [mail.ts](../apps/api/src/services/mail.ts), [mailings](../apps/api/src/services/mailings)
- Web: [module-mail](../apps/web/src/entities/module-mail)
- Тесты: `mail-*.db.test.ts`, `mailing-*.test.ts`, `*-mail.db.test.ts`
- Решения: [ADR 0075](adr/0075-mailing-schedules.md), [ADR 0093](adr/0093-mailing-window-and-digest-tables.md), [ADR 0111](adr/0111-mailing-permission-audience.md)

## Файлы, S3 и распознавание талонов

- Домен: `файлы-и-распознавание`
- Источник истины: [files.ts](../packages/contracts/src/files.ts), [waste-ticket-audit.ts](../packages/contracts/src/waste-ticket-audit.ts)
- Разделы портала: —
- API-маршруты: [files.ts](../apps/api/src/routes/files.ts), [ticket-audit.ts](../apps/api/src/routes/ticket-audit.ts)
- Остальной API: [s3.ts](../apps/api/src/lib/s3.ts), [request-files.ts](../apps/api/src/services/request-files.ts), [ticket-ocr](../apps/worker/src/ticket-ocr)
- Web: [ticket-audit](../apps/web/src/features/ticket-audit)
- Тесты: `*-file-access.db.test.ts`, `ticket-*.db.test.ts`
- Решения: [ADR 0114](adr/0114-waste-ticket-recognition.md), [ADR 0137](adr/0137-waste-ticket-audit-observations.md)

## Каркас портала: разделы, списки, окна

- Домен: `каркас-портала`
- Источник истины: [portal-sections.ts](../packages/contracts/src/portal-sections.ts), [links.ts](../packages/contracts/src/links.ts)
- Разделы портала: —
- API-маршруты: —
- Остальной API: —
- Web: [AppLayout.tsx](../apps/web/src/components/AppLayout.tsx), [ui](../apps/web/src/shared/ui), [App.tsx](../apps/web/src/App.tsx)
- Тесты: `boundaries.test.ts`, `portal-sections.test.ts`, `*-list.test.tsx`
- Решения: [ADR 0030](adr/0030-responsive-layout.md), [ADR 0121](adr/0121-portal-sections-registry.md), [ADR 0136](adr/0136-select-popup-width.md)

## Схема, миграции и выкат

- Домен: `схема-и-выкат`
- Текущее состояние: [database-schema.md](../docs/database-schema.md)
- Источник истины: [schema.ts](../apps/api/src/db/schema.ts), [drizzle](../apps/api/drizzle), [releases.ts](../packages/contracts/src/releases.ts)
- Разделы портала: —
- API-маршруты: [health.ts](../apps/api/src/routes/health.ts), [releases.ts](../apps/api/src/routes/releases.ts)
- Остальной API: [maintenance.ts](../apps/api/src/lib/maintenance.ts), [scripts](../apps/api/scripts)
- Web: [release](../apps/web/src/entities/release)
- Тесты: `releases-*.db.test.ts`, `maintenance-*.db.test.ts`, `migrations-*.db.test.ts`
- Решения: [ADR 0077](adr/0077-release-notes.md), [ADR 0113](adr/0113-role-migration-prepare.md), [ADR 0157](adr/0157-maintenance-mode.md)

## Ворота качества и проверки документации

- Домен: `качество`
- Источник истины: [check.mjs](../scripts/check.mjs), [check-docs.mjs](../scripts/check-docs.mjs), [quality.mjs](../apps/web/scripts/quality.mjs)
- Разделы портала: —
- API-маршруты: —
- Остальной API: —
- Web: [scripts](../apps/web/scripts)
- Тесты: `pnpm check`, `pnpm check:db`, `pnpm check:docs`, `pnpm test:docs`
- Решения: [ADR 0147](adr/0147-quality-gates.md)
