-- Цветность печати по парку МФУ (план `docs/office-equipment-specs-plan.md`, этап Э5).
-- Вторая миграция выката: схему и саму характеристику завела `0252`, здесь только значения.
--
-- ОТКУДА НОМЕР. Файл начинался номером `0253`, но пока шла работа, соседний поток занял его
-- `0253_releases_mech_models.sql` (справочник моделей механизации) — обычное дело: номера миграций
-- раздаются в дереве, а потоков в нём несколько. Номер уступлен, файл переименован в `0254`;
-- проверено `ls apps/api/drizzle/*.sql` перед переименованием (03.09.2026).
--
-- ОТКУДА ДАННЫЕ. Заказчик просил найти их самостоятельно: в таблице ИТ-службы, из которой вырос
-- парк (сид `0143`), цветности нет вовсе. По каждой из 39 моделей смотрелась спецификация
-- производителя; сводка с числом карточек — в §10 плана. Значение — про ПЕЧАТЬ (Р7): цветной
-- сканер чёрно-белого аппарата цветным его не делает, иначе «цв.» получил бы почти весь парк.
--
-- Цветных 6 моделей (45 карточек):
--   * Ricoh Aficio MP C2011SP (33) — A3 colour MFP, 20 ppm в цвете и ч/б;
--   * Ricoh M C2000 (8) — A3 colour MFP;
--   * Ricoh Green MP C6004 (1) — GreenLine (восстановленная Ricoh), MP C6004 — colour laser MFP;
--   * HP OfficeJet Pro 9010 (1) — цветной струйный AiO, 18 ppm в цвете;
--   * HP LaserJet CM 1312 (1) — HP Color LaserJet CM1312 MFP, 12 ppm ч/б и 8 ppm цвет;
--   * Epson Expression Premium XP-820 (1) — пять картриджей CMYK + Photo Black.
--
-- Остальные 32 модели (307 карточек) — чёрно-белые: серии Ricoh «MFP black and white» (Aficio MP
-- 201SPF/301SP/301SPF, IM 350/550F/2702, M 2701, SP 230SFNw), монохромные A3-семейства Aficio MP
-- 1600/2000/2001/2501/2014, широкоформатный MP W6700SP (A1, 6,7 копии/мин), Pantum M65xx/M66xx
-- («Mono laser multifunction printer» в каталоге производителя), Brother DCP-1602R, Kyocera ECOSYS
-- M2235dn/M2540dn, монохромные HP (Neverstop Laser 1200w, Laser 135r, LaserJet M1120n, LaserJet
-- Pro M428fdn) и Canon i-SENSYS MF4550d/MF4330d.
--
-- К СВЕРКЕ ГЛАЗАМИ (грузится как «н/д», значение проставят в портале):
--
--   * **Ricoh Aficio MP 2051AD** (1 карточка) — модели с таким именем в каталоге Ricoh не
--     подтверждается. Рядом стоят ЦВЕТНАЯ MP C2051 (A3, 20 ppm) и МОНОХРОМНЫЕ MP 2550/2555, и
--     какая из них записана в таблице ИТ-службы, из имени не выводится. Догадка здесь дороже дыры
--     (Р13): по этой строке решают, куда нести цветной документ, — пустое поле человек проверит, а
--     неверное нет.
--
-- ЗАМЕЧЕНО ПОПУТНО, НЕ ЧИНИТСЯ: «Ricoh MP W6700SP» и «Ricoh Aficio MP W6700SP» — один и тот же
-- широкоформатный аппарат двумя написаниями, две отдельные модели справочника. Цветность у обеих
-- одна, на показ это не влияет; слияние моделей — отдельный разговор со своей миграцией.
--
-- ПОЧЕМУ СОПОСТАВЛЕНИЕ ПО КЛЮЧУ НАПИСАНИЯ. `office_equipment_model_key` — та же функция, что стоит
-- в уникальном индексе справочника (0171): регистр и повторные пробелы модель не различают, и
-- список здесь не обязан повторять написание базы знак в знак. Своей нормализации в этом файле
-- нет намеренно — она была бы второй копией правила.
--
-- ИДЕМПОТЕНТНОСТЬ. `ON CONFLICT DO NOTHING`: если значение у модели уже стоит (проставили в
-- портале до выката), миграция его не трогает — человек знает про свой аппарат больше, чем список
-- из спецификаций.
--
-- ОБРАТИМОСТЬ. Только строки значений; откат — `DELETE FROM office_equipment_model_specs`.

DROP TABLE IF EXISTS pg_temp.seed_print_color;
CREATE TEMP TABLE seed_print_color (model_name text, value_code text) ON COMMIT DROP;

INSERT INTO seed_print_color VALUES
  ('Ricoh Aficio MP C2011SP'        , 'color'),
  ('Ricoh M C2000'                  , 'color'),
  ('Ricoh Green MP C6004'           , 'color'),
  ('HP OfficeJet Pro 9010'          , 'color'),
  ('HP LaserJet CM 1312'            , 'color'),
  ('Epson Expression Premium XP-820', 'color'),
  ('Ricoh Aficio MP 201SPF'         , 'mono'),
  ('Ricoh Aficio MP 301SP'          , 'mono'),
  ('Ricoh Aficio MP 301SPF'         , 'mono'),
  ('Ricoh Aficio MP 2000'           , 'mono'),
  ('Ricoh Aficio MP 2000SP'         , 'mono'),
  ('Ricoh Aficio MP 2000LN'         , 'mono'),
  ('Ricoh Aficio MP 2001SP'         , 'mono'),
  ('Ricoh Aficio MP 2501SP'         , 'mono'),
  ('Ricoh Aficio MP 1600L'          , 'mono'),
  ('Ricoh Aficio 2014AD'            , 'mono'),
  ('Ricoh IM 350'                   , 'mono'),
  ('Ricoh IM 550F'                  , 'mono'),
  ('Ricoh IM 2702'                  , 'mono'),
  ('Ricoh M 2701'                   , 'mono'),
  ('Ricoh SP 230SFNw'               , 'mono'),
  ('Ricoh MP W6700SP'               , 'mono'),
  ('Ricoh Aficio MP W6700SP'        , 'mono'),
  ('Pantum M6500'                   , 'mono'),
  ('Pantum M6502'                   , 'mono'),
  ('Pantum M6507'                   , 'mono'),
  ('Pantum M6550NW'                 , 'mono'),
  ('Pantum M6552NW'                 , 'mono'),
  ('Pantum M6607NW'                 , 'mono'),
  ('Brother DCP-1602R'              , 'mono'),
  ('Kyocera ECOSYS M2235DN'         , 'mono'),
  ('Kyocera ECOSYS M2540DN'         , 'mono'),
  ('HP Neverstop Laser 1200W MFP'   , 'mono'),
  ('HP Laser 135r'                  , 'mono'),
  ('HP LaserJet M 1120n MFP'        , 'mono'),
  ('HP LaserJet Pro MFP M428fdn'    , 'mono'),
  ('Canon i-Sensys MF 4550D'        , 'mono'),
  ('Canon i-Sensys MF 4330D'        , 'mono');

-- Только модели МФУ: список собран по парку МФУ, и одноимённая модель принтера (появись она
-- завтра) значения отсюда не получает — про её печать этот файл ничего не знает.
INSERT INTO office_equipment_model_specs (model_id, equipment_type_id, spec_id, value_id)
SELECT m.id, m.equipment_type_id, s.id, v.id
  FROM seed_print_color sc
  JOIN office_equipment_types t
    ON t.code = 'mfp'
  JOIN office_equipment_models m
    ON m.equipment_type_id = t.id
   AND office_equipment_model_key(m.name) = office_equipment_model_key(sc.model_name)
  JOIN office_equipment_specs s
    ON s.code = 'print_color'
  JOIN office_equipment_spec_values v
    ON v.spec_id = s.id AND v.code = sc.value_code
ON CONFLICT (model_id, spec_id) DO NOTHING;

-- Караул сида: сколько моделей парка осталось без значения. Не отказ — на пустой базе (db-тесты,
-- новый стенд) моделей нет вовсе, и падать тут не на чем. Но в проде число обязано читаться в
-- логе выката: план обещает ровно одну строку к сверке, и вторая означала бы, что справочник
-- разошёлся со списком — например, модель успели переименовать.
DO $$
DECLARE
  total int;
  filled int;
BEGIN
  SELECT count(*) INTO total
    FROM office_equipment_models m
    JOIN office_equipment_types t ON t.id = m.equipment_type_id AND t.code = 'mfp';
  SELECT count(*) INTO filled
    FROM office_equipment_model_specs ms
    JOIN office_equipment_specs s ON s.id = ms.spec_id AND s.code = 'print_color'
    JOIN office_equipment_models m ON m.id = ms.model_id
    JOIN office_equipment_types t ON t.id = m.equipment_type_id AND t.code = 'mfp';
  RAISE NOTICE 'Цветность печати: заполнено % моделей МФУ из %, без значения — %',
    filled, total, total - filled;
END $$;
