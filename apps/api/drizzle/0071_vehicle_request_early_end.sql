-- Досрочное завершение заказа спецтехники (ADR 0044).
--
-- Техника, заказанная на объект на длительный срок, освобождается раньше: фронт работ закрыт,
-- машина простаивает. Срок такой заявки нужно сократить — но не правкой: заказчику со стороны
-- объекта правка заявки в работе закрыта вовсе, а диспетчеру она снимает визу, которую после
-- «В работе» уже не вернуть (ADR 0025). Поэтому сокращение срока — согласуемое изменение со
-- своей записью, своей причиной и визой того же руководителя строительства, что визировал заказ.
--
-- Строка живёт не вместо срока, а рядом с ним: согласованное сокращение меняет date_to в
-- special_equipment_request_details. В заявке одно время — то, о котором договорились, — а
-- расхождение с первоначальным читается историей (тем же приёмом уточняется срок при переводе
-- заявки в работу, ADR 0027).

CREATE TYPE vehicle_early_end_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE vehicle_request_early_endings (
  -- Одна заявка — одно досрочное завершение, поэтому request_id и есть первичный ключ. Повторный
  -- запрос (передумали о дате, отказ и новая попытка, второе сокращение уже сокращённого срока)
  -- переписывает строку — как переписывает её повторное закрытие заявки (ADR 0029). Цепочка
  -- решений при этом не теряется: каждое из них остаётся событием в истории заявки.
  request_id uuid PRIMARY KEY REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  status vehicle_early_end_status NOT NULL,
  -- Новый последний день работ и срок, стоявший в заявке на момент запроса. Второе — снимок: по
  -- нему считается, сколько дней освобождается, и по нему же видно, что заявку правили после
  -- запроса. Ссылкой на текущий date_to этот вопрос не задать — он к моменту визы уже другой.
  new_date_to date NOT NULL,
  previous_date_to date NOT NULL,
  -- Зачем сокращаем: «работы на фундаменте закончены». Обязательна — визирующему решать нечего,
  -- если ему не сказали, что произошло на объекте.
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Решение: кто и когда завизировал сокращение либо отказал. Пусто ровно у ожидающего визы.
  decided_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_comment text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- «Кто» без «когда» — не решение (тем же CHECK устроена виза заявки, миграция 0049).
  CONSTRAINT vehicle_request_early_endings_decision_check
    CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  -- Состояние и решение — одно и то же с двух сторон: «согласовано» без решившего не бывает,
  -- «ждёт визы» с решившим — тем более.
  CONSTRAINT vehicle_request_early_endings_pending_check
    CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- Досрочное завершение только сокращает срок: равный и больший — это не оно, а продление,
  -- которое портал ведёт обычной правкой.
  CONSTRAINT vehicle_request_early_endings_earlier_check
    CHECK (new_date_to < previous_date_to),
  CONSTRAINT vehicle_request_early_endings_reason_check
    CHECK (btrim(reason) <> ''),
  -- Отказ объясняется — как причина отмены заявки. Согласие объяснений не требует: срок в
  -- заявке после него говорит сам за себя.
  CONSTRAINT vehicle_request_early_endings_rejection_reason_check
    CHECK (status <> 'rejected' OR btrim(decision_comment) <> '')
);

-- «Что ждёт визы на досрочный отъезд» — вопрос, с которого руководитель строительства начинает
-- день; тем же частичным индексом, что и «ждёт визы» у самой заявки (миграция 0049).
CREATE INDEX vehicle_request_early_endings_pending_idx
  ON vehicle_request_early_endings (requested_at DESC)
  WHERE status = 'pending';
