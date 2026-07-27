-- Конкретные транспортные средства (ADR 0007). Цепочка: vehicle_kinds → vehicle_types →
-- vehicle_models → vehicles. Импорта/парсинга исходных строк нет: записи заводятся выверенным
-- seed'ом и справочником, неоднозначные строки источника не сидируются вовсе.

-- 1. Состояние экземпляра. maintenance/retired назначаются вручную; active/inactive — из источника.
CREATE TYPE vehicle_status AS ENUM ('active', 'inactive', 'maintenance', 'retired');

-- 2. Таблица техники.
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Тип хранится явно: он известен всегда (прямая колонка источника), а марка/модель — не всегда
  -- (напр. «Манипулятор на шасси JAC c КМУ Fassi» — марки в источнике нет).
  vehicle_type_id uuid NOT NULL REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  vehicle_model_id uuid,
  registration_number text,
  registration_number_normalized text GENERATED ALWAYS AS (vehicle_reg_normalize(registration_number)) STORED,
  inventory_number text,
  serial_number text,
  passport_number text,
  manufacturer_name text NOT NULL DEFAULT '',
  manufactured_on date,
  status vehicle_status NOT NULL DEFAULT 'active',
  source_name text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Ключевой инвариант: если марка/модель указана, её тип обязан совпадать с типом машины.
  -- MATCH SIMPLE (по умолчанию): при vehicle_model_id IS NULL проверка не выполняется, поэтому
  -- машина без известной модели допустима, а рассогласование «ТС одного типа, модель другого» —
  -- физически невозможно.
  CONSTRAINT vehicles_model_type_fk FOREIGN KEY (vehicle_model_id, vehicle_type_id)
    REFERENCES vehicle_models (id, vehicle_type_id) ON DELETE RESTRICT,
  -- Пустая строка вместо NULL — источник ошибок в поиске и уникальности.
  CONSTRAINT vehicles_registration_number_not_blank_check
    CHECK (registration_number IS NULL OR btrim(registration_number) <> ''),
  CONSTRAINT vehicles_inventory_number_not_blank_check
    CHECK (inventory_number IS NULL OR btrim(inventory_number) <> ''),
  CONSTRAINT vehicles_serial_number_not_blank_check
    CHECK (serial_number IS NULL OR btrim(serial_number) <> ''),
  CONSTRAINT vehicles_passport_number_not_blank_check
    CHECK (passport_number IS NULL OR btrim(passport_number) <> '')
);

-- Госномер уникален среди живых записей. Включаем сразу: таблица пустая, а seed выверен —
-- падение уникальности при сидировании и есть сигнал «строку разобрали неверно».
CREATE UNIQUE INDEX vehicles_registration_number_unique ON vehicles (registration_number_normalized)
  WHERE registration_number_normalized IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX vehicles_type_status_idx ON vehicles (vehicle_type_id, status);
CREATE INDEX vehicles_model_idx ON vehicles (vehicle_model_id);
-- Инвентарный (1С) и заводской номера — только поиск, без уникальности: в выгрузке встречаются
-- кириллические гомоглифы внутри VIN («Х89994273J0BA2330») и незаполненные значения.
CREATE INDEX vehicles_inventory_number_idx ON vehicles (inventory_number);
CREATE INDEX vehicles_serial_number_idx ON vehicles (serial_number);
CREATE INDEX vehicles_deleted_at_idx ON vehicles (deleted_at);
