-- Чистка справочника марок/моделей перед наполнением ТТХ и категорий (ADR 0023).
--
-- Сид 0028 выводил наименования моделей эвристически из бухвыгрузки и сам предупреждал, что они
-- требуют ручной выверки. Выверка состоялась: одна и та же машина попала в справочник под
-- несколькими написаниями, а две модели оказались не в своём типе. До разнесения парка по
-- категориям это нужно свести, иначе одна физическая модель получит несколько категорий, а часть
-- машин — категорию чужого типа.
--
-- Идемпотентно: все правки ищут исходное состояние и на повторном прогоне не находят ничего.

-- ── 1. Слияние дублей одной модели ──────────────────────────────────────────────────────────
-- vehicle_model_normalize (0015) намеренно НЕ транслитерирует: это знание, а не функция от
-- строки. Поэтому «КС-45717А-1Р» кириллицей, «KC-45717A-1P» латиницей и смешанное «KС-45717A-1Р»
-- лежат тремя записями, хотя это один кран (все четыре машины — Y3M6312B3D…, 2013 г.).
-- Свести их можно только здесь, разово и осознанно: складываем гомоглифы по тому же алфавиту,
-- что и vehicle_reg_normalize для госномеров, — у каждой буквы АВЕКМНОРСТУХ есть однозначный
-- латинский двойник.
--
-- Канонической считаем запись, набранную кириллицей (как у завода-изготовителя): у неё в
-- нормализованном имени нет ни одной латинской буквы.
CREATE TEMP TABLE crane_model_merge ON COMMIT DROP AS
WITH folded AS (
  SELECT m.id,
         m.normalized_name,
         translate(m.normalized_name, 'авекмнорстух', 'abekmhopctyx') AS folded_name
  FROM vehicle_models m
  JOIN vehicle_types t ON t.id = m.vehicle_type_id
  WHERE t.code = 'truck_cranes'
)
SELECT
  (SELECT id FROM folded WHERE folded_name = 'kc 45717a 1p' AND normalized_name !~ '[a-z]') AS canonical_id,
  f.id AS duplicate_id
FROM folded f
WHERE f.folded_name = 'kc 45717a 1p' AND f.normalized_name ~ '[a-z]';

-- Дубли остальных двух пар различаются только пробелом и повтором «LG» — их видно без складывания.
CREATE TEMP TABLE model_merge ON COMMIT DROP AS
SELECT canonical_id, duplicate_id FROM crane_model_merge WHERE canonical_id IS NOT NULL
UNION ALL
SELECT
  (SELECT m.id FROM vehicle_models m JOIN vehicle_types t ON t.id = m.vehicle_type_id
    WHERE t.code = 'front_loaders' AND m.normalized_name = 'sdlg lg936l'),
  m.id
FROM vehicle_models m
JOIN vehicle_types t ON t.id = m.vehicle_type_id
WHERE t.code = 'front_loaders' AND m.normalized_name = 'sdlg lg lg936l'
UNION ALL
SELECT
  (SELECT m.id FROM vehicle_models m JOIN vehicle_types t ON t.id = m.vehicle_type_id
    WHERE t.code = 'forklift_miniloaders' AND m.normalized_name = 'mustang 2700v'),
  m.id
FROM vehicle_models m
JOIN vehicle_types t ON t.id = m.vehicle_type_id
WHERE t.code = 'forklift_miniloaders' AND m.normalized_name = 'mustang 2700 v';

-- Пропавшая каноническая запись — не «нечего делать», а рассогласование: молча удалить дубль
-- вместе с его машинами нельзя.
DO $$
DECLARE
  orphaned int;
BEGIN
  SELECT count(*) INTO orphaned FROM model_merge WHERE canonical_id IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'Дубли моделей (% шт.) без канонической записи: справочник правили вручную. Разберите перед применением 0043.', orphaned;
  END IF;
END $$;

UPDATE vehicles v
SET vehicle_model_id = mm.canonical_id, updated_at = now()
FROM model_merge mm
WHERE v.vehicle_model_id = mm.duplicate_id;

DELETE FROM vehicle_models m USING model_merge mm WHERE m.id = mm.duplicate_id;

-- ── 2. Перенос моделей в свой тип ───────────────────────────────────────────────────────────
-- Mustang 2076 — мини-погрузчик с бортовым поворотом (номинальная г/п 998 кг), а лежал во
-- «Фронтальных погрузчиках», тогда как остальные четырнадцать Mustang'ов — в минипогрузчиках.
-- Амкодор-332С-01/332С4-01 — наоборот: универсальный погрузчик г/п 3,4 т при эксплуатационной
-- массе 10,9 т и ковше 1,9 м³, то есть полноразмерная фронтальная машина, а не мини.
CREATE TEMP TABLE model_type_moves (model_id uuid PRIMARY KEY, target_type_id uuid NOT NULL)
  ON COMMIT DROP;

INSERT INTO model_type_moves (model_id, target_type_id)
SELECT m.id, (SELECT id FROM vehicle_types WHERE code = 'forklift_miniloaders')
FROM vehicle_models m
JOIN vehicle_types t ON t.id = m.vehicle_type_id
WHERE t.code = 'front_loaders' AND m.normalized_name = 'mustang2076';

INSERT INTO model_type_moves (model_id, target_type_id)
SELECT m.id, (SELECT id FROM vehicle_types WHERE code = 'front_loaders')
FROM vehicle_models m
JOIN vehicle_types t ON t.id = m.vehicle_type_id
WHERE t.code = 'forklift_miniloaders' AND m.normalized_name LIKE 'амкодор%';

-- Тип модели нельзя сменить «на месте»: vehicles_model_type_fk (ADR 0007 §4) ссылается на пару
-- (модель, её тип) и проверяется в конце каждого оператора, поэтому и «сначала модель», и
-- «сначала машины» упираются в него. Отцепляем машины от модели (при NULL составной FK
-- не проверяется — MATCH SIMPLE), переносим модель, возвращаем машины уже с новым типом.
CREATE TEMP TABLE moved_vehicles ON COMMIT DROP AS
SELECT v.id AS vehicle_id, mv.model_id, mv.target_type_id
FROM vehicles v
JOIN model_type_moves mv ON mv.model_id = v.vehicle_model_id;

UPDATE vehicles SET vehicle_model_id = NULL WHERE id IN (SELECT vehicle_id FROM moved_vehicles);

UPDATE vehicle_models m
SET vehicle_type_id = mv.target_type_id, updated_at = now()
FROM model_type_moves mv
WHERE m.id = mv.model_id;

UPDATE vehicles v
SET vehicle_model_id = mv.model_id, vehicle_type_id = mv.target_type_id, updated_at = now()
FROM moved_vehicles mv
WHERE v.id = mv.vehicle_id;

-- Заодно приводим написание к принятому в справочнике («Mustang 2700V», «Mustang 3300V»).
UPDATE vehicle_models m
SET name = 'Mustang 2076', updated_at = now()
FROM vehicle_types t
WHERE t.id = m.vehicle_type_id
  AND t.code = 'forklift_miniloaders'
  AND m.normalized_name = 'mustang2076';

-- ── 3. Проверка результата ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  cranes int;
  crane_vehicles int;
  loaders int;
BEGIN
  SELECT count(*), coalesce(sum(cnt), 0) INTO cranes, crane_vehicles
  FROM (
    SELECT (SELECT count(*) FROM vehicles v WHERE v.vehicle_model_id = m.id) AS cnt
    FROM vehicle_models m
    JOIN vehicle_types t ON t.id = m.vehicle_type_id
    WHERE t.code = 'truck_cranes'
      AND translate(m.normalized_name, 'авекмнорстух', 'abekmhopctyx') = 'kc 45717a 1p'
  ) s;
  IF cranes <> 1 THEN
    RAISE EXCEPTION 'После слияния КС-45717А-1Р осталось записей: % (ожидалась 1)', cranes;
  END IF;

  SELECT count(*) INTO loaders
  FROM vehicle_models m
  JOIN vehicle_types t ON t.id = m.vehicle_type_id
  WHERE (t.code = 'front_loaders' AND m.normalized_name IN ('sdlg lg lg936l', 'mustang2076', 'mustang 2076'))
     OR (t.code = 'forklift_miniloaders' AND (m.normalized_name = 'mustang 2700 v' OR m.normalized_name LIKE 'амкодор%'));
  IF loaders > 0 THEN
    RAISE EXCEPTION 'Погрузчики: осталось % записей в прежнем типе или под прежним именем', loaders;
  END IF;

  RAISE NOTICE 'Чистка моделей: КС-45717А-1Р — 1 запись, % машин', crane_vehicles;
END $$;
