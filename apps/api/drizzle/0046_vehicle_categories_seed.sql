-- Категории типов ТС из выверенных данных (ADR 0016 §7, наполнение — ADR 0023).
--
-- 46 категорий: значения взяты из двух прайсов аренды и из открытых данных заводов-изготовителей
-- по собственному парку. Перебором комбинации не порождаются (ADR 0016 §7) — здесь ровно те
-- значения, которые встречаются в документах или в парке.
--
-- Наименования записаны литералами в формате `buildVehicleCategoryName`: «{тип}, {кратко}
-- {значение} {ед}», значение — с точкой и без хвостовых нулей (25, 1.2, 3.5). Это снимок на момент
-- сида; дальше имя ведёт приложение. Формат закреплён тестом
-- apps/api/test/vehicle-category-name.test.ts — если он изменится, тест укажет сюда.
--
-- Сигнатуру считает vehicle_category_signature() — та же функция, что стоит за уникальным
-- индексом (ADR 0016 §5): приложение и сид её не дублируют.
-- Полноту набора значений проверяют отложенные триггеры на COMMIT.
--
-- Идемпотентно: по (vehicle_type_id, spec_signature) у категорий, по PK у значений.

CREATE TEMP TABLE seed_categories (
  key        text PRIMARY KEY,
  type_code  text    NOT NULL,
  name       text    NOT NULL,
  sort_order integer NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE seed_category_values (
  key       text    NOT NULL,
  spec_code text    NOT NULL,
  value     numeric NOT NULL,
  PRIMARY KEY (key, spec_code)
) ON COMMIT DROP;

-- ── Автокраны. 20/25/40 т — свой парк, остальное — прайсы. Длина стрелы в категорию не входит
--    (ТТХ не привязан): там, где прайс её называет, она осталась в описании предложения.
INSERT INTO seed_categories VALUES
  ('crane_20',  'truck_cranes', 'Автокраны, г/п 20 т',   10),
  ('crane_25',  'truck_cranes', 'Автокраны, г/п 25 т',   20),
  ('crane_32',  'truck_cranes', 'Автокраны, г/п 32 т',   30),
  ('crane_35',  'truck_cranes', 'Автокраны, г/п 35 т',   40),
  ('crane_40',  'truck_cranes', 'Автокраны, г/п 40 т',   50),
  ('crane_50',  'truck_cranes', 'Автокраны, г/п 50 т',   60),
  ('crane_70',  'truck_cranes', 'Автокраны, г/п 70 т',   70),
  ('crane_90',  'truck_cranes', 'Автокраны, г/п 90 т',   80),
  ('crane_120', 'truck_cranes', 'Автокраны, г/п 120 т',  90),
  ('crane_130', 'truck_cranes', 'Автокраны, г/п 130 т', 100);
INSERT INTO seed_category_values VALUES
  ('crane_20',  'lift_capacity',  20),
  ('crane_25',  'lift_capacity',  25),
  ('crane_32',  'lift_capacity',  32),
  ('crane_35',  'lift_capacity',  35),
  ('crane_40',  'lift_capacity',  40),
  ('crane_50',  'lift_capacity',  50),
  ('crane_70',  'lift_capacity',  70),
  ('crane_90',  'lift_capacity',  90),
  ('crane_120', 'lift_capacity', 120),
  ('crane_130', 'lift_capacity', 130);

-- ── Тяжелые манипуляторы. Прайс называет обе величины разом: «г/п 15. Стрела г/п 7 тонн».
INSERT INTO seed_categories VALUES
  ('kmu_6_3',  'heavy_manipulators', 'Тяжелые манипуляторы, г/п 6 т, стрела г/п 3 т',  10),
  ('kmu_8_5',  'heavy_manipulators', 'Тяжелые манипуляторы, г/п 8 т, стрела г/п 5 т',  20),
  ('kmu_15_7', 'heavy_manipulators', 'Тяжелые манипуляторы, г/п 15 т, стрела г/п 7 т', 30);
INSERT INTO seed_category_values VALUES
  ('kmu_6_3',  'lift_capacity',  6), ('kmu_6_3',  'boom_capacity', 3),
  ('kmu_8_5',  'lift_capacity',  8), ('kmu_8_5',  'boom_capacity', 5),
  ('kmu_15_7', 'lift_capacity', 15), ('kmu_15_7', 'boom_capacity', 7);

-- ── Автовышки. АГП-17…АГП-45 из протокола плюс 18 и 36 м из сравнительной таблицы.
INSERT INTO seed_categories VALUES
  ('agp_17', 'aerial_platforms', 'Автовышки (АГП), высота 17 м', 10),
  ('agp_18', 'aerial_platforms', 'Автовышки (АГП), высота 18 м', 20),
  ('agp_22', 'aerial_platforms', 'Автовышки (АГП), высота 22 м', 30),
  ('agp_28', 'aerial_platforms', 'Автовышки (АГП), высота 28 м', 40),
  ('agp_32', 'aerial_platforms', 'Автовышки (АГП), высота 32 м', 50),
  ('agp_36', 'aerial_platforms', 'Автовышки (АГП), высота 36 м', 60),
  ('agp_40', 'aerial_platforms', 'Автовышки (АГП), высота 40 м', 70),
  ('agp_45', 'aerial_platforms', 'Автовышки (АГП), высота 45 м', 80);
INSERT INTO seed_category_values VALUES
  ('agp_17', 'lift_height', 17),
  ('agp_18', 'lift_height', 18),
  ('agp_22', 'lift_height', 22),
  ('agp_28', 'lift_height', 28),
  ('agp_32', 'lift_height', 32),
  ('agp_36', 'lift_height', 36),
  ('agp_40', 'lift_height', 40),
  ('agp_45', 'lift_height', 45);

-- ── Самосвалы. Только аренда: у своих машин объём кузова по модели не определяется
--    (МАЗ-6501А5 идёт с платформой 12,5 или 15,4 м³, КамАЗ-65201 — 16 или 20 м³).
INSERT INTO seed_categories VALUES
  ('dump_12', 'dump_trucks', 'Самосвалы, кузов 12 м³', 10),
  ('dump_20', 'dump_trucks', 'Самосвалы, кузов 20 м³', 20);
INSERT INTO seed_category_values VALUES
  ('dump_12', 'body_volume', 12),
  ('dump_20', 'body_volume', 20);

-- ── Грузовые малотоннажные: Kia Bongo 1,2 т, ГАЗели 1,5 т (они же — «борт 1,5 т» из протокола).
INSERT INTO seed_categories VALUES
  ('lt_1_2', 'light_trucks', 'Грузовые малотоннажные автомобили, г/п 1.2 т', 10),
  ('lt_1_5', 'light_trucks', 'Грузовые малотоннажные автомобили, г/п 1.5 т', 20);
INSERT INTO seed_category_values VALUES
  ('lt_1_2', 'lift_capacity', 1.2),
  ('lt_1_5', 'lift_capacity', 1.5);

-- ── Бортовые автомобили: борт 10 и 20 т из протокола.
INSERT INTO seed_categories VALUES
  ('flat_10', 'flatbed_trucks', 'Бортовые автомобили, г/п 10 т', 10),
  ('flat_20', 'flatbed_trucks', 'Бортовые автомобили, г/п 20 т', 20);
INSERT INTO seed_category_values VALUES
  ('flat_10', 'lift_capacity', 10),
  ('flat_20', 'lift_capacity', 20);

-- ── Вилочные погрузчики и минипогрузчики. Весь ряд — собственный парк, кроме 1,5 т, куда
--    попадает и арендный BOBCAT T-870 (1508 кг), и свой Mustang 3300V (1497 кг).
INSERT INTO seed_categories VALUES
  ('ldr_0_8', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 0.8 т', 10),
  ('ldr_1_0', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 1 т',   20),
  ('ldr_1_2', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 1.2 т', 30),
  ('ldr_1_3', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 1.3 т', 40),
  ('ldr_1_5', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 1.5 т', 50),
  ('ldr_2_5', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 2.5 т', 60),
  ('ldr_2_6', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 2.6 т', 70),
  ('ldr_3_0', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 3 т',   80),
  ('ldr_5_0', 'forklift_miniloaders', 'Вилочные погрузчики и минипогрузчики, г/п 5 т',   90);
INSERT INTO seed_category_values VALUES
  ('ldr_0_8', 'lift_capacity', 0.8),
  ('ldr_1_0', 'lift_capacity', 1.0),
  ('ldr_1_2', 'lift_capacity', 1.2),
  ('ldr_1_3', 'lift_capacity', 1.3),
  ('ldr_1_5', 'lift_capacity', 1.5),
  ('ldr_2_5', 'lift_capacity', 2.5),
  ('ldr_2_6', 'lift_capacity', 2.6),
  ('ldr_3_0', 'lift_capacity', 3.0),
  ('ldr_5_0', 'lift_capacity', 5.0);

-- ── Фронтальные погрузчики: Амкодор-332С4 (3400 кг) и SDLG LG936L (3500 кг).
INSERT INTO seed_categories VALUES
  ('fl_3_4', 'front_loaders', 'Фронтальные погрузчики, г/п 3.4 т', 10),
  ('fl_3_5', 'front_loaders', 'Фронтальные погрузчики, г/п 3.5 т', 20);
INSERT INTO seed_category_values VALUES
  ('fl_3_4', 'lift_capacity', 3.4),
  ('fl_3_5', 'lift_capacity', 3.5);

-- ── Экскаваторы гусеничные: мини-экскаватор 3,5 т из протокола.
INSERT INTO seed_categories VALUES
  ('cex_3_5', 'crawler_excavators', 'Экскаваторы гусеничные, масса 3.5 т', 10);
INSERT INTO seed_category_values VALUES
  ('cex_3_5', 'operating_weight', 3.5);

-- ── Катки: виброкатки 10/14/16 т из протокола; в 14 т попадает и свой SDLG RS8140.
INSERT INTO seed_categories VALUES
  ('roll_10', 'road_rollers', 'Катки, масса 10 т', 10),
  ('roll_14', 'road_rollers', 'Катки, масса 14 т', 20),
  ('roll_16', 'road_rollers', 'Катки, масса 16 т', 30);
INSERT INTO seed_category_values VALUES
  ('roll_10', 'operating_weight', 10),
  ('roll_14', 'operating_weight', 14),
  ('roll_16', 'operating_weight', 16);

-- ── Бульдозеры и компрессоры: только аренда, своих машин таких типов нет.
INSERT INTO seed_categories VALUES
  ('dozer_18', 'bulldozers',  'Бульдозеры, масса 18 т', 10),
  ('dozer_23', 'bulldozers',  'Бульдозеры, масса 23 т', 20),
  ('comp_2',   'compressors', 'Компрессоры, молотков 2', 10),
  ('comp_3',   'compressors', 'Компрессоры, молотков 3', 20);
INSERT INTO seed_category_values VALUES
  ('dozer_18', 'operating_weight', 18),
  ('dozer_23', 'operating_weight', 23),
  ('comp_2',   'hammer_count',      2),
  ('comp_3',   'hammer_count',      3);

-- ── Проверка сида до записи: каждая категория обязана покрыть ровно все ТТХ своего типа.
--    Триггер поймает то же самое на COMMIT, но сообщением про UUID; здесь видно тип и ключ.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', sc.key, sc.type_code), ', ') INTO bad
  FROM seed_categories sc
  JOIN vehicle_types t ON t.code = sc.type_code
  WHERE (SELECT count(*) FROM seed_category_values v WHERE v.key = sc.key)
     <> (SELECT count(*) FROM vehicle_type_specs ts WHERE ts.vehicle_type_id = t.id);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Категории сида не покрывают ТТХ своего типа: %', bad;
  END IF;
END $$;

-- ── Запись категорий.
INSERT INTO vehicle_categories (vehicle_type_id, name, is_auto_name, spec_signature, sort_order)
SELECT t.id, sc.name, true, sig.signature, sc.sort_order
FROM seed_categories sc
JOIN vehicle_types t ON t.code = sc.type_code
JOIN LATERAL (
  SELECT vehicle_category_signature(jsonb_object_agg(v.spec_code, v.value)) AS signature
  FROM seed_category_values v
  WHERE v.key = sc.key
) sig ON true
ON CONFLICT (vehicle_type_id, spec_signature) DO NOTHING;

-- ── Запись значений. Категория ищется по своей сигнатуре, а не по возвращённому id: при
--    повторном прогоне вставка выше не вернёт ничего, а значения всё равно должны сойтись.
INSERT INTO vehicle_category_spec_values (category_id, vehicle_type_id, spec_id, value_num)
SELECT c.id, c.vehicle_type_id, s.id, v.value
FROM seed_categories sc
JOIN vehicle_types t ON t.code = sc.type_code
JOIN LATERAL (
  SELECT vehicle_category_signature(jsonb_object_agg(x.spec_code, x.value)) AS signature
  FROM seed_category_values x
  WHERE x.key = sc.key
) sig ON true
JOIN vehicle_categories c ON c.vehicle_type_id = t.id AND c.spec_signature = sig.signature
JOIN seed_category_values v ON v.key = sc.key
JOIN vehicle_specs s ON s.code = v.spec_code
ON CONFLICT (category_id, spec_id) DO NOTHING;
