-- Журнал исходящих писем (почтовая интеграция, план `docs/mail-integration-plan.md`).
--
-- Отдельной таблицей от `jobs`, а не полем в задаче: задача отвечает за выполнение — попытки,
-- блокировку, повтор, — а журнал за содержание, адресата и результат доставки. Слить их значило бы
-- потерять письмо вместе с убранной задачей: `jobs` живут ровно до `done`, а «что и кому мы
-- отправили» спрашивают через месяцы — и в разборе «водитель говорит, что задания не было» ответ
-- даёт именно эта таблица.
--
-- Письмо и задача создаются одной транзакцией. Порядок такой: сначала строка сюда с
-- `ON CONFLICT (kind, dedupe_key) DO NOTHING RETURNING id`, и только если строка вставилась —
-- задача `send_email`. Обратный порядок дал бы задачу без письма, когда сработала дедупликация.
--
-- Тело письма хранится готовым (`subject`, `body_text`, `body_html`), а не собирается заново при
-- отправке: worker не знает ни прав, ни области видимости, а повтор упавшей отправки обязан
-- отправить ровно то, что было составлено, а не пересобранное по изменившимся данным.

CREATE TYPE mail_kind AS ENUM (
  'verify_email',
  'password_reset',
  'password_changed',
  'driver_routes',
  'role_digest'
);

CREATE TYPE mail_status AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind mail_kind NOT NULL,
  -- Ключ бизнес-события: «это письмо уже составлено». Для запуска рассылки — пара «запуск +
  -- получатель», для auth-письма — событие, его вызвавшее.
  dedupe_key text NOT NULL,
  -- Адрес снимком на момент составления: смена адреса потом не переписывает журнал — иначе на
  -- вопрос «куда ушло письмо» он отвечал бы сегодняшним адресом, а не тем, куда отправляли.
  to_email citext NOT NULL,
  -- Получатель. Учётка и физлицо — разные колонки, потому что это разные сущности: водитель
  -- получает задание, не имея учётной записи вовсе. Обе `ON DELETE SET NULL`: журнал переживает
  -- удаление и того, и другого, оставаясь свидетельством отправки.
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  person_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  -- Запуск расписания; NULL — письмо вызвано действием человека. Внешнего ключа пока нет: таблицу
  -- `mailing_runs` заводит миграция этапа «Планировщик», она же и добавит FK.
  mailing_run_id uuid,
  -- Отладочная отправка администратору: такие письма не попадают в статистику запусков и в алерты
  -- по неудачным отправкам — иначе проверка вёрстки читалась бы как сбой доставки.
  is_test boolean NOT NULL DEFAULT false,
  -- Необязательная связь с тем, о чём письмо: заявка, рейс, учётка. Без FK намеренно — сущности
  -- разных таблиц, а журнал не должен мешать их удалять.
  entity_type text,
  entity_id uuid,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text NOT NULL DEFAULT '',
  status mail_status NOT NULL DEFAULT 'pending',
  -- Что ответил SMTP-сервер: идентификатор принятого письма и текст последней ошибки. Пустые
  -- строки вместо NULL — как у остальных текстовых полей портала.
  provider_id text NOT NULL DEFAULT '',
  last_error text NOT NULL DEFAULT '',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Отправленное письмо обязано знать, когда оно ушло: без этого «отправлено» ничем не
  -- подтверждается, а разбор жалобы упирается в пустую графу.
  CONSTRAINT mail_messages_sent_at_check
    CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT mail_messages_dedupe_key_not_blank CHECK (btrim(dedupe_key) <> ''),
  CONSTRAINT mail_messages_subject_not_blank CHECK (btrim(subject) <> ''),
  CONSTRAINT mail_messages_body_not_blank CHECK (btrim(body_text) <> '')
);

-- Дедупликация: одно письмо на бизнес-событие. Это и защита от двойной отправки при повторе
-- запуска, и способ повторить запуск безопасно — второй заход просто ничего не вставит.
CREATE UNIQUE INDEX mail_messages_dedupe_unique ON mail_messages (kind, dedupe_key);

-- Диагностика очереди: «что висит в pending дольше положенного» и «что упало за сутки».
CREATE INDEX mail_messages_status_idx ON mail_messages (status, created_at);

-- История по получателю: её спрашивают, когда человек говорит, что письма не было.
CREATE INDEX mail_messages_user_idx ON mail_messages (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX mail_messages_person_idx ON mail_messages (person_id, created_at DESC)
  WHERE person_id IS NOT NULL;

-- Статистика запуска рассылки: сколько писем составлено, сколько ушло, сколько упало.
CREATE INDEX mail_messages_run_idx ON mail_messages (mailing_run_id)
  WHERE mailing_run_id IS NOT NULL;
