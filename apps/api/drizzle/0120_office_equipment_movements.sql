-- Перемещения оргтехники и местонахождение единицы
-- (план `docs/office-equipment-upgrade-plan.md`, Р59–Р63).
--
-- До этой миграции объект единицы менялся тихой правкой карточки: техника «переезжала» без даты,
-- причины и следа, а вопрос «где этот аппарат стоял в мае» отвечался только по заявкам, если они
-- были. Журнал делает переезд событием — с обеими сторонами, датой и объяснением.

CREATE TYPE office_equipment_state AS ENUM ('on_site', 'at_service', 'in_stock', 'with_employee');

ALTER TABLE office_equipment
  ADD COLUMN state office_equipment_state NOT NULL DEFAULT 'on_site',
  -- Уточнение к состоянию: «склад №2», «у Иванова И. И.». Свободный текст, а не ссылка: склад в
  -- справочнике есть не всегда, а сотрудник — не пользователь портала в общем случае.
  ADD COLUMN state_note text NOT NULL DEFAULT '';

-- «На складе» и «у сотрудника» без уточнения — потерянная техника: искать её по такой записи
-- негде. У «на объекте» место уже есть колонкой `location`, у «в ремонте» — сервис в заявке.
ALTER TABLE office_equipment ADD CONSTRAINT office_equipment_state_note_check
  CHECK (state IN ('on_site', 'at_service') OR btrim(state_note) <> '');

CREATE TABLE office_equipment_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES office_equipment (id) ON DELETE CASCADE,
  -- Обе стороны снимками ссылок: объект и отдел переименуют, а строка журнала обязана остаться
  -- понятной. Ссылки, а не текст, потому что по ним же строится срез «что приехало на площадку».
  from_object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  to_object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  from_department_id uuid REFERENCES departments (id) ON DELETE RESTRICT,
  to_department_id uuid REFERENCES departments (id) ON DELETE RESTRICT,
  from_location text NOT NULL DEFAULT '',
  to_location text NOT NULL DEFAULT '',
  from_state office_equipment_state NOT NULL,
  to_state office_equipment_state NOT NULL,
  -- Дата переезда, а не момент записи: технику увозят в пятницу, а в портал заносят в понедельник.
  moved_on date NOT NULL,
  reason text NOT NULL,
  comment text NOT NULL DEFAULT '',
  -- Перемещение, вызванное ремонтом: «увезли в сервис» и «вернулась». SET NULL — заявку могут
  -- снести насовсем из архива, а факт переезда от этого не отменяется.
  service_request_id uuid REFERENCES service_requests (id) ON DELETE SET NULL,
  moved_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_equipment_movements_reason_not_blank_check CHECK (btrim(reason) <> ''),
  -- Перемещение, которое ничего не переместило, — запись ни о чём: в журнале она означала бы
  -- переезд, которого не было.
  CONSTRAINT office_equipment_movements_change_check CHECK (
    from_object_id <> to_object_id
    OR from_state <> to_state
    OR from_location <> to_location
    OR from_department_id IS DISTINCT FROM to_department_id
  )
);

-- «Что было с этим аппаратом» — вопрос карточки, и читается он свежими записями сверху.
CREATE INDEX office_equipment_movements_equipment_idx
  ON office_equipment_movements (equipment_id, moved_on DESC);
-- «Что приехало на площадку» — вопрос принимающей стороны: техника появляется в её справочнике
-- сама, и журнал по целевому объекту единственный отвечает, откуда.
CREATE INDEX office_equipment_movements_to_object_idx
  ON office_equipment_movements (to_object_id, moved_on DESC);

-- Журнал начинается с выката: записей «заведена на СУ-10» задним числом не создаётся. Заведение
-- уже есть в аудите, а выдумывать перемещение, которого не было, — врать в журнале, который для
-- того и заводится, чтобы ему верили.

-- Аддитивная миграция: новый тип, две колонки со значениями по умолчанию и пустая таблица.
-- Протокол выката необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.
