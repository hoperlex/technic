-- Вывоз металлолома: пустой предмет заявки и факт закрытия весом (ADR 0067).
--
-- Продолжение 0090, где заведено само значение enum: здесь оно наконец используется.

-- 1. У заявки на металлолом нет предмета.
--
-- Ни контейнера, ни типа мусора, ни объёма, ни цены: заявка говорит «приезжайте забрать», а
-- сколько увезли, отвечает уже закрытие. Запрет строгий — в отличие от замены и снятия, где
-- аналогичный CHECK оставлен мягким (ADR 0019): у тех типов есть заявки, заведённые до решения,
-- и их поля сохранены как есть, а у металлолома унаследованных строк не бывает по определению.
ALTER TABLE waste_requests
  ADD CONSTRAINT waste_requests_metal_no_subject_check
    CHECK (
      request_type <> 'metal_removal'
      OR (
        container_type_id IS NULL
        AND waste_type_id IS NULL
        AND waste_tariff_id IS NULL
        AND price_per_m3 IS NULL
        AND volume_m3 IS NULL
      )
    );

-- 2. Закрытие предъявляет одну величину, и какую — решает тип заявки.
--
-- Мусор меряют объёмом (ADR 0035), металлолом принимают по весу: он стоит в приёмо-сдаточном
-- акте, который и прикладывают талоном. Отдельной колонкой, а не общим «сколько» с единицей
-- рядом: объём умножается на цену прайса, а вес — ни на что, и общая колонка предлагала бы
-- считать тонны по ₽/м³. Точность та же, что у объёма: весы дают килограммы.
ALTER TABLE waste_request_completions
  ADD COLUMN weight_tons numeric(12, 3),
  -- Объём перестаёт быть обязательным: у закрытия по весу его нет вовсе. Заполненность ровно
  -- одной из двух колонок держит CHECK ниже — «ни одной» означало бы закрытие, которое ничего
  -- не предъявило, а «обе» — два ответа на вопрос, сколько увезли.
  ALTER COLUMN volume_m3 DROP NOT NULL,
  ADD CONSTRAINT waste_request_completions_weight_positive_check
    CHECK (weight_tons IS NULL OR weight_tons > 0),
  ADD CONSTRAINT waste_request_completions_measure_check
    CHECK ((volume_m3 IS NOT NULL) <> (weight_tons IS NOT NULL)),
  -- Вес идёт без денег. Цена в прайсе задана за м³ (ADR 0009), и приложить её к тоннам нечем:
  -- сумма рядом с весом означала бы расчёт, которого не было.
  ADD CONSTRAINT waste_request_completions_weight_no_pricing_check
    CHECK (
      weight_tons IS NULL
      OR (price_per_m3 IS NULL AND waste_tariff_id IS NULL AND total_cost IS NULL)
    );
