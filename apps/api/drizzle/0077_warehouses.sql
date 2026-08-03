-- Справочник складов поставщиков (ADR 0051).
--
-- Склад — это адрес, по которому у поставщика забирают или куда ему привозят. Складов у одного
-- поставщика много, поэтому колонкой в `counterparties` связь не выражается, а промежуточная
-- таблица не нужна: склад принадлежит ровно одному поставщику.
--
-- Требование «тип контрагента = supplier» держит сервис, а не составной FK, — то же решение, что
-- у `waste_requests.operator_counterparty_id` и `construction_object_operators` (ADR 0010 §6, §10).
-- Физический вариант (как `vehicles_lessor_fk`) потребовал бы вернуть UNIQUE (id, type), снятый
-- миграцией 0038, и денормализовать тип в каждую строку склада — ради инварианта, который здесь
-- проверяется в одном месте: склад заводится и правится только своим маршрутом.
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Имя колонки называет роль контрагента — приём `operator_counterparty_id`: по строке видно,
  -- чем контрагент приходится складу, а не только то, что он контрагент.
  supplier_counterparty_id uuid NOT NULL REFERENCES counterparties (id) ON DELETE RESTRICT,
  address text NOT NULL,
  -- Нормализованная форма — та же функция, что у наименований контрагента: правила совпадают
  -- (регистр, ё→е, кавычки и разделители схлопываются), и «ул. Ленина, д. 1» с «ул Ленина д.1»
  -- дают одно значение. Своя функция не заводится — вторая с той же логикой разошлась бы с
  -- первой при первой же правке.
  normalized_address text GENERATED ALWAYS AS (counterparty_name_normalize(address)) STORED,
  -- Метка склада («Основной», «Склад №2»): пустая строка — «не задана». Узнают склад по адресу,
  -- поэтому метка необязательна и в таблице справочника столбцом не показывается.
  name text NOT NULL DEFAULT '',
  -- Контакт склада: кто принимает машину и по какому номеру. Пустая строка — «не указан»:
  -- контакт знают не всегда, и требовать его за возможность записать адрес не за что (то же
  -- правило, что у телефона учётки, ADR 0043). Формат телефона свободный — достаточность цифр
  -- держат контракты (`optionalPhoneSchema`), как у `responsible_phone` заявок (миграция 0062).
  contact_person text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouses_address_not_blank_check
    CHECK (counterparty_name_normalize(address) <> '')
);

-- Идентичность склада — пара «поставщик + адрес»: второй записи по тому же адресу у одного
-- поставщика быть не может. Индекс покрывает и проход «склады этого поставщика» — отдельный
-- индекс по supplier_counterparty_id был бы его префиксом.
CREATE UNIQUE INDEX warehouses_supplier_address_unique
  ON warehouses (supplier_counterparty_id, normalized_address);

-- Поиск по адресу — тем же способом, что в остальных справочниках.
CREATE INDEX warehouses_address_trgm ON warehouses USING gin (address gin_trgm_ops);
