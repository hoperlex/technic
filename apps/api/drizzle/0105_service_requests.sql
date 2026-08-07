-- Заявки на обслуживание оргтехники (ADR 0085).
--
-- Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
-- которую согласует заказчик, а после работ — приёмка. Отсюда свой перечень статусов: приписать
-- диагностику, согласование и приёмку к общему `request_status` значило бы поменять смысл статусов
-- в двух работающих модулях.
--
-- Смета живёт строками (`service_request_items`) и версионируется: согласована та ревизия, номер
-- которой записан в заявке, и закрыть работы можно только по ней. План и факт у строки разведены —
-- иначе «запчасть не понадобилась» оставляло бы в реестре гарантию на деталь, которую не ставили.

CREATE TYPE service_request_status AS ENUM (
  'new',              -- заведена, исполнитель не назначен
  'assigned',         -- сервис выбран, заявка видна ему
  'diagnostics',      -- сервис выясняет причину и собирает смету
  'estimate_review',  -- смета предъявлена и заперта от правок
  'in_work',          -- смета согласована, идёт ремонт
  'done',             -- работы закончены, ждут приёмки
  'accepted',         -- работы приняты
  'cancelled'         -- закрыта без результата
);

CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Сквозной человекочитаемый номер; показывается как «СО-<num>».
  num integer GENERATED ALWAYS AS IDENTITY,
  office_equipment_id uuid NOT NULL REFERENCES office_equipment (id) ON DELETE RESTRICT,

  -- ── Чья это заявка. Три снимка на момент заведения; NULL у отделов означает «к отделам не
  -- относится», а не «видна всем»: единицу могут закрепить за отделом позже, и заявка прошлого
  -- года не должна от этого менять область видимости.
  equipment_object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  -- Отдел, от имени которого заведена заявка: подсказывается владельцем техники либо единственным
  -- отделом автора, но выбирается человеком — сотрудник соседнего отдела чинит «чужой» принтер
  -- чаще, чем кажется.
  customer_department_id uuid REFERENCES departments (id) ON DELETE RESTRICT,
  -- За каким отделом техника числилась. Вместе с предыдущей колонкой даёт область роли отдела:
  -- заявку видит и тот, кто её подал, и отдел, за которым закреплена единица.
  equipment_department_id uuid REFERENCES departments (id) ON DELETE RESTRICT,

  -- ── Снимок предмета: единицу переносят, переименовывают и перезакрепляют, а заявка должна
  -- остаться рассказом о том, что чинили тогда.
  equipment_name text NOT NULL,
  equipment_serial_number text NOT NULL DEFAULT '',
  equipment_inventory_number text NOT NULL DEFAULT '',

  description text NOT NULL,
  due_date date,
  responsible_name text NOT NULL DEFAULT '',
  -- Десять цифр без кода страны, как все номера портала (ADR 0066).
  responsible_phone text NOT NULL DEFAULT '',

  status service_request_status NOT NULL DEFAULT 'new',
  -- Возраст в текущем статусе: сортировка «дольше всех ждут» и признак зависшей заявки. Колонкой, а
  -- не latest-подзапросом по истории: этот вопрос задаёт каждый список.
  status_changed_at timestamptz NOT NULL DEFAULT now(),

  -- ── Обращение по гарантии: источник, а не флаг. 'equipment' — гарантия поставщика на саму
  -- единицу, 'item' — гарантия на запчасть или работу прошлой заявки (ссылкой ниже). «Гарантийная
  -- заявка» без источника не отвечает на главный вопрос спора с сервисом.
  warranty_claim_source text,
  warranty_claim_item_id uuid,

  service_counterparty_id uuid REFERENCES counterparties (id) ON DELETE RESTRICT,

  -- ── Смета и её согласование. Ревизия растёт при каждом предъявлении; согласована та, чей номер
  -- записан во второй колонке, и закрытие требует их совпадения — иначе правка проходила бы между
  -- открытием окна согласования и нажатием кнопки.
  estimate_revision integer NOT NULL DEFAULT 0,
  approved_estimate_revision integer,
  estimate_submitted_at timestamptz,
  estimate_approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  estimate_approved_at timestamptz,

  -- ── Деньги: согласованная сумма и сумма по акту. Одна колонка означала бы, что после закрытия
  -- нельзя ответить, ту ли сумму согласовывали. Итог считает сервер из строк; корректировка акта
  -- (скидка, округление) — только вниз и только с причиной.
  estimated_total_amount numeric(14,2),
  final_total_amount numeric(14,2),
  final_adjustment_amount numeric(14,2),
  final_adjustment_reason text NOT NULL DEFAULT '',

  completed_at timestamptz,
  accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  accepted_at timestamptz,

  comment text NOT NULL DEFAULT '',
  service_comment text NOT NULL DEFAULT '',

  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  -- Оптимистическая блокировка: согласование и закрытие нажимают из окна, простоявшего минуту.
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_requests_description_not_blank_check CHECK (btrim(description) <> ''),
  CONSTRAINT service_requests_amounts_check CHECK (
    (estimated_total_amount IS NULL OR estimated_total_amount >= 0)
    AND (final_total_amount IS NULL OR final_total_amount >= 0)
  ),
  -- Без исполнителя заявку никто не ведёт; исключение — «Новая» и «Отменена».
  CONSTRAINT service_requests_executor_check
    CHECK (status IN ('new','cancelled') OR service_counterparty_id IS NOT NULL),
  -- Согласование — снимок из трёх полей: автор, время и ревизия. Любое по отдельности не отвечает
  -- на вопрос «что именно согласовали».
  CONSTRAINT service_requests_approval_check CHECK (
    (estimate_approved_by IS NULL) = (estimate_approved_at IS NULL)
    AND (estimate_approved_by IS NULL) = (approved_estimate_revision IS NULL)
  ),
  CONSTRAINT service_requests_approved_revision_check
    CHECK (approved_estimate_revision IS NULL OR approved_estimate_revision <= estimate_revision),
  CONSTRAINT service_requests_accepted_check
    CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  -- Корректировка акта — пара «сумма + причина», порознь они не бывают: причина без суммы ничего не
  -- корректирует, сумма без причины делает итог необъяснимым, нулевая корректировка с причиной —
  -- запись о том, чего не произошло. Только вниз: наценка это удорожание, её путь — пересогласование.
  CONSTRAINT service_requests_final_adjustment_check CHECK (
    (final_adjustment_amount IS NULL AND btrim(final_adjustment_reason) = '')
    OR (final_adjustment_amount < 0 AND btrim(final_adjustment_reason) <> '')
  ),
  CONSTRAINT service_requests_warranty_claim_check CHECK (
    warranty_claim_source IS NULL
    OR (warranty_claim_source = 'equipment' AND warranty_claim_item_id IS NULL)
    OR (warranty_claim_source = 'item' AND warranty_claim_item_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX service_requests_num_unique ON service_requests (num);
-- Одна открытая заявка на единицу: две параллельные означали бы два сервиса, два акта и две
-- гарантии на одну работу. Индекс сторожит и заведение, и восстановление из архива — сервер обязан
-- отвечать на оба случая понятным 409 со ссылкой на открытую заявку, а не ошибкой БД.
CREATE UNIQUE INDEX service_requests_open_per_equipment_unique
  ON service_requests (office_equipment_id)
  WHERE deleted_at IS NULL AND status NOT IN ('accepted','cancelled');
-- Очереди спрашивают «что в этом статусе дольше всех» — статус и возраст читаются вместе;
-- отдельного индекса по одному статусу нет: этот покрывает его префиксом.
CREATE INDEX service_requests_status_changed_idx ON service_requests (status, status_changed_at);
CREATE INDEX service_requests_object_idx ON service_requests (equipment_object_id);
CREATE INDEX service_requests_customer_dept_idx ON service_requests (customer_department_id)
  WHERE customer_department_id IS NOT NULL;
CREATE INDEX service_requests_equipment_dept_idx ON service_requests (equipment_department_id)
  WHERE equipment_department_id IS NOT NULL;
CREATE INDEX service_requests_equipment_idx ON service_requests (office_equipment_id);
CREATE INDEX service_requests_service_idx ON service_requests (service_counterparty_id)
  WHERE service_counterparty_id IS NOT NULL;
CREATE INDEX service_requests_created_at_idx ON service_requests (created_at);

-- ── Смета: запчасти и услуги строками одной таблицы. Набор полей у них один — наименование,
-- количество, цена, сумма, гарантия, — и различает строку её вид.
CREATE TABLE service_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_requests (id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  -- План: сколько согласовали и по какой цене. Сумму считает БД — производная не может разойтись
  -- со слагаемыми.
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL,
  amount numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,

  -- Факт: что реально сделали. NULL — «не заполнено»: до закрытия факта у строки нет вовсе, и ни
  -- NOT NULL, ни DEFAULT здесь быть не должно — иначе план читался бы как факт.
  performed boolean,
  actual_quantity numeric(12,3),
  actual_amount numeric(14,2) GENERATED ALWAYS AS (
    CASE
      WHEN performed IS NULL THEN NULL
      WHEN performed THEN round(coalesce(actual_quantity, quantity) * unit_price, 2)
      ELSE 0
    END
  ) STORED,

  -- Гарантия строки: сколько обещали и до какой даты действует. Дата проставляется при закрытии как
  -- «дата выполнения + N месяцев», но правится руками — в талоне может стоять своя.
  warranty_months smallint,
  warranty_until date,
  warranty_until_manual boolean NOT NULL DEFAULT false,

  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_request_items_kind_check CHECK (kind IN ('part','service')),
  CONSTRAINT service_request_items_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT service_request_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT service_request_items_price_check CHECK (unit_price >= 0),
  CONSTRAINT service_request_items_actual_quantity_check
    CHECK (actual_quantity IS NULL OR actual_quantity > 0),
  -- Количество факта бывает только у явно выполненной строки: и «не ставили, но две штуки», и
  -- «факта ещё нет, а количество уже есть» — испорченные строки. Условие написано от количества,
  -- потому что `performed IS NOT FALSE` в Postgres истинно и для NULL — такую пару оно пропустило бы.
  CONSTRAINT service_request_items_actual_absent_check
    CHECK (actual_quantity IS NULL OR performed IS TRUE),
  -- Вверх факт не идёт: рост объёма — это удорожание, и его путь один, через пересогласование.
  CONSTRAINT service_request_items_actual_le_plan_check
    CHECK (actual_quantity IS NULL OR actual_quantity <= quantity),
  CONSTRAINT service_request_items_warranty_months_check
    CHECK (warranty_months IS NULL OR warranty_months BETWEEN 1 AND 120),
  CONSTRAINT service_request_items_warranty_manual_check
    CHECK (NOT warranty_until_manual OR warranty_until IS NOT NULL),
  -- Гарантии на то, чего не делали, не бывает; до закрытия (performed IS NULL) её тоже нет.
  CONSTRAINT service_request_items_warranty_performed_check
    CHECK (performed IS TRUE OR warranty_until IS NULL)
);

CREATE INDEX service_request_items_request_idx ON service_request_items (request_id);
CREATE INDEX service_request_items_warranty_idx ON service_request_items (warranty_until)
  WHERE warranty_until IS NOT NULL AND performed;

-- Источник гарантийного обращения. Отдельным ALTER: обе таблицы создаются одной миграцией, и
-- раньше items ссылку поставить нельзя. RESTRICT, а не SET NULL: SET NULL уронил бы CHECK,
-- требующий у источника `item` непустую ссылку, а главное — источник спора не должен исчезать,
-- пока на него ссылаются. Отсюда следствие: заявку-источник нельзя ни почистить, ни лишить строки,
-- и сервер обязан отвечать на это 409 с номерами обращений.
ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_warranty_claim_item_fk
  FOREIGN KEY (warranty_claim_item_id) REFERENCES service_request_items (id) ON DELETE RESTRICT;

-- ── Вложения. Вид называет документ, а не «прочее»: по нему собирается срез «ожидаются документы»,
-- без которого «акт подошью завтра» превращается в потерянную бумагу.
CREATE TABLE service_request_files (
  request_id uuid NOT NULL REFERENCES service_requests (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'attachment',
  attached_by uuid REFERENCES users (id) ON DELETE SET NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, file_id),
  CONSTRAINT service_request_files_kind_check
    CHECK (kind IN ('attachment','estimate','act','invoice','warranty_card'))
);

CREATE INDEX service_request_files_file_idx ON service_request_files (file_id);
-- «У каких закрытых заявок нет акта» — вопрос очереди «Ожидаются документы».
CREATE INDEX service_request_files_doc_idx ON service_request_files (request_id)
  WHERE kind IN ('act','invoice');

-- ── История статусов. Ревизия сметы на момент события: по истории должно читаться, что именно
-- согласовали и что поменялось между двумя согласованиями.
CREATE TABLE service_request_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_requests (id) ON DELETE CASCADE,
  from_status service_request_status,
  to_status service_request_status NOT NULL,
  estimate_revision integer,
  changed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  comment text NOT NULL DEFAULT ''
);

CREATE INDEX service_request_status_history_request_idx
  ON service_request_status_history (request_id, changed_at);
