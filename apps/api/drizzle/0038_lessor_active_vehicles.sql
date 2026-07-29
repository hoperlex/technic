-- Активность аренды следует за активностью арендодателя (ADR 0018 §15).
--
-- Правило: у неактивного арендодателя не может быть активных предложений аренды. Обратное
-- допустимо — неактивное предложение у активного арендодателя это нормальная пауза по одной
-- позиции. Деактивация арендодателя гасит его технику; активация — не поднимает её обратно,
-- каждая позиция включается осознанно.
--
-- Инвариант физический, а не только сервисный: активность арендодателя денормализована в
-- vehicles.lessor_is_active, синхронизацию держит ON UPDATE CASCADE того же составного FK, а
-- запрет «активная аренда при неактивном арендодателе» — обычный CHECK по строке.

-- 1. Guard: несогласованных строк быть не должно (иначе CHECK ниже не создастся).
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM vehicles v
  JOIN counterparties c ON c.id = v.lessor_id
  WHERE v.ownership = 'rental' AND v.status = 'active' AND NOT c.is_active;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Активные предложения аренды (% шт.) у неактивных арендодателей. Разберите вручную перед применением 0038.', bad;
  END IF;
END $$;

-- 2. Цель расширенного составного FK.
ALTER TABLE counterparties
  ADD CONSTRAINT counterparties_id_type_active_unique UNIQUE (id, type, is_active);

-- 3. Денормализованная активность арендодателя. Значение пишет не приложение, а каскад FK:
--    рассинхронизироваться оно не может (приём vehicles_model_type_fk из ADR 0007 §4).
ALTER TABLE vehicles ADD COLUMN lessor_is_active boolean;
UPDATE vehicles v SET lessor_is_active = c.is_active
FROM counterparties c WHERE c.id = v.lessor_id;

ALTER TABLE vehicles
  -- Все три колонки ключа заполняются вместе: при NULL хотя бы в одной FK (MATCH SIMPLE)
  -- не проверился бы вовсе.
  ADD CONSTRAINT vehicles_lessor_active_pair_check CHECK (
    (lessor_id IS NULL) = (lessor_is_active IS NULL)
  ),
  ADD CONSTRAINT vehicles_rental_lessor_active_check CHECK (
    ownership <> 'rental' OR status <> 'active' OR lessor_is_active
  );

-- 4. Расширяем FK: (id, type) → (id, type, is_active) с каскадом обновления.
--    ON UPDATE CASCADE тянет за собой и смену типа контрагента, но её отобьёт
--    vehicles_lessor_type_check, а раньше него — guard в маршруте контрагентов.
--    Деактивация арендодателя каскадом обновит lessor_is_active всех его строк, и если хоть одна
--    осталась активной — упадёт CHECK из п.3. Поэтому сервис сначала гасит технику, потом
--    контрагента; прямой SQL мимо API получит отказ.
ALTER TABLE vehicles DROP CONSTRAINT vehicles_lessor_fk;
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_lessor_fk
  FOREIGN KEY (lessor_id, lessor_type, lessor_is_active)
  REFERENCES counterparties (id, type, is_active)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- 5. Прежний двухколоночный ключ больше не цель ни одного FK — снимаем, чтобы не держать
--    избыточный индекс с тем же смыслом.
ALTER TABLE counterparties DROP CONSTRAINT counterparties_id_type_unique;

-- Отбор «чья техника погасла вместе с арендодателем» и списки активных предложений.
CREATE INDEX vehicles_lessor_active_idx ON vehicles (lessor_id, status)
  WHERE ownership = 'rental';
