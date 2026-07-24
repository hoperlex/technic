-- Этап 1 классификатора ТС: справочник видов (vehicle_kinds) и иерархический
-- справочник типов/подтипов (vehicle_types). Виды — таблицей (не enum), чтобы
-- добавлять новые без изменения типа БД. См. docs/adr/0001-vehicle-classification.md.

-- 1. Виды ТС (верхний уровень).
CREATE TABLE vehicle_kinds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_kinds_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT vehicle_kinds_name_not_blank CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX vehicle_kinds_code_unique ON vehicle_kinds (code);

INSERT INTO vehicle_kinds (code, name, sort_order) VALUES
  ('special_equipment', 'Спецтехника',    10),
  ('freight_transport', 'Грузоперевозки', 20)
ON CONFLICT (code) DO NOTHING;

-- 2. Типы и подтипы ТС в ОДНОЙ иерархической таблице (parent_id).
--    Составной FK (parent_id, kind_id) → (id, kind_id) гарантирует, что родитель
--    и дочерний тип относятся к одному виду (kind_id денормализован ради этого FK
--    и фильтрации без рекурсии). Глубина (строго 2 уровня) и is_selectable —
--    на уровне приложения. Поле level не храним: вычисляется по parent_id.
CREATE TABLE vehicle_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind_id uuid NOT NULL REFERENCES vehicle_kinds (id) ON DELETE RESTRICT,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_selectable boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_types_id_kind_unique UNIQUE (id, kind_id),
  CONSTRAINT vehicle_types_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT vehicle_types_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT vehicle_types_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT vehicle_types_parent_same_kind
    FOREIGN KEY (parent_id, kind_id) REFERENCES vehicle_types (id, kind_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX vehicle_types_code_unique ON vehicle_types (code);
CREATE INDEX vehicle_types_kind_active_sort_idx ON vehicle_types (kind_id, is_active, sort_order);
CREATE INDEX vehicle_types_parent_idx ON vehicle_types (parent_id);
