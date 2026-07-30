-- Какая категория прав нужна, чтобы сесть за машину (ADR 0037).
--
-- ADR 0008 замыкал допуск на тип ТС: реестра машин тогда не было, и заявка ссылалась только на
-- тип. Сейчас в работу берут конкретную машину (ADR 0027), а категория определяется её
-- разрешённой максимальной массой, а не типом: в «Грузовых малотоннажных» живут и ГАЗель 3,5 т
-- (нужна B), и HINO 300 7,5 т (нужна C). Требование поэтому стоит у машины; у типа остаётся
-- значение по умолчанию — им заполняют реквизит новой машины, а не отбирают водителя.
--
-- Ссылка идёт на `qualification_categories` без привязки к виду документа намеренно: за
-- экскаватор садятся по удостоверению тракториста-машиниста, и когда очередь дойдёт до ЭСМ
-- (ADR 0037, backlog), та же колонка примет категорию другого вида документа. Вид определяет
-- сама категория — второй колонки для этого не нужно.

ALTER TABLE vehicles
  ADD COLUMN required_qualification_category_id uuid
    REFERENCES qualification_categories (id) ON DELETE RESTRICT;

ALTER TABLE vehicle_types
  ADD COLUMN default_qualification_category_id uuid
    REFERENCES qualification_categories (id) ON DELETE RESTRICT;

-- Под отбор водителей: «кто может сесть за эту машину» спрашивают при каждом переводе заявки
-- в работу, и требование машины — вход этого запроса.
CREATE INDEX vehicles_required_category_idx ON vehicles (required_qualification_category_id)
  WHERE required_qualification_category_id IS NOT NULL;

-- 1. Значения по умолчанию для типов вида «Грузоперевозки» — те, на которые выписывается
--    путевой лист 4-П (ADR 0037). Спецтехника не заполняется: за неё садятся по удостоверению
--    тракториста-машиниста, а его категории ещё не заведены.
UPDATE vehicle_types t
SET default_qualification_category_id = qc.id
FROM qualification_categories qc
JOIN credential_types ct ON ct.id = qc.credential_type_id AND ct.code = 'driver_license'
WHERE t.default_qualification_category_id IS NULL
  AND (
    (t.code IN ('dump_trucks', 'heavy_manipulators', 'flatbed_trucks', 'light_trucks') AND qc.code = 'c')
    OR (t.code = 'tractor_trailers' AND qc.code = 'ce')
    OR (t.code = 'passenger_cars' AND qc.code = 'b')
  );

-- 2. Требование конкретным машинам — только там, где тип отвечает за него однозначно.
--    «Грузовые малотоннажные» намеренно пропущены: в них и ГАЗель под категорию B, и HINO 300
--    под C, и разложить их может только человек по паспорту машины. NULL здесь безопасен —
--    незаполненное требование отбор не сужает (ADR 0037), а неверно проставленное отсекло бы
--    от машины годного водителя.
UPDATE vehicles v
SET required_qualification_category_id = t.default_qualification_category_id
FROM vehicle_types t
WHERE v.vehicle_type_id = t.id
  AND v.required_qualification_category_id IS NULL
  AND t.default_qualification_category_id IS NOT NULL
  AND t.code <> 'light_trucks';
