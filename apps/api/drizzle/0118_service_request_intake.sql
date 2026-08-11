-- Приём заявки на обслуживание: место техники снимком и срочность
-- (план `docs/office-equipment-upgrade-plan.md`, Р49, Р56, Р57).

ALTER TABLE service_requests
  -- Место внутри объекта на момент заведения. Снимок, как и остальные реквизиты предмета (Р10):
  -- сервис едет по адресу «Корпус 3, каб. 214», а карточка единицы к моменту ремонта могла уже
  -- переехать — читать место из справочника значило бы отправить мастера туда, где техники нет.
  ADD COLUMN equipment_location text NOT NULL DEFAULT '',
  ADD COLUMN is_urgent boolean NOT NULL DEFAULT false,
  ADD COLUMN urgency_reason text NOT NULL DEFAULT '';

-- Пара «флаг + причина», и порознь они не бывают — тот же приём, что у корректировки акта
-- (`service_requests_final_adjustment_check`). Срочность без объяснения через месяц стоит у всех
-- заявок, и признак перестаёт отбирать, а причина без флага ничего не объявляет.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_urgency_check CHECK (
  (NOT is_urgent AND btrim(urgency_reason) = '')
  OR (is_urgent AND btrim(urgency_reason) <> '')
);

-- Место — только незакрытым заявкам: по ним ещё поедут. Закрытым оно остаётся пустым намеренно:
-- «где стояло тогда» задним числом взять неоткуда, а сегодняшнее место карточки — это уже другое
-- место, и подставлять его в историю значило бы записать туда неправду.
UPDATE service_requests r
   SET equipment_location = e.location
  FROM office_equipment e
 WHERE e.id = r.office_equipment_id
   AND r.status NOT IN ('accepted', 'cancelled')
   AND btrim(e.location) <> '';

-- Контакт заявителя до сих пор требовал только портал (`ResponsibleFields`), а схема сервера
-- принимала пустые строки — заявки без контакта в базе есть. Заполняем их автором: он
-- единственный, кто про такую заявку точно известен.
--
-- CHECK на непустоту при этом не заводится, в том числе `NOT VALID`: такой CHECK проверяет строку
-- при **любом** её обновлении, и заявка, которой контакт дополнить нечем (у автора нет телефона),
-- перестала бы двигаться по статусам. Обязательность живёт в схеме запроса — там же, где
-- обязательность описания.
UPDATE service_requests r
   SET responsible_name = u.full_name
  FROM users u
 WHERE u.id = r.created_by AND btrim(r.responsible_name) = '' AND btrim(u.full_name) <> '';

UPDATE service_requests r
   SET responsible_phone = u.phone
  FROM users u
 WHERE u.id = r.created_by AND btrim(r.responsible_phone) = '' AND u.phone <> '';

-- Очередь спрашивает «что срочное и ждёт дольше всех»; закрытые и удалённые заявки в ней не
-- участвуют, поэтому индекс частичный — он остаётся размером с саму очередь, а не с таблицей.
CREATE INDEX service_requests_urgent_idx ON service_requests (status_changed_at)
  WHERE is_urgent AND deleted_at IS NULL AND status NOT IN ('accepted', 'cancelled');

-- Аддитивная миграция: колонки со значениями по умолчанию и дополнение пустых контактов. Протокол
-- выката необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.
