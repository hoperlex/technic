-- Роль «Руководитель строительства» и виза на заявке ТС (ADR 0025).
--
-- Заявку на технику обрабатывают только после согласования со стороны объекта: диспетчер не
-- переводит её в «В работе», пока руководитель строительства не завизировал. Виза — не статус
-- и не отдельная таблица: у заявки она одна и живёт ровно столько же, сколько сама заявка,
-- поэтому это две колонки — кто и когда.
--
-- CHECK «объект обязателен для роли» вынесен в 0050: значение 'rukstroy' добавляется в enum
-- здесь, а новое значение нельзя использовать в транзакции, которая его добавила (раннер
-- выполняет файл целиком в одной транзакции) — тот же приём, что и в 0022/0023.

ALTER TYPE role ADD VALUE 'rukstroy' AFTER 'shtab';

-- Виза. `approved_by` ON DELETE RESTRICT — как и `created_by`: учётки удаляются мягко, а
-- завизировавшего нужно предъявить и через год.
ALTER TABLE vehicle_requests
  ADD COLUMN approved_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN approved_at timestamptz,
  -- Виза целиком либо её нет: «кто» без «когда» — это не согласование, а полстроки.
  ADD CONSTRAINT vehicle_requests_approval_check
    CHECK ((approved_by IS NULL) = (approved_at IS NULL));

-- Основной вопрос к таблице после появления визы — «что ждёт согласования»: незавизированные
-- заявки, живые и в работу не взятые. Частичный индекс, потому что завизированных со временем
-- становится большинство.
CREATE INDEX vehicle_requests_awaiting_approval_idx
  ON vehicle_requests (object_id)
  WHERE approved_at IS NULL AND deleted_at IS NULL;
