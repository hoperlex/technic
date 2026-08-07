-- Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам, под какими номерами и с
-- какой гарантией. Две таблицы: перечень типов и сами единицы.
--
-- Единица опознаётся номерами, а не наименованием: одинаковых МФУ в компании десятки, и различают
-- их инвентарный номер бухгалтерии и серийный номер производителя.

CREATE TABLE office_equipment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_equipment_types_name_not_blank_check CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX office_equipment_types_code_unique ON office_equipment_types (code);

-- Начальный перечень: типы заводятся сидом, потому что без них не завести ни одной единицы, а
-- набор их известен заранее и одинаков в любой компании. Дальше справочник ведут руками.
INSERT INTO office_equipment_types (code, name, sort_order) VALUES
  ('mfp', 'МФУ', 10),
  ('printer', 'Принтер', 20),
  ('scanner', 'Сканер', 30),
  ('laptop', 'Ноутбук', 40),
  ('desktop', 'Системный блок', 50),
  ('monitor', 'Монитор', 60),
  ('ups', 'ИБП', 70),
  ('network', 'Сетевое оборудование', 80),
  ('phone', 'Телефония', 90),
  ('other', 'Прочее', 900);

CREATE TABLE office_equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_type_id uuid NOT NULL REFERENCES office_equipment_types (id) ON DELETE RESTRICT,
  -- Наименование модели: «Kyocera ECOSYS M3145». Опознают единицу номерами, но выбирают её глазами
  -- по модели, поэтому поле обязательное.
  name text NOT NULL,
  serial_number text NOT NULL DEFAULT '',
  inventory_number text NOT NULL DEFAULT '',
  -- Где стоит. Офис заводится таким же объектом строительства — площадка у техники есть всегда.
  object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  -- За каким отделом числится. NULL — не закреплена; на область заявок это не влияет (у заявки свой
  -- заказчик), но от разметки зависит, увидит ли отдел «заявки по нашей технике».
  owner_department_id uuid REFERENCES departments (id) ON DELETE RESTRICT,
  -- Уточнение места внутри объекта: «кабинет 214», «прорабская». Свободный текст: планировок в
  -- портале нет, а искать технику будут именно по такой подписи.
  location text NOT NULL DEFAULT '',
  purchased_on date,
  -- Гарантия поставщика на саму единицу. Гарантии на запчасти и работы живут в заявках.
  warranty_until date,
  comment text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_equipment_name_not_blank_check CHECK (btrim(name) <> ''),
  -- Единицу нужно чем-то опознать при приёмке из ремонта: хотя бы один номер обязателен.
  CONSTRAINT office_equipment_identity_check
    CHECK (btrim(serial_number) <> '' OR btrim(inventory_number) <> '')
);

-- Номера уникальны среди живых записей: удалённая карточка номер не держит, иначе перезаведение
-- ошибочно списанной единицы упиралось бы в её же архивную строку.
CREATE UNIQUE INDEX office_equipment_serial_unique
  ON office_equipment (upper(btrim(serial_number)))
  WHERE deleted_at IS NULL AND btrim(serial_number) <> '';
CREATE UNIQUE INDEX office_equipment_inventory_unique
  ON office_equipment (upper(btrim(inventory_number)))
  WHERE deleted_at IS NULL AND btrim(inventory_number) <> '';

CREATE INDEX office_equipment_object_idx ON office_equipment (object_id) WHERE deleted_at IS NULL;
CREATE INDEX office_equipment_department_idx ON office_equipment (owner_department_id)
  WHERE deleted_at IS NULL AND owner_department_id IS NOT NULL;
CREATE INDEX office_equipment_type_idx ON office_equipment (equipment_type_id);
-- Поиск по модели — тем же способом, что в остальных справочниках.
CREATE INDEX office_equipment_name_trgm ON office_equipment USING gin (name gin_trgm_ops);
-- «Что ещё на гарантии» — вопрос подсветки списка и будущего реестра гарантий.
CREATE INDEX office_equipment_warranty_idx ON office_equipment (warranty_until)
  WHERE deleted_at IS NULL AND warranty_until IS NOT NULL;
