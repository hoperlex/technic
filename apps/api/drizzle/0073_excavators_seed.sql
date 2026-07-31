-- Экскаваторы собственного парка (ADR 0007, наполнение — ADR 0023) из реестра автотехники,
-- строки 161–176.
--
-- Блок экскаваторов в сид 0028 не попал вовсе: в справочнике нет ни одной машины типов
-- «Экскаватор колесный», «Экскаваторы гусеничные» и «Экскаваторы-погрузчики», хотя сами типы
-- заведены с самого начала (0010, 0013). Шестнадцать машин — это весь блок реестра, а не выборка
-- из него.
--
-- Решения по строкам:
--
-- 1. Тип берётся из колонки «Наименование», кроме одной строки. «Экскаватор-погрузчик CAT 320DLN»
--    заведён гусеничным экскаватором: марка в том же реестре записана «Экскаватор CAT 320DLN»,
--    заводской номер начинается с CAT0320D, а налоговая база — 140 л.с. против 94 л.с. у соседней
--    строки с настоящим погрузчиком CAT 432E. Три признака против одного слова в наименовании;
--    строка сама себе противоречит, и разрешается она в пользу машины, а не формулировки.
--
-- 2. Категория (ТТХ) не проставляется ни одной машине. У экскаваторов-погрузчиков характеристик
--    нет вовсе — тип сам является конечной классификацией (ADR 0023 §9, привязки в 0045). У
--    колёсных и гусеничных ТТХ — эксплуатационная масса, которой нет ни в реестре, ни в паспорте
--    самоходной машины; выводить её из каталога по индексу модели значит придумать значение
--    (ADR 0023 §14). На работоспособность это не влияет: технику на заявку подбирают по типу, а
--    категория осталась предупреждением (ADR 0045 §1).
--
-- 3. Одна модель на две записи «CASE WX185» и «CASE WX 185»: в реестре одна и та же машина
--    записана по-разному (строки 163 и 164). Нормализация имени пробел не схлопывает, поэтому
--    буквальный перенос развёл бы физически одну модель на две записи — то, что миграция 0043
--    потом разбирала руками. Изготовитель у машины при этом остаётся дословным: у семи JCB 5CX
--    четыре написания одного завода, и сводить их — работа справочника, а не сида (ADR 0023 §15).
--
-- 4. Код вида ТС (57001/57000) и налоговая база в модель не заводятся: первое — классификатор ФНС,
--    второе — мощность двигателя для транспортного налога. Ни того, ни другого в схеме нет, и
--    заводить поля ради сида нельзя.
--
-- 5. Заводской номер строки 169 восстановлен до JCB5CX4WC02261526. В исходной строке он на один
--    знак короче остальных шести JCB (16 против 17) и без «4» в позиции, где она есть у всех
--    машин серии. Реконструкция отмечена здесь именно потому, что она реконструкция: сверить по
--    паспорту самоходной машины.
--
-- Идемпотентность: сид не знает, завёл ли кто-то эти машины руками через справочник, поэтому
-- вставляются только госномера, которых нет среди живых записей. Повторный накат на базу, где
-- машина уже есть, не создаёт дубля и не трогает заведённое.

-- ── 1. Марки/модели ─────────────────────────────────────────────────────────────────────────
INSERT INTO vehicle_models (vehicle_type_id, name, manufacturer_name)
SELECT t.id, x.name, x.manufacturer
FROM (VALUES
  ('crawler_excavators', 'Case CX210B',       'SUMITOMO CONSTRUCTION MACHINERY CO., LTD'),
  ('crawler_excavators', 'JCB JS200NLCT2',    'J.C.B.HEAVY PRODUCTS LTD'),
  ('crawler_excavators', 'CAT 320DLN',        'Катерпиллар инк.'),
  ('wheeled_excavators', 'CASE WX185',        'CNH ITALIA S.P.A'),
  ('backhoe_loaders',    'Case 580T',         'CNH ITALIA'),
  ('backhoe_loaders',    'CAT 432E',          'Катерпиллар инк.'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'Ж.С. БАМФОРД ЭКСКАВАТОРС ЛИМИТЕД'),
  ('backhoe_loaders',    'Komatsu WB97S-5E0', 'KOMATSU UTILITY EUROPE S.P.A')
) AS x(type_code, name, manufacturer)
JOIN vehicle_types t ON t.code = x.type_code
ON CONFLICT (vehicle_type_id, normalized_name) DO NOTHING;

-- ── 2. Машины ───────────────────────────────────────────────────────────────────────────────
-- Порядок колонок повторяет реестр: тип, марка, госномер, инвентарный, заводской, паспорт,
-- изготовитель, дата выпуска. Инвентарный номер есть только у трёх машин — так в источнике;
-- дата выпуска у большинства строк известна лишь годом и записана 1 января, как в сиде 0028.
INSERT INTO vehicles (
  vehicle_type_id, vehicle_model_id, ownership, registration_number, inventory_number,
  serial_number, passport_number, manufacturer_name, manufactured_on, status, source_name
)
SELECT
  t.id,
  m.id,
  'own'::vehicle_ownership,
  x.reg,
  x.inv,
  x.serial,
  x.passport,
  x.manufacturer,
  x.made_on::date,
  'active'::vehicle_status,
  'Реестр автотехники, строки 161–176 (экскаваторы)'
FROM (VALUES
  ('crawler_excavators', 'Case CX210B',       'ХО 4568 50', NULL,       'DCH200R5NBEAJ1319', 'ТС 517224',     'SUMITOMO CONSTRUCTION MACHINERY CO., LTD', '2011-01-01'),
  ('crawler_excavators', 'JCB JS200NLCT2',    'ХО 4567 50', NULL,       'JCBJS20CV01783376', 'ТТ 375715',     'J.C.B.HEAVY PRODUCTS LTD',                 '2014-02-27'),
  ('wheeled_excavators', 'CASE WX185',        'ХО 4569 50', '00001885', 'NSUWX185N7LB01990', 'RU СВ 276338',  'CNH ITALIA S.P.A',                         '2007-01-01'),
  ('wheeled_excavators', 'CASE WX185',        'ХО4571 50',  '00001884', 'N7LB01444',         'RU СВ 276339',  'CNH ITALIA S.P.A',                         '2007-01-01'),
  ('backhoe_loaders',    'Case 580T',         'ХО7732 50',  NULL,       'FNH0580TNBHH05248', 'RU СВ 276368',  'CNH ITALIA',                               '2011-01-01'),
  ('backhoe_loaders',    'Case 580T',         'ХО7758 50',  NULL,       'FNH0580TNBHH05205', 'RU СВ 276372',  'CNH ITALIA',                               '2011-01-01'),
  ('crawler_excavators', 'CAT 320DLN',        'ХО7754 50',  NULL,       'CAT0320DCWBN00156', 'ТС 087040',     'Катерпиллар инк.',                         '2008-01-01'),
  ('backhoe_loaders',    'CAT 432E',          'ХО7799 50',  NULL,       'CAT0432EKBXE03634', 'ТС 086583',     'Катерпиллар инк.',                         '2008-01-01'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО 4496 50', NULL,       'JCB5CX4WC02261526', 'ТТ 409334',     'Ж.С. БАМФОРД ЭКСКАВАТОРС ЛИМИТЕД',         '2014-01-01'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО 4497 50', NULL,       'JCB5CX4WV02261504', 'ТТ 409318',     'Ж.С. БАМФОРД ЭКСКАВАТОРС ЛИМИТЕД',         '2014-02-10'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО 4573 50', NULL,       'JCB5CX4WP02262002', 'ТТ 454559',     'Ж.С. БАМФОРД ЭКСКАВАТОРС ЛИМИТЕД',         '2014-01-01'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО4574 50',  NULL,       'JCB5CX4WE02255899', 'ТС 782494',     'J.C BAMFORD EXCAVATOR LIMITED',            '2013-01-01'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО 4575 50', NULL,       'JCB5CX4WA02255963', 'ТС 782498',     'J.C BAMFORD EXCAVATORS LIMITED',           '2013-01-01'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО7730 50',  NULL,       'JCB5CX4WV02261969', 'ТТ 375264',     'J.C.BAMFORD EXCAVATORS LIMITED',           '2014-02-27'),
  ('backhoe_loaders',    'JCB 5CX 15H2WA',    'ХО7768 50',  NULL,       'JCB5CX4WK02258100', 'ТС 188231',     'J.C BAMFORD EXCAVATORS LIMITED',           '2013-01-01'),
  ('backhoe_loaders',    'Komatsu WB97S-5E0', 'ХМ 0754 50', '00-002249', 'F31082',           'ТТ 284548',     'KOMATSU UTILITY EUROPE S.P.A',             '2013-09-27')
) AS x(type_code, model_name, reg, inv, serial, passport, manufacturer, made_on)
JOIN vehicle_types t ON t.code = x.type_code
JOIN vehicle_models m
  ON m.vehicle_type_id = t.id AND m.normalized_name = vehicle_model_normalize(x.model_name)
WHERE NOT EXISTS (
  SELECT 1 FROM vehicles v
  WHERE v.registration_number_normalized = vehicle_reg_normalize(x.reg)
    AND v.deleted_at IS NULL
);
