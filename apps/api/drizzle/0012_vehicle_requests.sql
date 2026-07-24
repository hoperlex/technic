-- Этап «Заказ ТС» (каркас): base-таблица заявок на технику + две detail-таблицы,
-- файловые связи и история статусов. Статусы — существующий enum request_status.
-- Constraint-триггер «ровно одна деталь нужного типа» пока НЕ создаётся (в бэклоге);
-- на этом этапе целостность деталей обеспечивает сервисная транзакция.

-- 1. Тип заявки на технику.
CREATE TYPE vehicle_request_type AS ENUM ('special_equipment', 'freight_transport');

-- 2. Base-таблица заявок.
CREATE TABLE vehicle_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  num integer GENERATED ALWAYS AS IDENTITY,
  request_type vehicle_request_type NOT NULL,
  object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  vehicle_type_id uuid NOT NULL REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  status request_status NOT NULL DEFAULT 'new',
  comment text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicle_requests_num_unique ON vehicle_requests (num);
CREATE INDEX vehicle_requests_object_idx ON vehicle_requests (object_id);
CREATE INDEX vehicle_requests_request_type_idx ON vehicle_requests (request_type);
CREATE INDEX vehicle_requests_status_idx ON vehicle_requests (status);
CREATE INDEX vehicle_requests_vehicle_type_idx ON vehicle_requests (vehicle_type_id);
CREATE INDEX vehicle_requests_created_at_idx ON vehicle_requests (created_at);
CREATE INDEX vehicle_requests_deleted_at_idx ON vehicle_requests (deleted_at);
CREATE INDEX vehicle_requests_object_status_idx ON vehicle_requests (object_id, status);
CREATE INDEX vehicle_requests_type_status_idx ON vehicle_requests (request_type, status);

-- 3. Детали заказа спецтехники (период date-only).
CREATE TABLE special_equipment_request_details (
  request_id uuid PRIMARY KEY REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  date_from date NOT NULL,
  date_to date,
  CONSTRAINT special_equipment_date_order_check CHECK (date_to IS NULL OR date_to >= date_from)
);
CREATE INDEX special_equipment_date_from_idx ON special_equipment_request_details (date_from);
CREATE INDEX special_equipment_date_to_idx ON special_equipment_request_details (date_to);

-- 4. Детали грузоперевозки (дата-время + объём/масса + места).
CREATE TABLE freight_transport_request_details (
  request_id uuid PRIMARY KEY REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  volume_m3 numeric(12, 3),
  weight_tons numeric(12, 3),
  loading_location text NOT NULL,
  unloading_location text NOT NULL,
  CONSTRAINT freight_volume_positive_check CHECK (volume_m3 IS NULL OR volume_m3 > 0),
  CONSTRAINT freight_weight_positive_check CHECK (weight_tons IS NULL OR weight_tons > 0),
  CONSTRAINT freight_volume_or_weight_check CHECK (volume_m3 IS NOT NULL OR weight_tons IS NOT NULL),
  CONSTRAINT freight_loading_not_blank_check CHECK (btrim(loading_location) <> ''),
  CONSTRAINT freight_unloading_not_blank_check CHECK (btrim(unloading_location) <> '')
);
CREATE INDEX freight_scheduled_at_idx ON freight_transport_request_details (scheduled_at);

-- 5. Связь заявка ТС ↔ файлы. UNIQUE(file_id) — файл не в двух заявках ТС;
--    кросс-модульную уникальность с «Мусором» обеспечивает файловый сервис.
CREATE TABLE vehicle_request_files (
  vehicle_request_id uuid NOT NULL REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_request_id, file_id)
);
CREATE UNIQUE INDEX vehicle_request_files_file_unique ON vehicle_request_files (file_id);

-- 6. История статусов заявки ТС.
CREATE TABLE vehicle_request_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_request_id uuid NOT NULL REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  from_status request_status,
  to_status request_status NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  comment text NOT NULL DEFAULT ''
);
CREATE INDEX vehicle_request_status_history_request_idx ON vehicle_request_status_history (vehicle_request_id);
