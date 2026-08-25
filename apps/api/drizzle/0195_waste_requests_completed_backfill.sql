-- Заселение статуса «Завершена» (ADR 0135) и два ограждения вокруг него. Отдельным файлом от
-- 0194 вынужденно: PostgreSQL не даёт использовать значение enum'а в транзакции, где оно
-- добавлено, а раннер применяет каждый файл одной транзакцией.

-- 1. Автор перехода перестаёт быть обязательным.
--
-- Строку истории пишет не только человек: перевод выкатом (ниже) — тоже переход, и заявка,
-- сменившая статус без записи о том, читалась бы как заявка с потерянной историей. Прежде
-- `changed_by` был `NOT NULL`, и записать такой переход было не от кого: системной учётки в
-- портале нет, а подставить сюда закрывшего заявку значило бы приписать ему решение, которого он
-- не принимал.
--
-- `NULL` здесь означает ровно одно — «перевод выкатом»; портал показывает его как «Портал».
-- Таблица принадлежит одному модулю (FK на `waste_requests`), и заявок техники это не касается.
ALTER TABLE request_status_history ALTER COLUMN changed_by DROP NOT NULL;

-- 2. Выполненные заявки, по которым разбирать нечего, становятся завершёнными.
--
-- Условие — отрицание отбора «требуют разбора» (ADR 0114, Р24): ни одного ждущего подтверждения
-- или спорного талона, ни одного нечитаемого файла и мёртвой задачи, ни одной страницы с отказом
-- распознавания, ни одной слепой перепроверки в ожидании или в расхождении. Заявка, у которой
-- бумага не распознавалась вовсе (модуль был выключен, закрытие старше распознавания), проходит
-- по всем четырём условиям — разбирать в ней и правда нечего.
--
-- Чего условие НЕ проверяет: расхождений сверки (объём талонов против закрытия, дата, адрес).
-- Сверка — чистая функция приложения (`waste-ticket-checks.ts`), в SQL её не повторить, а вторая
-- её реализация здесь разошлась бы с первой молча. Практическая цена мала: расхождение бывает
-- только там, где талоны уже распознаны и подтверждены, — а на день выката распознавание в
-- работу ещё не пущено (allowlist прокси закрыт), и подтверждённых талонов в базе нет.
-- Заявки, которые разбор всё же ждут, остаются «Выполнена» и завершаются руками.
UPDATE waste_requests r
   SET status = 'completed', updated_at = now()
 WHERE r.status = 'done'
   AND NOT EXISTS (
     SELECT 1 FROM waste_tickets wt
      WHERE wt.request_id = r.id
        AND (wt.status = 'unconfirmed' OR array_length(wt.needs_review_fields, 1) > 0))
   AND NOT EXISTS (
     SELECT 1 FROM waste_ticket_files wf
      LEFT JOIN jobs j ON j.id = wf.active_job_id
      WHERE wf.request_id = r.id
        AND (wf.status IN ('unsupported', 'failed') OR j.status = 'dead'))
   AND NOT EXISTS (
     SELECT 1 FROM waste_ticket_pages wp
      WHERE wp.request_id = r.id AND wp.status = 'failed')
   AND NOT EXISTS (
     SELECT 1 FROM waste_ticket_blind_checks bc
      JOIN waste_tickets wt2 ON wt2.id = bc.ticket_id
      WHERE wt2.request_id = r.id AND bc.status IN ('pending', 'mismatch'));

-- 3. Перевод попадает в историю каждой заявки — тем же порядком, что и обычный переход.
--
-- Отбираются заявки, ставшие завершёнными только что: `completed` без единой строки перехода в
-- него. Повторный накат (журнал `_migrations` его не допускает, но миграцию читают и руками)
-- второй записи не сделает.
INSERT INTO request_status_history (request_id, from_status, to_status, changed_by, comment)
SELECT r.id, 'done', 'completed', NULL,
       'Переведено выкатом: талоны разобраны, разбирать нечего'
  FROM waste_requests r
 WHERE r.status = 'completed'
   AND NOT EXISTS (
     SELECT 1 FROM request_status_history h
      WHERE h.request_id = r.id AND h.to_status = 'completed');

-- 4. Заказу техники статус недоступен на уровне базы.
--
-- Тип `request_status` общий на два модуля, и добавленное значение стало видимым обоим. Перехода
-- в него у техники нет ни в одном коридоре (`requestStatusTransitions.vehicle` в контрактах), но
-- коридор — это код, а колонка принимает что угодно из типа: ограничение здесь ловит и запись
-- мимо портала, и ошибку будущей правки. Валидируется сразу: значений `completed` в таблице нет
-- и быть не может — оно появилось минуту назад.
ALTER TABLE vehicle_requests
  ADD CONSTRAINT vehicle_requests_status_check CHECK (status <> 'completed');
