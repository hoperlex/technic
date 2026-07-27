-- Тарификация вывоза мусора (ADR 0009): справочник типов мусора, прайс и снимок цены в заявке.
--
-- Цена в прайсе всегда приводится к 1 м³. Позиция «разовая услуга контейнером 8 м³ — 15 000 ₽»
-- хранится как 1875 ₽/м³ + признак is_per_container: объём такой заявки обязан быть кратен
-- вместимости контейнера (8, 16, 24…), иначе счёт разойдётся с прайсом.
-- Цены — с НДС, как в прайсе; ставка налога отдельно не хранится.

-- 1. Вместимость типа контейнера/машины: нужна и для расчёта, и для проверки кратности.
--    Nullable — у будущих записей справочника вместимость может быть не задана; тариф «за
--    контейнер» на такой тип завести нельзя (проверяет сервис).
ALTER TABLE container_types ADD COLUMN volume_m3 integer;
ALTER TABLE container_types
  ADD CONSTRAINT container_types_volume_positive_check CHECK (volume_m3 IS NULL OR volume_m3 > 0);

UPDATE container_types SET volume_m3 = 8  WHERE code = 'container_8';
UPDATE container_types SET volume_m3 = 20 WHERE code = 'container_20';
UPDATE container_types SET volume_m3 = 27 WHERE code = 'container_27';
UPDATE container_types SET volume_m3 = 25 WHERE code = 'container_25_heavy';
UPDATE container_types SET volume_m3 = 25 WHERE code = 'dump_truck_25';
UPDATE container_types SET volume_m3 = 36 WHERE code = 'dump_truck_36';

-- 2. Справочник типов мусора. Отвечает на «что вывозим»; «чем вывозим» — container_types.
CREATE TABLE waste_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_types_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT waste_types_name_not_blank_check CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX waste_types_code_unique ON waste_types (code);

INSERT INTO waste_types (code, name, sort_order) VALUES
  ('construction_waste',  'Строительные отходы', 10),
  ('construction_debris', 'Строительный мусор',  20),
  ('concrete_scrap',      'Бетонный бой',        30),
  ('clean_soil',          'Чистый грунт',        40),
  ('contaminated_soil',   'Замусоренный грунт',  50),
  ('ossig',               'ОССиГ',               60),
  ('wood_waste',          'Древесные отходы',    70);

-- 3. Прайс. Тариф задаётся либо для конкретного типа контейнера/машины (container_type_id),
--    либо для вида техники целиком (container_kind = cont | truck) — ровно одно из двух.
--    При расчёте точное совпадение по типу побеждает тариф вида: так выражается прайсовое
--    «строительный мусор контейнерами — 1500 ₽/м³, кроме контейнера 8 м³ — 15 000 ₽ за контейнер».
CREATE TABLE waste_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waste_type_id uuid NOT NULL REFERENCES waste_types (id) ON DELETE RESTRICT,
  container_type_id uuid REFERENCES container_types (id) ON DELETE RESTRICT,
  container_kind container_kind,
  price_per_m3 numeric(12, 2) NOT NULL,
  -- Исходная цена из прайса, если она объявлена за контейнер (15 000 ₽). Хранится справочно:
  -- расчёт всегда идёт через price_per_m3.
  price_per_container numeric(12, 2),
  is_per_container boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_tariffs_target_check CHECK (
    (container_type_id IS NOT NULL AND container_kind IS NULL)
    OR (container_type_id IS NULL AND container_kind IS NOT NULL)
  ),
  CONSTRAINT waste_tariffs_price_positive_check CHECK (price_per_m3 > 0),
  -- Цена «за контейнер» осмысленна только для конкретного типа: вместимость берётся из него.
  CONSTRAINT waste_tariffs_per_container_check CHECK (
    NOT is_per_container OR (container_type_id IS NOT NULL AND price_per_container IS NOT NULL)
  )
);
CREATE UNIQUE INDEX waste_tariffs_type_container_unique
  ON waste_tariffs (waste_type_id, container_type_id) WHERE container_type_id IS NOT NULL;
CREATE UNIQUE INDEX waste_tariffs_type_kind_unique
  ON waste_tariffs (waste_type_id, container_kind) WHERE container_kind IS NOT NULL;
CREATE INDEX waste_tariffs_waste_type_idx ON waste_tariffs (waste_type_id);

-- Прайс (нумерация — пункты исходного документа).
-- Пп. 1 и 7 техника не названа («перевозка»), поэтому заводятся на оба вида с одной ценой.
INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'cont', 900, 'п.1 Перевозка строительных отходов' FROM waste_types WHERE code = 'construction_waste';
INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'truck', 900, 'п.1 Перевозка строительных отходов' FROM waste_types WHERE code = 'construction_waste';

INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'cont', 1500, 'п.2 Разовая услуга по вывозу строительного мусора (кроме контейнера 8 м³)'
FROM waste_types WHERE code = 'construction_debris';

-- п.3: 15 000 ₽ за контейнер 8 м³ → 1875 ₽/м³, объём заявки кратен 8.
INSERT INTO waste_tariffs (waste_type_id, container_type_id, price_per_m3, price_per_container, is_per_container, note)
SELECT wt.id, ct.id, 1875, 15000, true, 'п.3 Разовая услуга по вывозу строительного мусора контейнером 8 м³'
FROM waste_types wt, container_types ct
WHERE wt.code = 'construction_debris' AND ct.code = 'container_8';

INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'truck', 850, 'п.4 Вывоз самосвалами бетонного боя' FROM waste_types WHERE code = 'concrete_scrap';
INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'truck', 950, 'п.5 Вывоз самосвалами чистого грунта' FROM waste_types WHERE code = 'clean_soil';
INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'truck', 1300, 'п.6 Вывоз самосвалами замусоренного грунта' FROM waste_types WHERE code = 'contaminated_soil';

INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'cont', 700, 'п.7 Перевозка ОССиГ' FROM waste_types WHERE code = 'ossig';
INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'truck', 700, 'п.7 Перевозка ОССиГ' FROM waste_types WHERE code = 'ossig';

INSERT INTO waste_tariffs (waste_type_id, container_kind, price_per_m3, note)
SELECT id, 'cont', 1100, 'п.8 Вывоз древесных отходов контейнерами' FROM waste_types WHERE code = 'wood_waste';

-- 4. Заявка: что вывозим и по какой цене. Все поля nullable — заявки, созданные до тарификации,
--    остаются без цены; обязательность для новых заявок держит сервис (зависит от типа операции).
ALTER TABLE waste_requests
  ADD COLUMN waste_type_id uuid REFERENCES waste_types (id) ON DELETE RESTRICT,
  ADD COLUMN waste_tariff_id uuid REFERENCES waste_tariffs (id) ON DELETE RESTRICT,
  ADD COLUMN price_per_m3 numeric(12, 2),
  -- Сумма — производная от объёма и цены, поэтому вычисляется БД: разойтись с множителями
  -- она не может, а пересчитывать её в приложении негде забыть.
  ADD COLUMN amount numeric(14, 2) GENERATED ALWAYS AS (round(volume_m3 * price_per_m3, 2)) STORED;

-- Установка нового контейнера не тарифицируется: вывоза мусора в этой операции нет.
ALTER TABLE waste_requests ADD CONSTRAINT waste_requests_install_no_pricing_check CHECK (
  request_type <> 'container_install'
  OR (waste_type_id IS NULL AND waste_tariff_id IS NULL AND price_per_m3 IS NULL)
);
-- Снимок цены неразрывен: тариф без цены (и наоборот) означал бы потерянный расчёт.
ALTER TABLE waste_requests ADD CONSTRAINT waste_requests_price_snapshot_check
  CHECK ((waste_tariff_id IS NULL) = (price_per_m3 IS NULL));
ALTER TABLE waste_requests ADD CONSTRAINT waste_requests_price_positive_check
  CHECK (price_per_m3 IS NULL OR price_per_m3 > 0);

CREATE INDEX waste_requests_waste_type_idx ON waste_requests (waste_type_id);
