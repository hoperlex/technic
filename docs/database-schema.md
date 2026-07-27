# Схема БД (этап 1)

SQL-first миграции: `apps/api/drizzle/*.sql`, применяются `apps/api/src/db/migrate.ts` с журналом `_migrations`. Drizzle-схема (источник типов приложения): `apps/api/src/db/schema.ts`.

## Таблицы

- **users** — пользователи. `role` (`admin|manager|dispatcher|shtab`, nullable до активации), `construction_object_id` (обязателен для `shtab`), `is_active` (default false), `must_change_password`, `auth_version` (отзыв токенов), `deleted_at` (soft-delete). Уникальный `email` (citext).
- **refresh_sessions** — opaque refresh-токены: `token_hash`, `family_id`, ротация (`replaced_by`, `revoked_at`), reuse detection.
- **construction_objects** — справочник объектов: `code` (unique), `name`, `address`, `is_active`. GIN-trgm по `name`.
- **container_types** — справочник типов контейнеров/машин (управляется менеджером): `code` (unique), `name`, `sort_order`, `is_active`. Seed — 6 значений.
- **vehicle_kinds** — виды ТС (верхний уровень): `code` (unique), `name`, `sort_order`, `is_active`. Seed — «Спецтехника», «Грузоперевозки». Таблицей, а не enum (расширяемо).
- **vehicle_types** — **плоский** справочник типов ТС (один уровень, ADR 0005): `kind_id` (FK, restrict), `code` (unique), `name`, `description`, `sort_order`, `is_active`. CHECK `vehicle_types_code_format_check` — `code ~ '^[a-z][a-z0-9_]*$'`. Seed — 13 типов (миграция `0013`): 8 спецтехника (ЭСМ2) + 5 грузоперевозки (4П+3), включая «Самосвалы». CRUD `/api/v1/vehicle-types`: структурные ключи (`code`/`kind_id`) неизменяемы; удаления нет (деактивация через `is_active`). Переход с иерархии тип→подтип — expand/contract (миграции `0013` expand → `0014` contract, снявшая `parent_id`/`is_selectable` и `vehicle_type_source_mappings`). Обоснование — `docs/adr/0005-vehicle-types-flatten.md` (заменяет `0001`–`0003`).
- **waste_requests** — заявки: FK `object_id`, `container_type_id`; `request_type` (`onetime|weekly`), `delivery_at` (UTC), `comment`, `status` (`new|confirmed|done|cancelled`), `version` (optimistic lock), `created_by/updated_by/deleted_by`, `deleted_at` (soft-delete).
- **request_files** — связь заявка↔файл (PK `(request_id, file_id)`, каскад).
- **request_status_history** — история смены статусов.
- **vehicle_requests** — заявки на технику (модуль «Заказ ТС», миграция `0012`): `num` (identity, отображается «ТС-000123»), `request_type` (`special_equipment|freight_transport`, enum `vehicle_request_type`), FK `object_id`, `vehicle_type_id` (плоский тип классификатора, ADR 0005), `status` (общий enum `request_status`), `comment`, `version` (optimistic lock), `created_by/updated_by/deleted_by`, `deleted_at` (soft-delete). Целостность «ровно одна деталь нужного типа» — сервисной транзакцией (constraint-триггер в бэклоге).
- **special_equipment_request_details** — детали заказа спецтехники (PK=FK `request_id`, каскад): `date_from`, `date_to` (date-only; CHECK `date_to >= date_from`).
- **freight_transport_request_details** — детали грузоперевозки (PK=FK `request_id`, каскад): `scheduled_at` (timestamptz), `volume_m3`/`weight_tons` (`numeric(12,3)`; CHECK >0 и хотя бы одно задано), `loading_location`/`unloading_location` (CHECK not-blank).
- **vehicle_request_files** — связь заявка ТС↔файл (PK `(vehicle_request_id, file_id)`, каскад; UNIQUE `file_id` — файл не в двух заявках ТС; кросс-модульную уникальность с «Мусором» держит общий файловый сервис `services/request-files.ts`).
- **vehicle_request_status_history** — история статусов заявки ТС (+ `comment`).
- **files** — метаданные файлов в S3: `object_key` (unique), `filename`, `content_type`, `size`, `status` (`pending|active|deleted`), `scan_status` (резерв под ClamAV, этап 2), `uploaded_by`, `deleted_at`.
- **jobs** — outbox фоновых задач (§16): `type`, `payload`, `status`, `attempts/max_attempts`, `next_run_at`, `locked_by/locked_until`, атомарный захват `FOR UPDATE SKIP LOCKED`.
- **audit_log** — append-only аудит критичных действий (§22).

## Правила удаления заявок

- Статус **«Новая»** (смены статуса не было) → **hard delete**: строка и связанные файлы удаляются; объекты S3 чистятся задачей `delete_s3_object` (немедленно).
- После первой смены статуса → **soft delete** (`deleted_at`); файлы сохраняются; восстановление — только администратор (`/waste-requests/:id/restore`).
- Отдельно удалённый файл (через редактирование заявки) — soft-delete + физическое удаление из S3 через 30 дней (job).
- Orphan upload-сессии (pending-файлы старше 24ч) чистит worker.

## Индексы

Уникальные: email, коды объектов/типов, `object_key`, `token_hash`. Обычные: статусы, FK, `delivery_at`, `created_at`, `jobs(status,next_run_at)`. GIN-trgm: `construction_objects.name`, `users.full_name` (полнотекстовый поиск).
