-- Ролевые дайджесты (ADR 0078): кому и что попадает в сводку.
--
-- Роли, разделы и исключения — отдельными таблицами, а не колонками-массивами: по ним строятся
-- выборки получателей, а массив в условии `WHERE` означает либо разворачивание при каждом запуске,
-- либо GIN-индекс ради трёх строк настройки.
--
-- Выбор роли в расписании — это фильтр получателей, а НЕ выдача прав. Что человек увидит в письме,
-- решает его собственная область видимости (ADR 0021, ADR 0038): выбранная роль лишь отвечает на
-- вопрос «кому вообще отправлять».

CREATE TABLE mailing_schedule_roles (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  role role NOT NULL,
  PRIMARY KEY (schedule_id, role)
);

-- Разделы письма. Ключ — текст, а не enum: набор разделов будет прирастать, и добавление нового не
-- должно требовать ALTER TYPE в миграции (реестр допустимых ключей живёт в контрактах, и сервер
-- отвергает незнакомые до записи).
CREATE TABLE mailing_schedule_sections (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  section text NOT NULL,
  -- Порядок разделов в письме задаёт администратор: сверху то, ради чего письмо открывают.
  position smallint NOT NULL,
  PRIMARY KEY (schedule_id, section),
  CONSTRAINT mailing_schedule_sections_position_check CHECK (position BETWEEN 1 AND 50)
);

-- Исключённые получатели-учётки. Отдельно от `mailing_schedule_excluded_persons`: там водители
-- (`persons`), которым уходит задание на рейс, здесь — пользователи портала, получающие сводку.
-- Одной таблицей их не свести: это разные сущности, и «человек» у них не совпадает.
CREATE TABLE mailing_schedule_excluded_users (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, user_id)
);

-- Исключённые области: объект или отдел, данные которых в письмо не попадают. Вычитается из
-- области получателя, а не добавляется к ней: исключение не может расширить видимость.
CREATE TABLE mailing_schedule_excluded_scopes (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  object_id uuid REFERENCES construction_objects(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
  -- Ровно одно из двух: строка описывает либо площадку, либо отдел — как и заказчик заявки.
  CONSTRAINT mailing_schedule_excluded_scopes_one_check CHECK (
    num_nonnulls(object_id, department_id) = 1
  )
);

CREATE UNIQUE INDEX mailing_schedule_excluded_scopes_object_unique
  ON mailing_schedule_excluded_scopes (schedule_id, object_id)
  WHERE object_id IS NOT NULL;
CREATE UNIQUE INDEX mailing_schedule_excluded_scopes_department_unique
  ON mailing_schedule_excluded_scopes (schedule_id, department_id)
  WHERE department_id IS NOT NULL;

-- Дайджест спрашивает историю статусов вопросом «что менялось за сутки», а индексов по времени у
-- обеих таблиц истории нет вовсе — есть только по идентификатору заявки. Ежедневная рассылка без
-- них читала бы историю целиком каждое утро, и чем дольше живёт портал, тем дороже.
CREATE INDEX IF NOT EXISTS vehicle_request_status_history_changed_at_idx
  ON vehicle_request_status_history (changed_at DESC);
CREATE INDEX IF NOT EXISTS request_status_history_changed_at_idx
  ON request_status_history (changed_at DESC);
