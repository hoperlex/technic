-- Принадлежность техники: собственная и аренда в одном справочнике (ADR 0018).
-- Аддитивно: существующие 176 машин становятся собственными (DEFAULT 'own').

CREATE TYPE vehicle_ownership AS ENUM ('own', 'rental');

-- 1. Колонки обеих веток. Собственную описывают реквизиты машины (марка/модель, госномер, ПТС —
--    уже есть), аренду — арендодатель, цены и короткий срез-идентификатор.
ALTER TABLE vehicles
  ADD COLUMN ownership vehicle_ownership NOT NULL DEFAULT 'own',
  -- Категория (ADR 0016). У аренды — основной классификатор, у своей машины заполняется по мере
  -- разнесения парка. Тип при этом остаётся обязательным у обеих веток.
  ADD COLUMN vehicle_category_id uuid,
  ADD COLUMN lessor_id uuid,
  -- Служебная: приложение всегда пишет 'vehicle_lessor'. Существует ради составного FK ниже —
  -- он и делает инвариант «арендодатель именно арендодатель» физическим.
  ADD COLUMN lessor_type counterparty_type,
  -- Короткий срез вида «Автокран 70 тн»: то, чем человек различает два предложения одного
  -- арендодателя, пока категории не заведены. Входит в ключ уникальности предложения.
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN price_per_hour numeric(12, 2),
  ADD COLUMN price_per_shift numeric(12, 2),
  -- Без длительности смены две цены за смену несравнимы.
  ADD COLUMN shift_hours smallint;

-- 2. Ветки различают CHECK'и, а не detail-таблицы (ADR 0018 §2): на ветку приходится по три поля.
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_own_fields_check CHECK (
    ownership <> 'own' OR (
      lessor_id IS NULL AND lessor_type IS NULL
      AND price_per_hour IS NULL AND price_per_shift IS NULL AND shift_hours IS NULL
      AND description = ''
    )
  ),
  ADD CONSTRAINT vehicles_rental_fields_check CHECK (
    ownership <> 'rental' OR (
      lessor_id IS NOT NULL
      AND (price_per_hour IS NOT NULL OR price_per_shift IS NOT NULL)
      AND vehicle_model_id IS NULL
      AND registration_number IS NULL
      AND passport_number IS NULL
    )
  ),
  -- «Обслуживание» и «Списана» — состояния конкретной машины; у предложения аренды их нет.
  ADD CONSTRAINT vehicles_rental_status_check CHECK (
    ownership <> 'rental' OR status IN ('active', 'inactive')
  ),
  ADD CONSTRAINT vehicles_prices_positive_check CHECK (
    (price_per_hour IS NULL OR price_per_hour > 0)
    AND (price_per_shift IS NULL OR price_per_shift > 0)
  ),
  ADD CONSTRAINT vehicles_shift_hours_range_check CHECK (
    shift_hours IS NULL OR shift_hours BETWEEN 1 AND 24
  ),
  ADD CONSTRAINT vehicles_lessor_type_check CHECK (
    lessor_type IS NULL OR lessor_type = 'vehicle_lessor'
  ),
  -- Арендодатель и его тип заполняются только вместе — иначе составной FK не проверился бы
  -- (MATCH SIMPLE пропускает строку, где хоть одна колонка ключа NULL).
  ADD CONSTRAINT vehicles_lessor_pair_check CHECK (
    (lessor_id IS NULL) = (lessor_type IS NULL)
  );

-- 3. Категория не может разойтись с типом — приём vehicles_model_type_fk (ADR 0007 §4).
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_category_type_fk
  FOREIGN KEY (vehicle_category_id, vehicle_type_id)
  REFERENCES vehicle_categories (id, vehicle_type_id) ON DELETE RESTRICT;

-- 4. Арендодатель — контрагент роли vehicle_lessor, физически.
--    Guard перед объявлением UNIQUE: учёток на арендодателях быть не должно (ADR 0018 §9).
--    Через API это невозможно (resolveCounterpartyId), но смена типа контрагента такой путь
--    оставляла — с этой миграцией её закрывает guard в маршруте контрагентов.
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM users u
  JOIN counterparties c ON c.id = u.counterparty_id
  WHERE c.type = 'vehicle_lessor' AND u.deleted_at IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Учётки (% шт.) привязаны к контрагентам-арендодателям: у арендодателя не может быть учёток. Разберите вручную перед применением 0036.', bad;
  END IF;
END $$;

ALTER TABLE counterparties ADD CONSTRAINT counterparties_id_type_unique UNIQUE (id, type);

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_lessor_fk
  FOREIGN KEY (lessor_id, lessor_type)
  REFERENCES counterparties (id, type) ON DELETE RESTRICT;

-- 5. Одно предложение = (арендодатель, тип, категория, описание).
--    NULLS NOT DISTINCT (PG 15+) обязателен: без него два предложения одного арендодателя на один
--    тип без категории оба прошли бы, потому что NULL <> NULL.
CREATE UNIQUE INDEX vehicles_rental_offer_unique
  ON vehicles (lessor_id, vehicle_type_id, vehicle_category_id, description) NULLS NOT DISTINCT
  WHERE ownership = 'rental' AND deleted_at IS NULL;

CREATE INDEX vehicles_lessor_idx ON vehicles (lessor_id) WHERE ownership = 'rental';
CREATE INDEX vehicles_category_idx ON vehicles (vehicle_category_id)
  WHERE vehicle_category_id IS NOT NULL;
CREATE INDEX vehicles_ownership_type_idx ON vehicles (ownership, vehicle_type_id);
