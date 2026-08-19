-- Заморозка заявки на обслуживание: куда вернуть и почему остановили
-- (план `docs/office-equipment-cycle-changes-plan.md`, §5, Р104, Р107, Р118, Р119; этап 2, миграция B).
--
-- Значение `on_hold` пришло отдельной миграцией `0161` — здесь оно впервые используется по имени,
-- и это возможно только потому, что та зафиксирована своей транзакцией.

ALTER TABLE service_requests
  -- Куда вернуть заявку при возобновлении (Р104). Одна дуга назад, в тот же статус: разреши мы
  -- выбирать цель, «Отложена» стала бы вторым входом в цикл — в обход виз, сметы и назначения.
  -- NULL означает «заявка не отложена».
  ADD COLUMN held_from_status service_request_status,
  -- Почему остановили (Р107). Причина обязательна, как у отмены и отказа: даты «отложена до» нет
  -- вовсе, и «когда ждать» отвечает именно эта строка, а «сколько ждут уже» — возраст в статусе.
  ADD COLUMN hold_reason text NOT NULL DEFAULT '';

-- Заморозка — неразрывная тройка «статус + откуда + причина». Статус без исходного некуда
-- вернуть, исходный без статуса означал бы заморозку, которой нет, а причина обязана исчезать
-- вместе с ней: выход из `on_hold` чистит оба поля централизованно (Р118), и этот CHECK — то,
-- что заставляет чистить их и при возобновлении, и при отмене отложенной.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_hold_check
  CHECK (
    (status = 'on_hold') = (held_from_status IS NOT NULL)
    AND (status <> 'on_hold' OR btrim(hold_reason) <> '')
    AND (status = 'on_hold' OR btrim(hold_reason) = '')
  );

-- Заморозка не вкладывается в себя и не ведёт назад в закрытые статусы: вернуть заявку в
-- «Отложена» значило бы заморозку без выхода, а в «Принята» или «Отменена» — воскресить
-- закрытую заявку возобновлением.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_held_from_check
  CHECK (held_from_status IS NULL OR held_from_status NOT IN ('on_hold', 'accepted', 'cancelled'));

-- Исполнитель проверяется по «эффективному» статусу — тому, откуда заявку отложили. Отложенная из
-- «Новой» или «Согласована ИТ» исполнителя не имеет и иметь не должна, а прежнее ограничение
-- знало только три статуса и отказало бы на первой же заморозке новой заявки. `COALESCE` даёт
-- обычный статус, пока заморозки нет.
ALTER TABLE service_requests DROP CONSTRAINT service_requests_executor_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_executor_check
  CHECK (
    COALESCE(held_from_status, status) IN ('new', 'it_approved', 'cancelled')
    OR service_counterparty_id IS NOT NULL
  );

-- Очередь «что срочное ждёт дольше всех» перестаёт видеть отложенные (Р119): признак срочности у
-- заморозки не гасится — заявка не перестала быть срочной оттого, что её остановили, — но первой
-- строкой списка стоит то, за что берутся сейчас, а отложенная ждёт решения, а не рук. Индекс
-- пересоздаётся вместе с фильтром `q.urgent` и сортировкой `urgentFirst`: разойдись он с самой
-- очередью — и частичный индекс перестал бы её покрывать.
DROP INDEX service_requests_urgent_idx;
CREATE INDEX service_requests_urgent_idx ON service_requests (status_changed_at)
  WHERE is_urgent AND deleted_at IS NULL
    AND status NOT IN ('accepted', 'cancelled', 'on_hold');

-- Индекс очереди «Ожидаются документы» приводится к той же планке, что и приёмка (Р112, Р114):
-- она спрашивает любой закрывающий документ, а индекс собран по двум видам из трёх. Частичный
-- индекс покрывает только запрос, чьё условие не шире его собственного, — оставь мы `act`,
-- `invoice`, и очередь перестала бы им пользоваться, читая таблицу целиком.
DROP INDEX service_request_files_doc_idx;
CREATE INDEX service_request_files_doc_idx ON service_request_files (request_id)
  WHERE kind IN ('act', 'invoice', 'warranty_card');

-- `service_requests_open_per_equipment_unique` намеренно не трогается: его условие
-- `status NOT IN ('accepted','cancelled')` уже относит отложенную к открытым (Р109) — техника
-- ждёт этого же ремонта, и вторую заявку на неё заводить нечем.

-- Колонка `due_date` здесь не удаляется (Р122): nullable-колонка, которую после этой работы никто
-- не читает и не пишет, ничего не стоит, а `DROP COLUMN` необратим и идёт своим релизом по
-- протоколу выката (`docs/schema-cutover-protocol.md`).

-- Аддитивная миграция: колонки со значениями по умолчанию, существующие строки условиям новых
-- CHECK'ов удовлетворяют как есть (`held_from_status IS NULL`, `hold_reason = ''`), смысл данных
-- не меняется. Протокол выката необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не
-- применяется.
