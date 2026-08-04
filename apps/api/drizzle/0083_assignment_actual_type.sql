-- Назначение хранит тип НАЗНАЧЕННОЙ машины, а заказанный тип остаётся у заявки (ADR 0059).
--
-- До этой миграции `vehicle_request_assignments.vehicle_type_id` был копией **заказанного** типа,
-- и два составных FK замыкали её на обе стороны: на заявку — `(request_id, vehicle_type_id)`, на
-- машину — `(vehicle_id, vehicle_type_id)`. Вместе они делали равенство «тип машины = тип заказа»
-- физическим инвариантом (ADR 0027 §5, ADR 0045 §3).
--
-- Равенство мешает работать ровно там же, где мешала категория до ADR 0045: заказ заводит
-- площадка по своему пониманию, исполняет диспетчер тем, что свободно в парке. Заказан
-- малотоннажный, свободен бортовой крупнее — портал такого назначения не принимал, а сменить
-- заказанный тип у заявки с машиной запрещено (ADR 0028 §9) и до назначения снимает визу
-- руководителя строительства (ADR 0025 §7). Из-за того же равенства заявки разных объектов,
-- заказанные разными типами, не вставали в один рейс, а подсказка рейсов их не показывала.
--
-- Здесь колонка меняет смысл, а не исчезает: она остаётся копией типа машины (составной FK на
-- `vehicles` не трогается вовсе), а инвариант «заказ нельзя сменить под назначением» переезжает
-- на новую колонку с таким же составным ключом. Оба инварианта остаются физическими — приём тот
-- же, что у пар ключей в ADR 0007 и ADR 0016.
--
-- Граница замены (вид ТС) ключами не выражается: вид у заявки не хранится вовсе — он берётся у
-- типа, — и проверяет его сервер (`resolveAssignment`), отвечая словами, а не ошибкой целостности.
--
-- Backwards-compatible по правилу runbook: колонка nullable, а составной FK с NULL не проверяется
-- (MATCH SIMPLE). Откатанный на предыдущий релиз код пишет строки без неё и продолжает держать
-- равенство типов сам; `NOT NULL` ставит следующая миграция, когда откат уже невозможен.

-- 1. Заказанный тип — рядом с фактическим.
ALTER TABLE vehicle_request_assignments
  ADD COLUMN ordered_vehicle_type_id uuid;

COMMENT ON COLUMN vehicle_request_assignments.vehicle_type_id IS
  'Копия типа НАЗНАЧЕННОЙ машины (цель составного FK на vehicles). С заказанным типом заявки совпадать не обязан — ADR 0059.';
COMMENT ON COLUMN vehicle_request_assignments.ordered_vehicle_type_id IS
  'Копия ЗАКАЗАННОГО типа заявки (цель составного FK на vehicle_requests): им заказ и остаётся неизменяемым под назначенной машиной.';

-- 2. История: до этой миграции типы совпадали по построению.
UPDATE vehicle_request_assignments
SET ordered_vehicle_type_id = vehicle_type_id
WHERE ordered_vehicle_type_id IS NULL;

-- 3. Инвариант «заказанный тип не сменить под назначением» — на новой колонке.
--
-- ON UPDATE не задан намеренно, как и у прежнего ключа: смена типа ТС у заявки с назначенной
-- машиной должна отклоняться, а не тянуть за собой строку назначения (сервер отвечает 422 с
-- объяснением).
ALTER TABLE vehicle_request_assignments
  ADD CONSTRAINT vehicle_request_assignments_ordered_type_fk
  FOREIGN KEY (request_id, ordered_vehicle_type_id)
  REFERENCES vehicle_requests (id, vehicle_type_id) ON DELETE CASCADE;

-- 4. Прежний ключ снимается — вместе с ним и равенство типов.
--
-- Каскад от заявки при этом сохраняется: назначение живёт ровно столько же, сколько сама заявка,
-- и после снятия составного ключа его держит обычный FK по `request_id`.
ALTER TABLE vehicle_request_assignments
  DROP CONSTRAINT vehicle_request_assignments_request_type_fk;

ALTER TABLE vehicle_request_assignments
  ADD CONSTRAINT vehicle_request_assignments_request_fk
  FOREIGN KEY (request_id) REFERENCES vehicle_requests (id) ON DELETE CASCADE;
