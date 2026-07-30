-- Факт вывоза: фактический объём и стоимость вместо перечня машин (ADR 0035).
--
-- Закрытие заявки на вывоз до сих пор строилось как состав техники: строки «тип машины ×
-- количество», объём — из вместимости типа, цена — из прайса для этого типа (ADR 0011, ADR 0024).
-- В работе так не отчитываются. Оператор называет вывезенный объём — он и стоит в талоне и в
-- весовой квитанции, — а какими машинами его увезли, к расчёту отношения не имеет: вывоз
-- тарифицируется самосвалами (ADR 0022), и цена в прайсе задана на вид техники, а не на модель.
--
-- Подбор цены по конкретному типу к тому же упирался в незаполненный прайс: контейнерная строка
-- у оператора могла быть не заведена, и закрытие падало отказом «для «Контейнер 8 м³» цена не
-- задана». Заявка при этом выполнена — мусор вывезен, талон на руках, — а портал требовал
-- сначала править справочник. Поэтому цены здесь достаточно как основания расчёта: нет её —
-- сумму вводят руками, и закрытие не останавливается.
--
-- Форма — та же, что у факта заявки ТС (ADR 0029, миграция 0053): одна строка на заявку, сумма
-- считается по прайсу и правится свободно. Счёт оператора включает и подачу, и недогруз, и
-- сходиться сумма должна со счётом, а не с формулой.

CREATE TABLE waste_request_completions (
  -- Одна заявка — одно закрытие: повторное (после отката администратором) переписывает строку,
  -- двух фактов об одном вывозе не бывает.
  request_id uuid PRIMARY KEY REFERENCES waste_requests (id) ON DELETE CASCADE,
  -- Сколько вывезли по факту. Дробный: объём берут из талона и весовой квитанции, а не из
  -- вместимости кузова. С заявленным объёмом (waste_requests.volume_m3) расходится законно —
  -- заявка это план (ADR 0011), сверка остаётся подсказкой человеку.
  volume_m3 numeric(12, 3) NOT NULL,
  -- Цена за м³ на момент закрытия — снимок прайса по виду «Самосвал» (ADR 0022, ADR 0026):
  -- сумма обязана объясняться сама, а правка прайса не должна переписывать закрытые заявки.
  -- NULL — цены в прайсе не было, и сумму указали руками (или не указали вовсе).
  price_per_m3 numeric(12, 2),
  waste_tariff_id uuid REFERENCES waste_tariffs (id) ON DELETE RESTRICT,
  -- Итог. Подставляется расчётом «объём × цена», но правится свободно: сумма в заявке должна
  -- сходиться со счётом оператора. NULL — считать было нечем и руками не ввели: вывоз состоялся,
  -- а цену на этот тип мусора в прайсе ещё не завели.
  total_cost numeric(14, 2),
  completed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Нулевого вывоза не бывает; цена положительна там, где задана; сумма может быть и нулевой
  -- (вывоз в счёт другой работы), но не отрицательной.
  CONSTRAINT waste_request_completions_volume_positive_check CHECK (volume_m3 > 0),
  CONSTRAINT waste_request_completions_price_positive_check CHECK (
    price_per_m3 IS NULL OR price_per_m3 > 0
  ),
  CONSTRAINT waste_request_completions_total_cost_positive_check CHECK (
    total_cost IS NULL OR total_cost >= 0
  ),
  -- Тариф без цены — ссылка на прайс, которая ничего не объясняет. Обратное допустимо: цена
  -- без тарифа означает «взяли не из прайса» (его там нет), и это законное состояние.
  CONSTRAINT waste_request_completions_price_snapshot_check CHECK (
    waste_tariff_id IS NULL OR price_per_m3 IS NOT NULL
  )
);

-- «Что закрыли за период и на какую сумму» — тем же порядком, что и у заявок ТС.
CREATE INDEX waste_request_completions_completed_at_idx
  ON waste_request_completions (completed_at DESC);

-- Перенос уже предъявленного факта: у заявок с машинами он есть, и терять его нельзя — по этим
-- цифрам заявки принимали. Сами строки машин остаются на месте (таблица не удаляется): состав
-- техники прошлых закрытий виден в истории заявки, новых строк там больше не появляется.
INSERT INTO waste_request_completions (
  request_id, volume_m3, price_per_m3, waste_tariff_id, total_cost, completed_by, completed_at
)
SELECT
  v.request_id,
  v.volume_m3,
  v.price_per_m3,
  v.waste_tariff_id,
  v.total_cost,
  -- Кто закрыл: по переходу в «Выполнена», иначе — кто завёл строки (машины можно было завести
  -- и правкой незакрытой заявки). Автор заявки — последний рубеж: колонка NOT NULL, а
  -- created_by у строки машины обнуляется при удалении учётки.
  COALESCE(done.changed_by, v.created_by, r.created_by),
  COALESCE(done.changed_at, v.last_at)
FROM (
  SELECT
    request_id,
    -- Помеченные на удаление в факт не входили — не входят и здесь.
    sum(volume_m3 * vehicle_count) AS volume_m3,
    -- Цена одна на закрытие. У строк разных типов техники она разная, и одним числом её не
    -- выразить: тогда цена остаётся пустой, а сумма переносится ровно та, по которой принимали.
    CASE
      WHEN count(DISTINCT price_per_m3) = 1 AND bool_and(price_per_m3 IS NOT NULL)
      THEN min(price_per_m3)
    END AS price_per_m3,
    CASE
      WHEN count(DISTINCT waste_tariff_id) = 1
       AND count(DISTINCT price_per_m3) = 1
       AND bool_and(price_per_m3 IS NOT NULL)
      THEN (array_agg(DISTINCT waste_tariff_id))[1]
    END AS waste_tariff_id,
    -- Сумма — та же, что показывал портал: сложение готовых amount строк. Нет цены хотя бы у
    -- одной — суммы нет вовсе: неполная выглядела бы как полная.
    CASE WHEN bool_and(price_per_m3 IS NOT NULL) THEN sum(amount) END AS total_cost,
    -- Кто и когда завёл последнюю строку — запасной ответ на «кто закрыл», если перехода в
    -- «Выполнена» в истории нет.
    (array_agg(created_by ORDER BY created_at DESC))[1] AS created_by,
    max(created_at) AS last_at
  FROM waste_request_vehicles
  WHERE deleted_at IS NULL
  GROUP BY request_id
) v
JOIN waste_requests r ON r.id = v.request_id
LEFT JOIN LATERAL (
  SELECT h.changed_by, h.changed_at
  FROM request_status_history h
  WHERE h.request_id = v.request_id AND h.to_status = 'done'
  ORDER BY h.changed_at DESC
  LIMIT 1
) done ON true;

-- Проверка переноса: у каждой заявки с активными машинами должен появиться факт — иначе
-- закрытая заявка осталась бы без объёма и суммы, по которым её принимали.
DO $$
DECLARE lost int;
BEGIN
  SELECT count(*) INTO lost
  FROM (
    SELECT DISTINCT request_id FROM waste_request_vehicles WHERE deleted_at IS NULL
  ) v
  LEFT JOIN waste_request_completions c ON c.request_id = v.request_id
  WHERE c.request_id IS NULL;
  IF lost > 0 THEN
    RAISE EXCEPTION 'Факт вывоза перенесён не полностью (заявок без факта: %)', lost;
  END IF;
END $$;
