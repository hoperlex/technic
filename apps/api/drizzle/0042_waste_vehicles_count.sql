-- Факт вывоза: «тип × количество» вместо перечня рейсов, талоны — общим пулом заявки (ADR 0024).
--
-- До этого строка таблицы была одним рейсом, и к каждому требовался свой талон (ADR 0011,
-- ADR 0020). В работе так не отчитываются: оператор говорит «два самосвала 25 м³ и контейнер
-- 8 м³», а бумаги отдаёт пачкой за всё закрытие — какой талон про какой рейс, из самого талона
-- не следует. Поэтому строка получает количество, а талоны переезжают к заявке, где у
-- контейнерных операций они уже живут (ADR 0013).
--
-- Заодно строка несёт снимок цены по прайсу: сумма закрытой заявки считается по машинам, а не
-- по заявленному объёму (план остаётся в самой заявке). Снимок — по тому же принципу, что и в
-- waste_requests: правка прайса не переписывает суммы уже закрытых заявок.

-- 1. Количество машин в строке. Существующим строкам — 1: каждая была одним рейсом, и общий
--    объём заявки от этого не меняется.
ALTER TABLE waste_request_vehicles
  ADD COLUMN vehicle_count integer NOT NULL DEFAULT 1;

ALTER TABLE waste_request_vehicles
  ADD CONSTRAINT waste_request_vehicles_count_check CHECK (vehicle_count BETWEEN 1 AND 99);

-- 2. Снимок цены строки и её сумма. Сумма — GENERATED: производная от вместимости, количества
--    и цены не может с ними разойтись (тем же приёмом считается amount у самой заявки).
--    У строк, заведённых до этой миграции, тарифа не было — цена остаётся NULL, и сумма тоже:
--    закрытая раньше заявка сохраняет свою плановую стоимость, а факт по ней не досчитывается.
ALTER TABLE waste_request_vehicles
  ADD COLUMN waste_tariff_id uuid REFERENCES waste_tariffs (id) ON DELETE RESTRICT,
  ADD COLUMN price_per_m3 numeric(12, 2);

-- Отдельным шагом: выражение GENERATED ссылается на колонки, добавленные выше, — в одном
-- ALTER TABLE они ещё не существуют для разбора выражения.
ALTER TABLE waste_request_vehicles
  ADD COLUMN amount numeric(14, 2)
    GENERATED ALWAYS AS (round(volume_m3 * vehicle_count * price_per_m3, 2)) STORED;

ALTER TABLE waste_request_vehicles
  -- Тариф и цена только вместе: цена без тарифа — сумма, происхождение которой не проверить.
  ADD CONSTRAINT waste_request_vehicles_price_snapshot_check CHECK (
    (waste_tariff_id IS NULL) = (price_per_m3 IS NULL)
  ),
  ADD CONSTRAINT waste_request_vehicles_price_positive_check CHECK (
    price_per_m3 IS NULL OR price_per_m3 > 0
  );

-- 3. Талоны машин переезжают к своим заявкам (request_files, kind='ticket'). Файлы при этом не
--    трогаются: меняется только то, к чему они привязаны. DISTINCT — на случай, если один файл
--    оказался у двух машин одной заявки; ON CONFLICT — если он уже привязан к самой заявке.
INSERT INTO request_files (request_id, file_id, kind)
SELECT DISTINCT v.request_id, vf.file_id, 'ticket'
FROM waste_request_vehicle_files vf
JOIN waste_request_vehicles v ON v.id = vf.vehicle_id
ON CONFLICT (request_id, file_id) DO NOTHING;

-- Проверка переноса: ни один талон не должен остаться без связи с заявкой — иначе DROP ниже
-- потерял бы бумагу, по которой заявку принимали.
DO $$
DECLARE lost int;
BEGIN
  SELECT count(*) INTO lost
  FROM waste_request_vehicle_files vf
  JOIN waste_request_vehicles v ON v.id = vf.vehicle_id
  LEFT JOIN request_files rf ON rf.request_id = v.request_id AND rf.file_id = vf.file_id
  WHERE rf.file_id IS NULL;
  IF lost > 0 THEN
    RAISE EXCEPTION 'Талоны машин не перенесены к заявкам (осталось: %)', lost;
  END IF;
END $$;

DROP TABLE waste_request_vehicle_files;
