-- Разнесение собственного парка по категориям (отложенный пункт ADR 0018, наполнение — ADR 0023).
--
-- Категория проставляется ПО МОДЕЛИ: ТТХ — свойство марки/модели, а не конкретного экземпляра,
-- поэтому правило «модель → категория» покрывает и машины, заведённые сверх сида 0028. Значения
-- взяты из открытых данных заводов-изготовителей; расхождение источников разрешалось в пользу
-- каталога изготовителя.
--
-- Модели сопоставляются по нормализованному имени. Автокраны — по числовому индексу серии
-- (45717, 55713, …): в справочнике одна и та же серия встречается и кириллицей, и латиницей,
-- и совпадающие цифры — единственный устойчивый признак. Заодно это снимает вопрос «А» против
-- «К» в индексе шасси: обе машины серии 45717 — 25-тонные.
--
-- Без категории намеренно остаются:
--   • самосвалы — объём кузова по модели не определяется (МАЗ-6501А5 идёт с платформой 12,5 или
--     15,4 м³, КамАЗ-65201 — 16 или 20 м³), нужен паспорт самосвальной установки;
--   • тяжелые манипуляторы — г/п стрелы КМУ по индексу надстройки (780745, 28188-0000010-76)
--     не находится;
--   • SENNEBOGEN 630M и MAEDA — у второй в справочнике вместо модели записано название фирмы;
--   • катки RAMMAX RW5005 и ДУ-94, погрузчик BULL SL912, HINO 300, «КАМАЗ-5325 780904»,
--     ГАЗ-278422 — данных по исполнению нет;
--   • легковые автомобили — у типа нет ТТХ, категорий не бывает вовсе.
-- Все они дозаполняются через справочник, когда данные появятся.
--
-- Идемпотентно: правится только `vehicle_category_id IS NULL`, поэтому повторный прогон ничего
-- не перепишет, а ручные правки человека останутся нетронутыми.

CREATE TEMP TABLE seed_model_categories (
  type_code          text NOT NULL,
  name_pattern       text NOT NULL,
  category_signature text NOT NULL,
  note               text NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_model_categories VALUES
  -- Автокраны: серия → грузоподъёмность.
  ('truck_cranes',         '%45719%',      'lift_capacity=20',     'КС-45719-5А, Клинцы, шасси МАЗ-5337А2'),
  ('truck_cranes',         '%45717%',      'lift_capacity=25',     'КС-45717А-1Р и КС-45717К-1Р, ИМЗ «Автокран»'),
  ('truck_cranes',         '%55713%',      'lift_capacity=25',     'КС-55713-1 «Галичанин», КС-55713-6К-3 «Клинцы»'),
  ('truck_cranes',         '%65719%',      'lift_capacity=40',     'КС-65719-5К «Клинцы» — 40 т, а не 32'),
  -- Вилочные погрузчики и минипогрузчики: номинальная грузоподъёмность.
  ('forklift_miniloaders', '%bobcat s175%','lift_capacity=0.8',    '795 кг'),
  ('forklift_miniloaders', '%bobcat s650%','lift_capacity=1.3',    '1282 кг'),
  ('forklift_miniloaders', '%2076%',       'lift_capacity=1',      'Mustang 2076 и SL-2076 B, 998 кг'),
  ('forklift_miniloaders', '%2086%',       'lift_capacity=1.2',    'Mustang 2086 и SL 2086, 1179 кг'),
  ('forklift_miniloaders', '%2600%',       'lift_capacity=1.2',    'Mustang 2600 R, 1179 кг'),
  ('forklift_miniloaders', '%2700%',       'lift_capacity=1.2',    'Mustang 2700V, 1225 кг'),
  ('forklift_miniloaders', '%3300%',       'lift_capacity=1.5',    'Mustang 3300V, 1497 кг'),
  ('forklift_miniloaders', '%fd25c%',      'lift_capacity=2.5',    'Komatsu FD25C-14'),
  ('forklift_miniloaders', '%fd25hw%',     'lift_capacity=2.5',    'Komatsu FD25HW-14'),
  ('forklift_miniloaders', '%m26 4%',      'lift_capacity=2.6',    'Manitou M26-4, телескопический'),
  ('forklift_miniloaders', '%tlt30c%',     'lift_capacity=3',      'JCB TLT30C Teletruk'),
  ('forklift_miniloaders', '%msi 50h%',    'lift_capacity=5',      'Manitou MSI 50H'),
  -- Фронтальные погрузчики.
  ('front_loaders',        '%lg936l%',     'lift_capacity=3.5',    'SDLG LG936L, 3500 кг'),
  ('front_loaders',        'амкодор%',     'lift_capacity=3.4',    'Амкодор-332С-01 и 332С4-01, 3400 кг'),
  -- Грузовые малотоннажные.
  ('light_trucks',         '%330232%',     'lift_capacity=1.5',    'ГАЗ-330232'),
  ('light_trucks',         '%22r32%',      'lift_capacity=1.5',    'ГАЗ-А22R32 и Gazelle NN A22R32'),
  ('light_trucks',         '%2834%',       'lift_capacity=1.5',    'ГАЗ-2834EH и ГАЗ-2834FН'),
  ('light_trucks',         '%bongo%',      'lift_capacity=1.2',    'Kia Bongo'),
  -- Катки различаются эксплуатационной массой, а не грузоподъёмностью.
  ('road_rollers',         '%rs8140%',     'operating_weight=14',  'SDLG RS8140, 14 000 кг');

-- ── Сопоставление модель → категория ────────────────────────────────────────────────────────
CREATE TEMP TABLE model_category_map ON COMMIT DROP AS
SELECT m.id AS model_id, m.name AS model_name, t.code AS type_code, c.id AS category_id, p.name_pattern
FROM seed_model_categories p
JOIN vehicle_types t ON t.code = p.type_code
JOIN vehicle_models m ON m.vehicle_type_id = t.id AND m.normalized_name LIKE p.name_pattern
JOIN vehicle_categories c ON c.vehicle_type_id = t.id AND c.spec_signature = p.category_signature;

-- ── Проверки сопоставления ──────────────────────────────────────────────────────────────────
-- Шаблон, не нашедший ни одной модели, и модель, попавшая под два шаблона, одинаково означают,
-- что справочник разошёлся с этим сидом: в первом случае машины молча остались бы без категории,
-- во втором получили бы произвольную из двух.
DO $$
DECLARE
  unmatched text;
  ambiguous text;
  affected  int;
BEGIN
  SELECT string_agg(format('%s / %s', p.type_code, p.name_pattern), '; ') INTO unmatched
  FROM seed_model_categories p
  WHERE NOT EXISTS (
    SELECT 1 FROM model_category_map mc
    WHERE mc.type_code = p.type_code AND mc.name_pattern = p.name_pattern
  );
  IF unmatched IS NOT NULL THEN
    RAISE EXCEPTION 'Шаблоны моделей не нашли ни одной записи: %', unmatched;
  END IF;

  SELECT string_agg(model_name, '; ') INTO ambiguous
  FROM (SELECT model_name FROM model_category_map GROUP BY model_id, model_name HAVING count(*) > 1) s;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'Модели попали под несколько шаблонов: %', ambiguous;
  END IF;

  UPDATE vehicles v
  SET vehicle_category_id = mc.category_id, updated_at = now()
  FROM model_category_map mc
  WHERE v.vehicle_model_id = mc.model_id
    AND v.ownership = 'own'
    AND v.vehicle_category_id IS NULL
    AND v.deleted_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;

  RAISE NOTICE 'Разнесено машин по категориям: %', affected;
END $$;
