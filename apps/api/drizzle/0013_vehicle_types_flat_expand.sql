-- Плоский классификатор ТС — Фаза 1 (Expand). См. docs/adr/0005-vehicle-types-flatten.md.
-- Аддитивно и обратимо: добавляем 13 плоских типов (утверждённая таблица «Тип ТС») и ремапим
-- существующие заявки на них, НЕ удаляя старые типы/подтипы/колонки/source_mappings — снос в
-- фазе 3 (миграция 0014), когда старых клиентов не останется.
--
-- Дискриминатор плоского типа: parent_id IS NULL AND is_selectable = true — комбинация, ранее
-- запрещённая CHECK'ом vehicle_types_level_selectable_check (его снимаем). Старый тип = (NULL,false),
-- старый подтип = (задан, true) — по этим признакам обе таксономии сосуществуют в одной таблице.

-- 1. Снимаем инвариант уровня, чтобы плоские строки (parent_id NULL, is_selectable true) стали допустимы.
ALTER TABLE vehicle_types DROP CONSTRAINT vehicle_types_level_selectable_check;

-- 2. 13 плоских типов. Коды не пересекаются со старыми (нужно для сосуществования); name — дословно.
INSERT INTO vehicle_types (kind_id, parent_id, code, name, is_selectable, is_active, sort_order) VALUES
  -- Спецтехника (ЭСМ2)
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'truck_cranes',          'Автокраны',                           true, true, 10),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'forklift_miniloaders',  'Вилочные погрузчики и минипогрузчики', true, true, 20),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'pneumatic_wheel_crane', 'Кран пневмоколесный',                 true, true, 30),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'mobile_crane',          'Кран самоходный',                     true, true, 40),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'front_loaders',         'Фронтальные погрузчики',              true, true, 50),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'wheeled_excavators',    'Экскаватор колесный',                 true, true, 60),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'crawler_excavators',    'Экскаваторы гусеничные',              true, true, 70),
  ((SELECT id FROM vehicle_kinds WHERE code='special_equipment'), NULL, 'backhoe_loaders',       'Экскаваторы-погрузчики',              true, true, 80),
  -- Грузоперевозки (4П + 3)
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), NULL, 'light_trucks',          'Грузовые малотоннажные автомобили',   true, true, 10),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), NULL, 'dump_trucks',           'Самосвалы',                           true, true, 20),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), NULL, 'tractor_trailers',      'Тягачи с полуприцепами',              true, true, 30),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), NULL, 'heavy_manipulators',    'Тяжелые манипуляторы',                true, true, 40),
  ((SELECT id FROM vehicle_kinds WHERE code='freight_transport'), NULL, 'passenger_cars',        'Легковые автомобили',                 true, true, 50);

-- 3. Ремап существующих заявок с подтипов на новые плоские типы.
--    Guard: если заявка ссылается на подтип без сопоставления — останавливаемся (осознанный разбор).
DO $$
DECLARE
  unresolved int;
BEGIN
  SELECT count(*) INTO unresolved
  FROM vehicle_requests r
  JOIN vehicle_types old_t ON old_t.id = r.vehicle_type_id
  WHERE old_t.parent_id IS NOT NULL
    AND old_t.code NOT IN (
      'truck_crane','pneumatic_tire_crane','self_propelled_crane',
      'forklift','skid_steer_loader','telescopic_loader','front_loader',
      'wheeled_excavator','crawler_excavator','backhoe_loader',
      'passenger_car','light_truck','tractor_unit',
      'light_kmu_truck','heavy_kmu_truck'
    );
  IF unresolved > 0 THEN
    RAISE EXCEPTION 'Заявки ТС (% шт.) ссылаются на подтипы без сопоставления с плоским типом. Разберите вручную перед применением 0013.', unresolved;
  END IF;
END $$;

UPDATE vehicle_requests r
SET vehicle_type_id = flat.id
FROM vehicle_types old_t
JOIN (VALUES
  ('truck_crane',          'truck_cranes'),
  ('pneumatic_tire_crane', 'pneumatic_wheel_crane'),
  ('self_propelled_crane', 'mobile_crane'),
  ('forklift',             'forklift_miniloaders'),
  ('skid_steer_loader',    'forklift_miniloaders'),
  ('telescopic_loader',    'forklift_miniloaders'),
  ('front_loader',         'front_loaders'),
  ('wheeled_excavator',    'wheeled_excavators'),
  ('crawler_excavator',    'crawler_excavators'),
  ('backhoe_loader',       'backhoe_loaders'),
  ('passenger_car',        'passenger_cars'),
  ('light_truck',          'light_trucks'),
  ('tractor_unit',         'tractor_trailers'),
  ('light_kmu_truck',      'heavy_manipulators'),
  ('heavy_kmu_truck',      'heavy_manipulators')
) AS m(old_code, new_code) ON m.old_code = old_t.code
JOIN vehicle_types flat ON flat.code = m.new_code AND flat.parent_id IS NULL AND flat.is_selectable = true
WHERE old_t.id = r.vehicle_type_id
  AND old_t.parent_id IS NOT NULL;
