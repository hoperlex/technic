-- Этап 2: таблица сопоставлений + наполнение классификатора ТС (утверждённая типизация).
-- Идемпотентно (ON CONFLICT по code / по source_code+normalized). Самосвалы (dump_truck) и
-- bunker_carrier НЕ создаются; mapping «Самосвалы» не создаётся.

-- 1. Таблица сопоставлений исходных «Тип ТС» → тип/подтип классификатора.
CREATE TABLE vehicle_type_source_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NOT NULL,
  source_name text NOT NULL,
  normalized_source_name text NOT NULL,
  vehicle_type_id uuid NOT NULL REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  resolution_strategy text NOT NULL,
  requires_instance_resolution boolean NOT NULL DEFAULT false,
  comment text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_type_source_mappings_strategy_check
    CHECK (resolution_strategy IN ('direct', 'by_model', 'by_registry')),
  CONSTRAINT vehicle_type_source_mappings_source_name_not_blank CHECK (btrim(source_name) <> '')
);
CREATE UNIQUE INDEX vehicle_type_source_mappings_source_unique
  ON vehicle_type_source_mappings (source_code, normalized_source_name);
CREATE INDEX vehicle_type_source_mappings_type_idx
  ON vehicle_type_source_mappings (vehicle_type_id);

-- 2. Родительские типы (is_selectable=false; is_active — есть ли активный потомок).
INSERT INTO vehicle_types (kind_id, code, name, is_selectable, is_active, sort_order) VALUES
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'cranes',                       'Краны',                          false, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'loaders',                      'Погрузчики',                     false, true,  20),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'excavators',                   'Экскаваторы',                    false, true,  30),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'road_construction_machinery',  'Дорожно-строительная техника',   false, false, 40),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'other_special_equipment',      'Прочая спецтехника',             false, false, 50),
  ((SELECT id FROM vehicle_kinds WHERE code = 'freight_transport'), 'road_transport',               'Автомобильный транспорт',        false, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code = 'freight_transport'), 'kmu_transport',                'Транспорт с КМУ',                false, true,  20),
  ((SELECT id FROM vehicle_kinds WHERE code = 'freight_transport'), 'specialized_transport',        'Специализированный транспорт',   false, true,  30),
  ((SELECT id FROM vehicle_kinds WHERE code = 'freight_transport'), 'trailer_equipment',            'Прицепная техника',              false, false, 40)
ON CONFLICT (code) DO NOTHING;

-- 3. Подтипы (is_selectable=true). kind_id = вид родителя (составной FK это проверит).
INSERT INTO vehicle_types (kind_id, parent_id, code, name, is_selectable, is_active, sort_order) VALUES
  -- cranes
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='cranes'),                      'truck_crane',          'Автокран',                  true, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='cranes'),                      'pneumatic_tire_crane', 'Пневмоколёсный кран',       true, true,  20),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='cranes'),                      'self_propelled_crane', 'Самоходный стреловой кран', true, true,  30),
  -- loaders
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='loaders'),                     'forklift',             'Вилочный погрузчик',        true, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='loaders'),                     'skid_steer_loader',    'Мини-погрузчик',            true, true,  20),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='loaders'),                     'telescopic_loader',    'Телескопический погрузчик', true, true,  30),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='loaders'),                     'front_loader',         'Фронтальный погрузчик',     true, true,  40),
  -- excavators
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='excavators'),                  'wheeled_excavator',    'Колёсный экскаватор',       true, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='excavators'),                  'crawler_excavator',    'Гусеничный экскаватор',     true, true,  20),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='excavators'),                  'backhoe_loader',       'Экскаватор-погрузчик',      true, true,  30),
  -- road_construction_machinery
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='road_construction_machinery'), 'road_roller',          'Дорожный каток',            true, false, 10),
  -- other_special_equipment
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='other_special_equipment'),     'municipal_machine',    'Коммунальная машина',       true, false, 10),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), (SELECT id FROM vehicle_types WHERE code='other_special_equipment'),     'tractor',              'Трактор',                   true, false, 20),
  -- road_transport
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='road_transport'),              'passenger_car',        'Легковой автомобиль',               true, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='road_transport'),              'light_truck',          'Малотоннажный грузовой автомобиль', true, true,  20),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='road_transport'),              'tractor_unit',         'Седельный тягач',                   true, true,  30),
  -- kmu_transport
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='kmu_transport'),               'light_kmu_truck',      'Малотоннажный автомобиль с КМУ', true, true, 10),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='kmu_transport'),               'heavy_kmu_truck',      'Тяжёлый автомобиль с КМУ',       true, true, 20),
  -- specialized_transport
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='specialized_transport'),       'multilift',            'Мультилифт', true, true,  10),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='specialized_transport'),       'garbage_truck',        'Мусоровоз',  true, false, 20),
  -- trailer_equipment
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='trailer_equipment'),           'semi_trailer',         'Полуприцеп', true, false, 10),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), (SELECT id FROM vehicle_types WHERE code='trailer_equipment'),           'trailer',              'Прицеп',     true, false, 20)
ON CONFLICT (code) DO NOTHING;

-- 4. Source mappings (source = активный лист 06.26-06.27). Самосвалы НЕ добавляются.
INSERT INTO vehicle_type_source_mappings
  (source_code, source_name, normalized_source_name, vehicle_type_id, resolution_strategy, requires_instance_resolution, comment) VALUES
  -- Однозначные → конечный подтип
  ('worked_list_06_26_06_27', 'Автокраны',              'автокраны',              (SELECT id FROM vehicle_types WHERE code='truck_crane'),          'direct', false, ''),
  ('worked_list_06_26_06_27', 'Кран пневмоколесный',    'кран пневмоколесный',    (SELECT id FROM vehicle_types WHERE code='pneumatic_tire_crane'), 'direct', false, ''),
  ('worked_list_06_26_06_27', 'Кран самоходный',        'кран самоходный',        (SELECT id FROM vehicle_types WHERE code='self_propelled_crane'), 'direct', false, ''),
  ('worked_list_06_26_06_27', 'Легковые автомобили',    'легковые автомобили',    (SELECT id FROM vehicle_types WHERE code='passenger_car'),        'direct', false, ''),
  ('worked_list_06_26_06_27', 'Тягачи с полуприцепами', 'тягачи с полуприцепами', (SELECT id FROM vehicle_types WHERE code='tractor_unit'),         'direct', false, ''),
  ('worked_list_06_26_06_27', 'Фронтальные погрузчики', 'фронтальные погрузчики', (SELECT id FROM vehicle_types WHERE code='front_loader'),         'direct', false, ''),
  ('worked_list_06_26_06_27', 'Экскаватор колесный',    'экскаватор колесный',    (SELECT id FROM vehicle_types WHERE code='wheeled_excavator'),    'direct', false, ''),
  ('worked_list_06_26_06_27', 'Экскаваторы гусеничные', 'экскаваторы гусеничные', (SELECT id FROM vehicle_types WHERE code='crawler_excavator'),    'direct', false, ''),
  ('worked_list_06_26_06_27', 'Катки',                  'катки',                  (SELECT id FROM vehicle_types WHERE code='road_roller'),          'direct', false, ''),
  -- Неоднозначные → родитель (requires_instance_resolution=true)
  ('worked_list_06_26_06_27', 'Вилочные погрузчики и минипогрузчики', 'вилочные погрузчики и минипогрузчики', (SELECT id FROM vehicle_types WHERE code='loaders'),               'by_model',    true, 'Разделяется на вилочный/мини/телескопический по модели'),
  ('worked_list_06_26_06_27', 'Грузовые малотоннажные автомобили',    'грузовые малотоннажные автомобили',    (SELECT id FROM vehicle_types WHERE code='road_transport'),        'by_registry', true, 'Часть — малотоннажные с КМУ (light_kmu_truck) по реестру'),
  ('worked_list_06_26_06_27', 'Тяжелые манипуляторы',                 'тяжелые манипуляторы',                 (SELECT id FROM vehicle_types WHERE code='kmu_transport'),         'by_registry', true, 'МАЗ-МКМВ9В У702/У782 фактически мультилифты'),
  ('worked_list_06_26_06_27', 'Бункеровозы, мультилифты',             'бункеровозы, мультилифты',             (SELECT id FROM vehicle_types WHERE code='specialized_transport'), 'by_registry', true, 'Мультилифт/мусоровоз; самосвал исключён'),
  ('worked_list_06_26_06_27', 'Экскаваторы-погрузчики',               'экскаваторы-погрузчики',               (SELECT id FROM vehicle_types WHERE code='excavators'),            'by_registry', true, 'JCB TLT30C фактически вилочный погрузчик')
ON CONFLICT (source_code, normalized_source_name) DO NOTHING;
