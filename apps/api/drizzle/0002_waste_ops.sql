-- Этап 2: операции с контейнерами и вывоз мусора.
-- Меняем смысл request_type (Установка/Замена/Вывоз), добавляем справочник машин
-- и экземпляры контейнеров на объектах. Заявки этапа 1 несовместимы — сбрасываем.

-- 1. Сброс заявок (dev): старые значения request_type (onetime/weekly) нельзя
--    отобразить на новые. CASCADE очищает request_files и request_status_history.
TRUNCATE waste_requests CASCADE;

-- 2. Пересоздание enum request_type.
ALTER TYPE request_type RENAME TO request_type_old;
CREATE TYPE request_type AS ENUM ('container_install', 'container_replace', 'waste_removal');
ALTER TABLE waste_requests
  ALTER COLUMN request_type TYPE request_type USING (request_type::text::request_type);
DROP TYPE request_type_old;

-- 3. Справочник типов машин (самосвалы) + перенос из container_types.
CREATE TABLE machine_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX machine_types_code_unique ON machine_types (code);

INSERT INTO machine_types (code, name, sort_order) VALUES
  ('dump_truck_25', 'Самосвал 25 м³', 10),
  ('dump_truck_36', 'Самосвал 36 м³', 20)
ON CONFLICT (code) DO NOTHING;

-- Самосвалы больше не относятся к типам контейнеров.
DELETE FROM container_types WHERE code IN ('dump_truck_25', 'dump_truck_36');

-- 4. Экземпляры контейнеров на объекте.
CREATE TABLE containers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE CASCADE,
  container_type_id uuid NOT NULL REFERENCES container_types (id) ON DELETE RESTRICT,
  label text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX containers_object_idx ON containers (object_id);

-- 5. Полиморфные поля заявки: container_type_id становится необязательным,
--    добавляются ссылки на контейнер/машину и объём.
ALTER TABLE waste_requests
  ALTER COLUMN container_type_id DROP NOT NULL,
  ADD COLUMN container_id uuid REFERENCES containers (id) ON DELETE SET NULL,
  ADD COLUMN machine_type_id uuid REFERENCES machine_types (id) ON DELETE RESTRICT,
  ADD COLUMN volume_m3 integer;
