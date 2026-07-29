-- Предложения аренды техники из прайсов арендодателей (ADR 0018, наполнение — ADR 0023).
--
-- Источники:
--   S1 — протокол договорной цены ООО «СУ-10» ↔ ООО «СПЕЦПОРТ «НАДЕЖДА», объект ЖК CITY BAY
--        2-я очередь: 51 строка, цена за маш/час и за маш/смену, с НДС 22%.
--   S2 — сравнительная таблица трёх арендодателей: 10 позиций, только цена за час, подпись
--        «8 часов — минимальная смена работы, цены с учётом НДС».
--
-- Расхождения источников по «Спецпорту» (8 позиций из 10) сняты в пользу протокола: он подписан
-- и относится к конкретному объекту. Сравнительная таблица использована только для «ЭВЕРЕНТ» и
-- «ЯРД Империал» — другого источника цен по ним нет.
--
-- Не заводятся две строки протокола:
--   №40 «Ямобур с установкой шпунта» — цена договорная во всех колонках, а у аренды обязательна
--        хотя бы одна цена (vehicles_rental_fields_check);
--   №48 «Перевозка спецтехники» — услуга трала (24000 и за час, и за смену), а не единица техники.
-- Стоимость выезда за МКАД в модель не заводится вовсе.
--
-- Цены записаны ровно как в документе, включая три строки, где смена не равна восьми часам:
-- автокран 90 т (98000 против 100000), автокран 70 т (68000 против 64000) и бульдозер до 23 т
-- (45000 против 50000). Правки «по арифметике» здесь неуместны: источник — подписанный документ.
--
-- Категория пуста там, где документ не называет ту величину, которая закреплена за типом:
-- экскаватор-погрузчик (различается только навеской), минипогрузчик XCMG (модель не названа),
-- компрессор-бетонолом (число молотков не указано), самосвал Татра (20 т — это грузоподъёмность,
-- а не объём кузова), фронтальный погрузчик («от 2 м³» — диапазон ковша, а не г/п).
--
-- Идемпотентно по ключу предложения (lessor_id, тип, категория, описание) — частичный уникальный
-- индекс vehicles_rental_offer_unique, поэтому в ON CONFLICT повторён и его предикат.

CREATE TEMP TABLE seed_rentals (
  lessor_inn         text NOT NULL,
  type_code          text NOT NULL,
  category_signature text,
  description        text NOT NULL,
  price_per_hour     numeric(12, 2),
  price_per_shift    numeric(12, 2),
  source_name        text NOT NULL
) ON COMMIT DROP;

-- ── S1: ООО «Спецпорт «Надежда», ИНН 7726448317 — 51 предложение ────────────────────────────
INSERT INTO seed_rentals (lessor_inn, type_code, category_signature, description, price_per_hour, price_per_shift, source_name)
SELECT '7726448317', x.type_code, x.sig, x.description, x.hour, x.shift,
       'Протокол договорной цены СУ-10 — СПЕЦПОРТ «НАДЕЖДА», ЖК CITY BAY 2 оч., с НДС 22%'
FROM (VALUES
  ('truck_cranes',         'lift_capacity=130',               'Автокран г/п 130 т',                         17000, 136000),
  ('truck_cranes',         'lift_capacity=90',                'Автокран г/п 90 т',                          12500,  98000),
  ('truck_cranes',         'lift_capacity=70',                'Автокран г/п 70 т',                           8000,  68000),
  ('truck_cranes',         'lift_capacity=50',                'Автокран г/п 50 т',                           6750,  54000),
  ('truck_cranes',         'lift_capacity=40',                'Автокран г/п 40 т',                           5750,  46000),
  ('truck_cranes',         'lift_capacity=32',                'Автокран г/п 32 т',                           3750,  30000),
  ('truck_cranes',         'lift_capacity=25',                'Автокран 25 т, стрела 30 м',                  3700,  29600),
  ('truck_cranes',         'lift_capacity=25',                'Автокран г/п 25 т',                           3400,  27200),
  ('truck_cranes',         'lift_capacity=35',                'Автокран 35 т, стрела 40 м',                  5000,  40000),
  ('aerial_platforms',     'lift_height=17',                  'Автовышка АГП-17',                            2450,  19600),
  ('aerial_platforms',     'lift_height=22',                  'Автовышка АГП-22',                            2800,  22400),
  ('aerial_platforms',     'lift_height=28',                  'Автовышка АГП-28',                            3300,  26400),
  ('aerial_platforms',     'lift_height=32',                  'Автовышка АГП-32',                            3500,  28000),
  ('aerial_platforms',     'lift_height=32',                  'Автовышка АГП-32 на базе вездехода',          4800,  38400),
  ('aerial_platforms',     'lift_height=40',                  'Автовышка АГП-40',                            4750,  38000),
  ('aerial_platforms',     'lift_height=45',                  'Автовышка АГП-45',                            6000,  48000),
  ('backhoe_loaders',      NULL,                              'Экскаватор-погрузчик JCB, ковш',              3750,  30000),
  ('backhoe_loaders',      NULL,                              'Экскаватор-погрузчик JCB, гидромолот и вилы', 4000,  32000),
  ('wheeled_excavators',   NULL,                              'Полноповоротный экскаватор без гидромолота',  3750,  30000),
  ('crawler_excavators',   NULL,                              'Полноповоротный экскаватор без гидромолота',  3750,  30000),
  ('forklift_miniloaders', NULL,                              'Минипогрузчик XCMG, вилы и ковш',             2750,  22000),
  ('forklift_miniloaders', NULL,                              'Минипогрузчик XCMG, щётка',                   3000,  24000),
  ('heavy_manipulators',   'boom_capacity=7;lift_capacity=15','Манипулятор г/п 15 т, стрела 7 т',            3500,  28000),
  ('heavy_manipulators',   'boom_capacity=7;lift_capacity=15','Манипулятор-вездеход г/п 15 т, стрела 7 т',   4750,  38000),
  ('heavy_manipulators',   'boom_capacity=5;lift_capacity=8', 'Манипулятор г/п 8 т, стрела 5 т',             3200,  25600),
  ('heavy_manipulators',   'boom_capacity=3;lift_capacity=6', 'Манипулятор г/п 6 т, стрела 3 т',             2700,  21600),
  ('heavy_manipulators',   'boom_capacity=7;lift_capacity=15','Манипулятор низкорамный г/п 15 т, стрела 7 т',3250,  26000),
  ('light_trucks',         'lift_capacity=1.5',               'Автомашина борт 1,5 т',                       1200,   9600),
  ('flatbed_trucks',       'lift_capacity=20',                'Автомашина борт 20 т',                        3250,  26000),
  ('flatbed_trucks',       'lift_capacity=10',                'Автомашина борт 10 т',                        2800,  22400),
  ('compressors',          'hammer_count=2',                  'Компрессор, 2 молотка',                       2000,  16000),
  ('compressors',          'hammer_count=3',                  'Компрессор, продувка воздухом, 3 молотка',    2250,  18000),
  ('compressors',          NULL,                              'Компрессор, бетонолом',                       2250,  18000),
  ('watering_machines',    NULL,                              'Поливомоечная машина',                        3200,  25600),
  ('wheeled_excavators',   NULL,                              'Полноповоротный экскаватор с гидромолотом',   4500,  36000),
  ('crawler_excavators',   NULL,                              'Полноповоротный экскаватор с гидромолотом',   4500,  36000),
  ('crawler_excavators',   'operating_weight=3.5',            'Мини-экскаватор гусеничный, ковш',            3200,  25600),
  ('crawler_excavators',   'operating_weight=3.5',            'Мини-экскаватор гусеничный, гидромолот',      3500,  28000),
  ('dump_trucks',          'body_volume=20',                  'Самосвал (работа по месту) 20 м³',            3600,  28800),
  ('dump_trucks',          'body_volume=12',                  'Самосвал (работа по месту) 12 м³',            3200,  25600),
  ('truck_cranes',         'lift_capacity=32',                'Автокран-вездеход 32 т',                      4300,  34400),
  ('drilling_rigs',        NULL,                              'Ямобур',                                      5750,  46000),
  ('drilling_rigs',        NULL,                              'Ямобур на базе вездехода, шпунт 150–500 мм',  7500,  60000),
  ('road_rollers',         'operating_weight=10',             'Виброкаток до 10 т',                          3600,  28800),
  ('road_rollers',         'operating_weight=14',             'Виброкаток грунтовый 14 т',                   3750,  30000),
  ('road_rollers',         'operating_weight=16',             'Виброкаток грунтовый 16 т',                   4000,  32000),
  ('forklift_miniloaders', 'lift_capacity=1.5',               'Гусеничный минипогрузчик BOBCAT T-870',       3500,  28000),
  ('bulldozers',           'operating_weight=18',             'Бульдозер до 18 т',                           5000,  40000),
  ('bulldozers',           'operating_weight=23',             'Бульдозер до 23 т',                           6250,  45000),
  ('dump_trucks',          NULL,                              'Самосвал-вездеход Татра, г/п 20 т',           3750,  30000),
  ('front_loaders',        NULL,                              'Фронтальный погрузчик, ковш от 2 м³',         3700,  29600)
) AS x(type_code, sig, description, hour, shift);

-- ── S2: ООО «ЭВЕРЕНТ» (9 позиций, автокрана 120 т нет) и ООО «ЯРД Империал» (10) ────────────
-- Цена за смену в таблице не указана и не достраивается умножением на 8: это был бы домысел.
-- shift_hours = 8 сохраняет из подписи таблицы длительность смены, к которой относится минимум.
INSERT INTO seed_rentals (lessor_inn, type_code, category_signature, description, price_per_hour, price_per_shift, source_name)
SELECT x.inn, x.type_code, x.sig, x.description, x.hour, NULL,
       'Сравнительная таблица цен арендодателей, с НДС, смена от 8 ч'
FROM (VALUES
  ('7734432462', 'dump_trucks',        'body_volume=20',    'Самосвал 20 м³ (работа по месту)', 3500),
  ('7734432462', 'heavy_manipulators', NULL,                'Манипулятор, стрела 7 т',          3375),
  ('7734432462', 'backhoe_loaders',    NULL,                'Экскаватор-погрузчик, ковш и вилы',3750),
  ('7734432462', 'aerial_platforms',   'lift_height=18',    'Автовышка 18 м',                   2625),
  ('7734432462', 'aerial_platforms',   'lift_height=36',    'Автовышка 36 м',                   3875),
  ('7734432462', 'crawler_excavators', NULL,                'Мини-экскаватор',                  3250),
  ('7734432462', 'truck_cranes',       'lift_capacity=35',  'Автокран 35 т, стрела 42 м',       4500),
  ('7734432462', 'truck_cranes',       'lift_capacity=40',  'Автокран 40 т',                    4500),
  ('7734432462', 'truck_cranes',       'lift_capacity=70',  'Автокран 70 т',                    7750),
  ('7710960488', 'dump_trucks',        'body_volume=20',    'Самосвал 20 м³ (работа по месту)', 3500),
  ('7710960488', 'heavy_manipulators', NULL,                'Манипулятор, стрела 7 т',          3375),
  ('7710960488', 'backhoe_loaders',    NULL,                'Экскаватор-погрузчик, ковш и вилы',4000),
  ('7710960488', 'aerial_platforms',   'lift_height=18',    'Автовышка 18 м',                   2875),
  ('7710960488', 'aerial_platforms',   'lift_height=36',    'Автовышка 36 м',                   5250),
  ('7710960488', 'crawler_excavators', NULL,                'Мини-экскаватор',                  3750),
  ('7710960488', 'truck_cranes',       'lift_capacity=35',  'Автокран 35 т, стрела 42 м',       5875),
  ('7710960488', 'truck_cranes',       'lift_capacity=40',  'Автокран 40 т',                    5250),
  ('7710960488', 'truck_cranes',       'lift_capacity=70',  'Автокран 70 т',                    8500),
  ('7710960488', 'truck_cranes',       'lift_capacity=120', 'Автокран 120 т',                  18125)
) AS x(inn, type_code, sig, description, hour);

-- ── Проверка сида: арендодатель, тип и названная категория обязаны найтись. Молча вставить
--    предложение без категории там, где она задумана, — худший исход: расхождение не увидит никто.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(DISTINCT format('%s / %s', r.lessor_inn, r.description), '; ') INTO bad
  FROM seed_rentals r
  WHERE NOT EXISTS (
          SELECT 1 FROM counterparties c
          WHERE c.inn = r.lessor_inn AND c.type = 'vehicle_lessor' AND c.deleted_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM vehicle_types t WHERE t.code = r.type_code)
     OR (r.category_signature IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM vehicle_categories vc
          JOIN vehicle_types t ON t.id = vc.vehicle_type_id
          WHERE t.code = r.type_code AND vc.spec_signature = r.category_signature));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Предложения аренды не находят арендодателя, тип или категорию: %', bad;
  END IF;
END $$;

INSERT INTO vehicles (
  vehicle_type_id, vehicle_category_id, ownership,
  lessor_id, lessor_type, lessor_is_active,
  description, price_per_hour, price_per_shift, shift_hours,
  status, source_name
)
SELECT
  t.id, c.id, 'rental',
  l.id, 'vehicle_lessor', l.is_active,
  r.description, r.price_per_hour, r.price_per_shift, 8,
  'active', r.source_name
FROM seed_rentals r
JOIN vehicle_types t ON t.code = r.type_code
JOIN counterparties l ON l.inn = r.lessor_inn AND l.type = 'vehicle_lessor' AND l.deleted_at IS NULL
LEFT JOIN vehicle_categories c
  ON c.vehicle_type_id = t.id AND c.spec_signature = r.category_signature
ON CONFLICT (lessor_id, vehicle_type_id, vehicle_category_id, description)
  WHERE ownership = 'rental' AND deleted_at IS NULL
  DO NOTHING;
