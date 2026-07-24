# Схема БД (этап 1)

SQL-first миграции: `apps/api/drizzle/*.sql`, применяются `apps/api/src/db/migrate.ts` с журналом `_migrations`. Drizzle-схема (источник типов приложения): `apps/api/src/db/schema.ts`.

## Таблицы

- **users** — пользователи. `role` (`admin|manager|dispatcher|shtab`, nullable до активации), `construction_object_id` (обязателен для `shtab`), `is_active` (default false), `must_change_password`, `auth_version` (отзыв токенов), `deleted_at` (soft-delete). Уникальный `email` (citext).
- **refresh_sessions** — opaque refresh-токены: `token_hash`, `family_id`, ротация (`replaced_by`, `revoked_at`), reuse detection.
- **construction_objects** — справочник объектов: `code` (unique), `name`, `address`, `is_active`. GIN-trgm по `name`.
- **container_types** — справочник типов контейнеров/машин (управляется менеджером): `code` (unique), `name`, `sort_order`, `is_active`. Seed — 6 значений.
- **vehicle_kinds** — виды ТС (верхний уровень): `code` (unique), `name`, `sort_order`, `is_active`. Seed — «Спецтехника», «Грузоперевозки». Таблицей, а не enum (расширяемо).
- **vehicle_types** — иерархический справочник типов/подтипов ТС в одной таблице: `kind_id` (FK, restrict), `parent_id` (self), `code` (unique), `name`, `description`, `is_selectable`, `sort_order`, `is_active`. Составной FK `(parent_id, kind_id)` держит родителя и дочерний тип в одном виде. Инварианты (миграция `0011`, этап 2.1): CHECK `vehicle_types_level_selectable_check` — тип (`parent_id IS NULL`) невыбираем, подтип — выбираем; CHECK `vehicle_types_code_format_check` — `code ~ '^[a-z][a-z0-9_]*$'`. Глубина 2 уровня — на уровне приложения. Наполнение (9 родителей + 22 подтипа) — миграция `0010`. CRUD `/api/v1/vehicle-types` (этап 2.1): создание типа/подтипа различается полем `level`; структурные ключи (`code`/`kind_id`/`parent_id`/`level`/`is_selectable`) неизменяемы; удаления нет (деактивация подтипа через `is_active`); активность типа — производная (есть ли активный подтип). Обоснование — `docs/adr/0001-vehicle-classification.md`, `0002-vehicle-classification-population.md`, `0003-vehicle-types-directory.md`.
- **vehicle_type_source_mappings** — правила сопоставления исходных «Тип ТС» (из Excel) с типом/подтипом: `source_code`, `source_name`, `normalized_source_name`, `vehicle_type_id` (FK, restrict), `resolution_strategy` (`direct|by_model|by_registry`, CHECK), `requires_instance_resolution`, `comment`, `is_active`. Уникально `(source_code, normalized_source_name)`. Однозначные → конечный подтип; неоднозначные → родитель. «Самосвалы» не сопоставляются (исключены).
- **waste_requests** — заявки: FK `object_id`, `container_type_id`; `request_type` (`onetime|weekly`), `delivery_at` (UTC), `comment`, `status` (`new|confirmed|done|cancelled`), `version` (optimistic lock), `created_by/updated_by/deleted_by`, `deleted_at` (soft-delete).
- **request_files** — связь заявка↔файл (PK `(request_id, file_id)`, каскад).
- **request_status_history** — история смены статусов.
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
