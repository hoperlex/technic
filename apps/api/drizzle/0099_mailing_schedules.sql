-- Расписания рассылок и их запуски (ADR 0075).
--
-- Настройки живут в БД, а не в `env`: время отправки, окно дат и исключения меняет администратор,
-- а правка `env` — это перезапуск сервиса руками того, у кого есть доступ к серверу. Расписание —
-- рабочая настройка, а не параметр развёртывания.
--
-- Запуск отделён от расписания намеренно. Расписание отвечает на вопрос «когда и что рассылать»,
-- запуск — «что произошло такого-то числа в 18:00»: сколько писем ушло, сколько водителей
-- пропущено и почему. Без второй таблицы история рассылки существовала бы только в логах, а
-- повторить упавший запуск было бы нечем — незачем и не по чему.

CREATE TYPE mailing_type AS ENUM ('driver_routes', 'role_digest');
CREATE TYPE mailing_periodicity AS ENUM ('daily', 'weekly');
CREATE TYPE mailing_run_status AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');

CREATE TABLE mailing_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type mailing_type NOT NULL,
  name text NOT NULL,
  -- Выключенное расписание остаётся со всеми настройками: «до понедельника не рассылаем» не должно
  -- означать «завести заново».
  is_enabled boolean NOT NULL DEFAULT false,
  periodicity mailing_periodicity NOT NULL DEFAULT 'daily',
  -- Местное время отправки в часовом поясе портала (MAIL_SCHEDULER_TIMEZONE). Хранится временем, а
  -- не меткой: «в 18:00 каждый день» не зависит от даты и от перевода часов.
  send_at time NOT NULL,
  -- ISO-день недели 1..7 (понедельник..воскресенье) — только у недельной рассылки.
  weekday smallint,
  -- По каким дням недели выполняется ежедневная рассылка: суббота и воскресенье чаще всего лишние.
  -- Пустой массив запрещён: расписание, не выполняющееся никогда, — это выключенное расписание,
  -- и выражать его надо флагом, а не пустым набором дней.
  run_weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  -- Окно рейсов задания водителю: от +N дней до +M включительно, где 1 — завтра. Отсчёт в днях, а
  -- не датами: расписание живёт долго, а «завтра» у каждого запуска своё.
  window_from_days smallint,
  window_to_days smallint,
  -- Когда сработает в следующий раз. Считает и хранит планировщик: так «просроченные расписания»
  -- находятся одним индексируемым условием, а не перебором всех строк с вычислением на лету.
  next_run_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_schedules_name_not_blank CHECK (btrim(name) <> ''),
  -- Недельной рассылке день недели обязателен, ежедневной он не нужен вовсе.
  CONSTRAINT mailing_schedules_weekday_check CHECK (
    (periodicity = 'weekly' AND weekday BETWEEN 1 AND 7)
    OR (periodicity = 'daily' AND weekday IS NULL)
  ),
  CONSTRAINT mailing_schedules_run_weekdays_check CHECK (
    array_length(run_weekdays, 1) BETWEEN 1 AND 7
    AND run_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
  ),
  -- Окно дат — принадлежность задания водителю: у дайджеста период считается от даты запуска.
  CONSTRAINT mailing_schedules_window_check CHECK (
    (type = 'driver_routes'
      AND window_from_days IS NOT NULL AND window_to_days IS NOT NULL
      AND window_from_days >= 0 AND window_to_days >= window_from_days)
    OR (type <> 'driver_routes' AND window_from_days IS NULL AND window_to_days IS NULL)
  )
);

-- Просроченные расписания: единственный запрос планировщика, и он идёт раз в минуту.
CREATE INDEX mailing_schedules_due_idx ON mailing_schedules (next_run_at)
  WHERE is_enabled AND next_run_at IS NOT NULL;

-- Даты-исключения. Два вида в одной таблице: «в этот день не рассылаем» (праздник) и «рейсы этого
-- дня в письмо не включаем» — вопросы разные, а хранение у них одинаковое.
CREATE TYPE mailing_excluded_date_kind AS ENUM ('run', 'route');

CREATE TABLE mailing_schedule_excluded_dates (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  kind mailing_excluded_date_kind NOT NULL,
  excluded_on date NOT NULL,
  PRIMARY KEY (schedule_id, kind, excluded_on)
);

-- Исключённые получатели. Водитель — `persons`: учётной записи у него может не быть вовсе.
CREATE TABLE mailing_schedule_excluded_persons (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, person_id)
);

CREATE TABLE mailing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES mailing_schedules(id) ON DELETE CASCADE,
  -- На какое время запуск был назначен. Вместе с расписанием это и есть ключ запуска: два
  -- экземпляра worker, проснувшиеся одновременно, не создадут двух рассылок за одно время.
  planned_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  -- Границы данных запуска: фиксируются при создании и при повторе не пересчитываются — иначе
  -- повтор упавшей вечерней рассылки утром разослал бы задание на другой день.
  period_start date,
  period_end date,
  status mailing_run_status NOT NULL DEFAULT 'pending',
  -- Итоги: сколько писем составлено, сколько получателей пропущено и по какой причине. jsonb, а не
  -- колонки: набор причин у каждого вида рассылки свой и будет меняться.
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  -- Запуск «сейчас» из админки: он виден в истории отдельно от расписанных.
  is_manual boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_runs_period_check CHECK (
    (period_start IS NULL AND period_end IS NULL)
    OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end >= period_start)
  )
);

-- Один запуск расписания на назначенное время: этим держится «несколько worker не создадут
-- двойную рассылку». Ручной запуск в ограничение попадает наравне — повторное нажатие «Запустить
-- сейчас» в ту же секунду второй рассылки не создаст.
CREATE UNIQUE INDEX mailing_runs_planned_unique ON mailing_runs (schedule_id, planned_at);
CREATE INDEX mailing_runs_history_idx ON mailing_runs (schedule_id, created_at DESC);

-- Теперь, когда таблица запусков есть, письмо может на неё сослаться (миграция 0097 оставила
-- колонку без внешнего ключа). ON DELETE SET NULL: журнал писем переживает удаление расписания —
-- «кому что отправили» остаётся, даже если рассылку потом снесли.
ALTER TABLE mail_messages
  ADD CONSTRAINT mail_messages_mailing_run_fk
  FOREIGN KEY (mailing_run_id) REFERENCES mailing_runs(id) ON DELETE SET NULL;
