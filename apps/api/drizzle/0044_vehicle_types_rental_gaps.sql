-- Типы ТС, которых не хватило для аренды (ADR 0023).
--
-- Плоский классификатор (ADR 0005) собирался по собственному парку: в бухвыгрузке не было ни
-- автовышек, ни ямобуров, ни компрессоров — своей такой техники нет. В прайсах арендодателей она
-- есть, а тип у предложения аренды обязателен (`vehicles.vehicle_type_id NOT NULL`), поэтому без
-- этих шести строк 22 позиции протокола не заводятся вовсе.
--
-- Вид определяется так же, как в 0016 для катков: строительная машина — «Спецтехника»,
-- перевозящая груз по дорогам — «Грузоперевозки». Бортовой автомобиль отделён от «Грузовых
-- малотоннажных» намеренно: в прайсе есть борт 10 и 20 т, малотоннажными их не назвать, а
-- борт 1,5 т остаётся в прежнем типе.
--
-- sort_order продолжает существующие ряды: спецтехника — после катков (90), грузоперевозки —
-- после легковых (50).
--
-- Идемпотентно по `code` (vehicle_types_code_unique).
INSERT INTO vehicle_types (kind_id, code, name, is_active, sort_order) VALUES
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'aerial_platforms',  'Автовышки (АГП)',       true, 100),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'drilling_rigs',     'Ямобуры',               true, 110),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'compressors',       'Компрессоры',           true, 120),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'bulldozers',        'Бульдозеры',            true, 130),
  ((SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'), 'watering_machines', 'Поливомоечные машины',  true, 140),
  ((SELECT id FROM vehicle_kinds WHERE code = 'freight_transport'), 'flatbed_trucks',    'Бортовые автомобили',   true,  60)
ON CONFLICT (code) DO NOTHING;
