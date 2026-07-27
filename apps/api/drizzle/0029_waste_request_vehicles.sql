-- Машины и талоны при закрытии заявки на вывоз (ADR 0011).
--
-- Заявку закрывает тот, кто её выполнил, и подтверждает это талонами: заявленный объём вывозят
-- несколькими машинами, у каждой свой талон (или несколько сканов). Поэтому факт вывоза — не
-- одно число в заявке, а список машин: тип техники из справочника, фактический объём (его
-- проставляет оператор руками) и прикреплённые талоны.
--
-- Расхождение суммы по машинам с объёмом заявки НЕ запрещается: заявка — это план, машины —
-- факт, и они законно расходятся (недогруз, лишний рейс). Сверка показывается человеку, но
-- ничего не блокирует.

CREATE TABLE waste_request_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  -- Машина описывается типом из общего справочника («Самосвал 25 м³», «Контейнер 8 м³»):
  -- конкретное ТС (vehicles) здесь не при чём — техника чужая, она принадлежит оператору.
  container_type_id uuid NOT NULL REFERENCES container_types (id) ON DELETE RESTRICT,
  -- Фактический объём рейса. Вводится вручную и не обязан совпадать с вместимостью типа:
  -- машина уходит недогруженной чаще, чем полной.
  volume_m3 numeric(12, 3) NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Пометка на удаление (ADR 0011): строка остаётся в истории заявки, но из сверки объёма
  -- выпадает. Снять запись насовсем может только администратор — обычным ролям доступна
  -- только пометка, иначе ошибочное удаление талона нечем было бы заметить.
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_request_vehicles_volume_positive_check CHECK (volume_m3 > 0)
);
CREATE INDEX waste_request_vehicles_request_idx ON waste_request_vehicles (request_id);
-- Под проверку «у закрываемой заявки есть хотя бы одна машина».
CREATE INDEX waste_request_vehicles_active_idx ON waste_request_vehicles (request_id)
  WHERE deleted_at IS NULL;

-- Талоны машины: скан-копии. UNIQUE(file_id) — файл не в двух машинах; кросс-модульную
-- уникальность (заявка мусора / заявка ТС / талон) держит общий файловый сервис.
CREATE TABLE waste_request_vehicle_files (
  vehicle_id uuid NOT NULL REFERENCES waste_request_vehicles (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, file_id)
);
CREATE UNIQUE INDEX waste_request_vehicle_files_file_unique ON waste_request_vehicle_files (file_id);
