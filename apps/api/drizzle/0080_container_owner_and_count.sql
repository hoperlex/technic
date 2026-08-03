-- Владелец контейнера на площадке и количество контейнеров в заявке.
--
-- До сих пор присутствие контейнеров считалось по паре «объект + тип контейнера» (view
-- present_containers, миграция 0007): установки минус снятия, FIFO по номеру заявки. Кто
-- контейнер привёз, в этой картине не участвовал вовсе — и поэтому снятие оператором Б молча
-- гасило установку оператора А, а спросить «чьи контейнеры сейчас на объекте» было не у кого.
--
-- Отдельной сущности «контейнер» не заводим: её пробовали дважды и дважды убрали (0002 → 0003 →
-- 0004). Владельцем единицы считается оператор её заявки установки, а присутствие — тройкой
-- «объект + тип + владелец». Единицы внутри тройки взаимозаменяемы, и FIFO по номеру остаётся
-- ровно тем же, чем был, — только внутри своей группы.
--
-- Две новых колонки заявки:
--   containers_count — сколько контейнеров снимает или меняет одна заявка. Только у этих двух
--     типов: у установки остаётся «одна заявка — один контейнер», иначе строка присутствия
--     перестала бы быть одним контейнером, а FIFO пришлось бы разворачивать по единицам.
--   container_owner_counterparty_id — ЧЕЙ контейнер снимаем. Не выводится из оператора заявки:
--     вывоз чужого контейнера бывает (оператор ушёл с площадки, контейнеры передали) и
--     разрешается подтверждением, но погасить он обязан единицу настоящего владельца. Иначе
--     контейнер прежнего оператора зависнет на площадке навсегда, а новый уйдёт в минус —
--     учёт соврал бы ровно там, где человек честно отметил исключение.

-- 1. Колонки и их инварианты.
ALTER TABLE waste_requests
  ADD COLUMN containers_count integer NOT NULL DEFAULT 1,
  ADD COLUMN container_owner_counterparty_id uuid REFERENCES counterparties (id) ON DELETE RESTRICT;

ALTER TABLE waste_requests
  -- Потолок — не бизнес-правило, а защита от опечатки: сколько можно снять на самом деле,
  -- ограничено присутствием на объекте, и это проверяет сервер по view.
  ADD CONSTRAINT waste_requests_containers_count_check
    CHECK (containers_count BETWEEN 1 AND 20),
  ADD CONSTRAINT waste_requests_containers_count_type_check
    CHECK (containers_count = 1 OR request_type IN ('container_replace', 'container_removal')),
  ADD CONSTRAINT waste_requests_container_owner_type_check
    CHECK (container_owner_counterparty_id IS NULL
           OR request_type IN ('container_replace', 'container_removal'));

COMMENT ON COLUMN waste_requests.containers_count IS
  'Сколько контейнеров снимает/меняет заявка; у остальных типов всегда 1';
COMMENT ON COLUMN waste_requests.container_owner_counterparty_id IS
  'Чей контейнер снимаем/меняем: оператор заявки установки. NULL — владелец не известен';

CREATE INDEX waste_requests_container_owner_idx
  ON waste_requests (object_id, container_type_id, container_owner_counterparty_id)
  WHERE request_type IN ('container_replace', 'container_removal');

-- 2. Владелец у заведённых заявок.
--
-- Снятия обязаны сохранить нынешний смысл: до этой миграции k-е снятие пары (по num) гасило
-- k-ю установку той же пары, и после неё те же самые единицы должны гаситься внутри тройки.
-- Не перенести владельца — значит «воскресить» часть контейнеров на площадках и увести часть
-- групп в минус.
WITH ranked_installs AS (
  SELECT
    id,
    object_id,
    container_type_id,
    operator_counterparty_id,
    row_number() OVER (PARTITION BY object_id, container_type_id ORDER BY num) AS rn
  FROM waste_requests
  WHERE request_type = 'container_install'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
),
ranked_removals AS (
  SELECT
    id,
    object_id,
    container_type_id,
    row_number() OVER (PARTITION BY object_id, container_type_id ORDER BY num) AS rn
  FROM waste_requests
  WHERE request_type = 'container_removal'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
)
UPDATE waste_requests w
SET container_owner_counterparty_id = ri.operator_counterparty_id
FROM ranked_removals rr
JOIN ranked_installs ri
  ON ri.object_id = rr.object_id
 AND ri.container_type_id = rr.container_type_id
 AND ri.rn = rr.rn
WHERE w.id = rr.id
  -- Установка без оператора владельца не называет: снятие остаётся в группе «не указан», и
  -- правило совпадения на нём молчит — запрет там, где нет данных, это не запрет ошибки.
  AND ri.operator_counterparty_id IS NOT NULL;

-- Замена присутствие не меняет (свап), и FIFO её не касается — владельца ей проставляем только
-- там, где он однозначен: все живые установки этого типа на объекте сделаны одним оператором.
-- Где на объекте работали двое, гадать не за что: поле остаётся пустым, и следующая правка
-- заявки спросит группу у человека.
WITH install_owners AS (
  SELECT
    object_id,
    container_type_id,
    (array_agg(DISTINCT operator_counterparty_id))[1] AS owner_id,
    count(DISTINCT operator_counterparty_id) AS owners,
    count(*) FILTER (WHERE operator_counterparty_id IS NULL) AS unknown_owners
  FROM waste_requests
  WHERE request_type = 'container_install'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
  GROUP BY object_id, container_type_id
)
UPDATE waste_requests w
SET container_owner_counterparty_id = io.owner_id
FROM install_owners io
WHERE w.request_type = 'container_replace'
  AND w.object_id = io.object_id
  AND w.container_type_id = io.container_type_id
  AND io.owners = 1
  AND io.unknown_owners = 0;

-- 3. Присутствие с владельцем.
--
-- Строка view прежняя — одна присутствующая заявка установки, — и прибавляется к ней владелец:
-- вкладка «На объекте» продолжает показывать заявки строками, а группы считаются агрегатом.
--
-- Два места, где легко ошибиться и трудно заметить:
--   * IS NOT DISTINCT FROM вместо = : группа «владелец не указан» существует и на живых данных
--     (заявку завела площадка, оператора ещё нет), а сравнение по NULL её не сопоставило бы —
--     снятие не погасило бы ничего, и контейнер стоял бы в списке вечно;
--   * sum(containers_count) вместо count(*): иначе снятие трёх контейнеров погасит один.
DROP VIEW IF EXISTS present_containers;

CREATE VIEW present_containers AS
WITH ranked_installs AS (
  SELECT
    id,
    object_id,
    container_type_id,
    operator_counterparty_id AS owner_counterparty_id,
    row_number() OVER (
      PARTITION BY object_id, container_type_id, operator_counterparty_id ORDER BY num
    ) AS rn
  FROM waste_requests
  WHERE request_type = 'container_install'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
),
removal_counts AS (
  SELECT
    object_id,
    container_type_id,
    container_owner_counterparty_id AS owner_counterparty_id,
    sum(containers_count) AS cnt
  FROM waste_requests
  WHERE request_type = 'container_removal'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
  GROUP BY object_id, container_type_id, container_owner_counterparty_id
)
SELECT ri.id, ri.object_id, ri.container_type_id, ri.owner_counterparty_id
FROM ranked_installs ri
LEFT JOIN removal_counts rc
  ON rc.object_id = ri.object_id
 AND rc.container_type_id = ri.container_type_id
 AND rc.owner_counterparty_id IS NOT DISTINCT FROM ri.owner_counterparty_id
WHERE ri.rn > COALESCE(rc.cnt, 0);

-- Группы присутствия: «что и чьё стоит на объекте, сколько штук». Одна эта выборка отвечает и
-- на «из чего выбирать контейнер в заявке», и на «сколько максимум можно снять», и на «кого
-- звать на этот объект» — держать тот же подсчёт вторым местом в коде клиента незачем.
CREATE VIEW present_container_groups AS
SELECT
  object_id,
  container_type_id,
  owner_counterparty_id,
  count(*)::int AS quantity
FROM present_containers
GROUP BY object_id, container_type_id, owner_counterparty_id;
