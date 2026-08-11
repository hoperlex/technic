-- Рассылки: окно дней вместо периодичности, отбор аудитории вместо исключений, сводка по путевым
-- листам вместо разделов событий (план `docs/role-mailings-refactor-plan.md`, ADR 0093).
--
-- Три независимые правки одной таблицы, и разделять их нечем: расписание после них описывается
-- иначе целиком.
--
-- 1. Периодичность сливала в одно слово три независимых числа: день срабатывания, начало периода
--    данных и его длину. «Недельная» — это «по понедельникам, с сегодняшнего дня, на семь дней», и
--    выразить «каждый вечер про послезавтра» прежней моделью было нельзя вовсе. Остаются дни
--    выполнения (`run_weekdays`), время и окно данных.
--
-- 2. Окно задаётся началом и длительностью, а не парой границ: «конец раньше начала» длительностью
--    невыразимо, и проверять его больше не нужно ни в схеме, ни в контракте, ни в форме. Окно
--    смотрит вперёд у обоих типов рассылки: и задание водителю, и сводка отвечают на вопрос «что
--    будет в эти дни».
--
-- 3. Аудитория сводки описывалась наизнанку: роли выбирались, а получатели и области исключались.
--    Теперь все три оси — выбор, а «отмечено всё» хранится режимом `all`, а не перечнем: иначе
--    заведённая завтра площадка и принятый на работу штаб молча выпадали бы из рассылки.
--
-- 4. Девять разделов «что произошло за период» сняты вместе с реестром: сводка собирается по
--    действующим путевым листам — 4-П и форма № 3 дают перевозки, ЭСМ-2 — технику на объектах.
--
-- НЕОБРАТИМАЯ миграция: снимаются колонки и таблица настроек. Выкат по протоколу
-- `docs/schema-cutover-protocol.md`.

-- ── 1. Окно данных ───────────────────────────────────────────────────────────────────────────────

ALTER TABLE mailing_schedules
  ADD COLUMN window_days smallint,
  ADD COLUMN request_scope text NOT NULL DEFAULT 'scope',
  ADD COLUMN show_trips boolean NOT NULL DEFAULT true,
  ADD COLUMN show_onsite boolean NOT NULL DEFAULT true,
  ADD COLUMN scope_mode text NOT NULL DEFAULT 'all',
  ADD COLUMN recipient_mode text NOT NULL DEFAULT 'all';

-- Старые ограничения снимаются ДО переноса данных, а не вместе со столбцами. Прежний
-- `window_check` требовал у сводки пустого окна («окно бывает только у задания водителям»), и
-- первый же UPDATE, проставляющий ей окно, упёрся бы в него.
ALTER TABLE mailing_schedules
  DROP CONSTRAINT mailing_schedules_weekday_check,
  DROP CONSTRAINT mailing_schedules_window_check;

-- Недельная рассылка — это набор из одного дня недели. Перенос идёт до снятия колонок, иначе день
-- срабатывания потерялся бы: у недельного расписания `run_weekdays` заполнен умолчанием «все дни».
UPDATE mailing_schedules
   SET run_weekdays = ARRAY[weekday]::smallint[]
 WHERE periodicity = 'weekly' AND weekday IS NOT NULL;

-- Задание водителю: окно у него уже было парой границ, длительность считается из неё.
UPDATE mailing_schedules
   SET window_days = GREATEST(1, window_to_days - window_from_days + 1)
 WHERE type = 'driver_routes' AND window_from_days IS NOT NULL AND window_to_days IS NOT NULL;

-- Сводка: окна у неё не было вовсе — период считался назад от дня рассылки («за вчера», «за прошлую
-- неделю»). Сохранить прежнее поведение нечем: содержание письма меняется целиком и говорит теперь
-- о будущем. Перенос выбирает правдоподобное умолчание по времени отправки — утренняя сводка про
-- сегодня, вечерняя про завтра, недельная на неделю вперёд, — а расписания после выката
-- перечитывает администратор (runbook, «Рассылки по расписанию»).
UPDATE mailing_schedules
   SET window_from_days = CASE WHEN periodicity = 'weekly' THEN 0
                               WHEN send_at < TIME '12:00' THEN 0
                               ELSE 1 END,
       window_days = CASE WHEN periodicity = 'weekly' THEN 7 ELSE 1 END
 WHERE type = 'role_digest';

-- Страховка для строк, до которых не дошла ни одна ветка (тип, заведённый в обход формы).
UPDATE mailing_schedules SET window_from_days = 1 WHERE window_from_days IS NULL;
UPDATE mailing_schedules SET window_days = 1 WHERE window_days IS NULL;

ALTER TABLE mailing_schedules
  DROP COLUMN periodicity,
  DROP COLUMN weekday,
  DROP COLUMN window_to_days,
  ALTER COLUMN window_from_days SET NOT NULL,
  ALTER COLUMN window_from_days SET DEFAULT 1,
  ALTER COLUMN window_days SET NOT NULL,
  ALTER COLUMN window_days SET DEFAULT 1,
  ADD CONSTRAINT mailing_schedules_window_check
    CHECK (window_from_days BETWEEN 0 AND 30 AND window_days BETWEEN 1 AND 31),
  ADD CONSTRAINT mailing_schedules_request_scope_check
    CHECK (request_scope IN ('author', 'scope', 'all')),
  ADD CONSTRAINT mailing_schedules_mode_check
    CHECK (scope_mode IN ('all', 'selected') AND recipient_mode IN ('all', 'selected')),
  -- Сводка без единой таблицы собрала бы пустое письмо, которое всё равно не отправится:
  -- выключается такая рассылка флагом, а не снятием обеих галочек.
  ADD CONSTRAINT mailing_schedules_digest_content_check
    CHECK (type <> 'role_digest' OR show_trips OR show_onsite);

DROP TYPE mailing_periodicity;

-- ── 2. Аудитория: отбор вместо исключений ────────────────────────────────────────────────────────

ALTER TABLE mailing_schedule_excluded_users RENAME TO mailing_schedule_recipients;
ALTER TABLE mailing_schedule_excluded_scopes RENAME TO mailing_schedule_scopes;

ALTER INDEX mailing_schedule_excluded_scopes_object_unique
  RENAME TO mailing_schedule_scopes_object_unique;
ALTER INDEX mailing_schedule_excluded_scopes_department_unique
  RENAME TO mailing_schedule_scopes_department_unique;
ALTER TABLE mailing_schedule_scopes
  RENAME CONSTRAINT mailing_schedule_excluded_scopes_one_check TO mailing_schedule_scopes_one_check;

-- Материализация исключений в отбор. Делается здесь, а не в коде: после выката различить «этого
-- исключили» и «этого не отметили» будет нечем, а трактовать старый перечень как новый нельзя —
-- он означает ровно противоположное.
--
-- Расписание без исключений остаётся в режиме `all`: набор пуст, и новые площадки с новыми
-- учётками попадают в рассылку сами, как попадали раньше.

-- Получатели: отмечаются все действующие учётки подходящих ролей, кроме исключённых. Прежний
-- перечень снимается во временную таблицу до очистки — читать его после `DELETE` было бы уже
-- нечем.
UPDATE mailing_schedules s
   SET recipient_mode = 'selected'
 WHERE s.type = 'role_digest'
   AND EXISTS (SELECT 1 FROM mailing_schedule_recipients r WHERE r.schedule_id = s.id);

CREATE TEMP TABLE excluded_users ON COMMIT DROP AS
  SELECT schedule_id, user_id FROM mailing_schedule_recipients;

DELETE FROM mailing_schedule_recipients;

INSERT INTO mailing_schedule_recipients (schedule_id, user_id)
SELECT DISTINCT s.id, u.id
  FROM mailing_schedules s
  JOIN mailing_schedule_roles sr ON sr.schedule_id = s.id
  JOIN users u ON u.role = sr.role
 WHERE s.recipient_mode = 'selected'
   AND u.is_active
   AND u.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM excluded_users e WHERE e.schedule_id = s.id AND e.user_id = u.id
   );

-- Области: отмечаются все действующие площадки и отделы, кроме исключённых. Мягкого удаления у
-- этих двух справочников нет — «действующая» означает `is_active`.
UPDATE mailing_schedules s
   SET scope_mode = 'selected'
 WHERE s.type = 'role_digest'
   AND EXISTS (SELECT 1 FROM mailing_schedule_scopes sc WHERE sc.schedule_id = s.id);

CREATE TEMP TABLE excluded_scopes ON COMMIT DROP AS
  SELECT schedule_id, object_id, department_id FROM mailing_schedule_scopes;

DELETE FROM mailing_schedule_scopes;

INSERT INTO mailing_schedule_scopes (schedule_id, object_id)
SELECT s.id, o.id
  FROM mailing_schedules s
  JOIN construction_objects o ON o.is_active
 WHERE s.scope_mode = 'selected'
   AND NOT EXISTS (
     SELECT 1 FROM excluded_scopes e WHERE e.schedule_id = s.id AND e.object_id = o.id
   );

INSERT INTO mailing_schedule_scopes (schedule_id, department_id)
SELECT s.id, d.id
  FROM mailing_schedules s
  JOIN departments d ON d.is_active
 WHERE s.scope_mode = 'selected'
   AND NOT EXISTS (
     SELECT 1 FROM excluded_scopes e WHERE e.schedule_id = s.id AND e.department_id = d.id
   );

-- Расписание, у которого после материализации не осталось ни одной строки (исключили всё, что
-- было), — это выключенная рассылка, выраженная вторым способом. Возвращаем её в режим `all`:
-- контракт запрещает пустой перечень при `selected`, и такая строка не прошла бы правку из формы.
UPDATE mailing_schedules s
   SET recipient_mode = 'all'
 WHERE s.recipient_mode = 'selected'
   AND NOT EXISTS (SELECT 1 FROM mailing_schedule_recipients r WHERE r.schedule_id = s.id);

UPDATE mailing_schedules s
   SET scope_mode = 'all'
 WHERE s.scope_mode = 'selected'
   AND NOT EXISTS (SELECT 1 FROM mailing_schedule_scopes sc WHERE sc.schedule_id = s.id);

-- ── 3. Разделы событий ───────────────────────────────────────────────────────────────────────────

-- Реестр разделов и их порядок больше ни на что не влияют: сводка состоит из двух таблиц, и
-- включаются они флагами `show_trips`/`show_onsite`.
DROP TABLE mailing_schedule_sections;
