-- Телеметрия оргтехники: приём писем от аппаратов и общий слой наблюдений.
--
-- План — docs/office-equipment-mail-telemetry-plan.md (§9 «Данные» и §9.1 «Протокол приёма
-- письма»), форма исполнения — docs/office-equipment-mail-telemetry-agent-plan.md.
--
-- ЧТО ЗДЕСЬ ЕСТЬ: четыре перечисления, пять таблиц и строка рубильника приёма. Две последние
-- таблицы (`device_observations`, `device_events`) — ОБЩИЕ с будущим коллектором Этапа 2: он войдёт
-- тем же ключом `(source, source_ref, …)`, и это единственное обязательство Этапа 1 перед ним.
--
-- ВЫКАТ БЕЗОПАСЕН ПРИ РАБОТАЮЩЕМ ПОРТАЛЕ (docs/runbook.md): все таблицы новые, старый код о них не
-- знает, `NOT NULL` с умолчаниями берутся на пустых таблицах, а лишняя строка в `feature_flags`
-- старому коду не видна — он читает флаги точечно по ключу.
--
-- ВЫКАТ ЕДЕТ ВЫКЛЮЧЕННЫМ: рубильник `device_mail_intake` заводится со значением `false`. Код
-- приезжает закрытым, открывает его `UPDATE`, а не релиз.

CREATE TYPE device_message_status AS ENUM (
  'received', 'parsed', 'unmatched', 'ambiguous', 'unrecognized', 'failed', 'ignored'
);

-- Состояние сырья письма. Заведено потому, что между заведением строки и записью объекта в
-- хранилище процесс может умереть, и без признака это состояние неотличимо от нормального.
CREATE TYPE device_raw_state AS ENUM ('absent', 'stored', 'purged');

-- Источник данных. Расширять его Этапом 2 незачем: у коллектора один код на все свои протоколы —
-- чем именно он снял показание, это его внутреннее дело.
CREATE TYPE device_telemetry_source AS ENUM ('email', 'collector', 'manual');

CREATE TYPE device_event_severity AS ENUM ('info', 'warning', 'critical');

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Состояние ящика: курсор, граница дочитывания архива, счётчик застревания.
--
-- Курсор живёт в базе портала, а не в worker: у него нет своей строки состояния, а в памяти
-- процесса курсор не переживает перезапуск. Worker спрашивает его перед заходом и двигает тем же
-- вызовом, которым сдаёт письмо, — и только последним коммитом, тем, что пишет исход разбора.

CREATE TABLE device_mail_accounts (
  account text PRIMARY KEY,
  uid_validity bigint NOT NULL DEFAULT 0,
  last_uid bigint NOT NULL DEFAULT 0,
  -- Граница дочитывания архива: эпоха и максимальный UID ящика на момент сброса. Барьер
  -- дедупликации применяется только при совпадении эпохи и только к письмам не выше отметки.
  -- Без эпохи отметка чужого ящика либо не сняла бы барьер никогда, либо сняла бы его на архиве,
  -- ради которого он и включается.
  reset_at timestamptz,
  reset_uid_validity bigint,
  reset_max_uid bigint,
  -- Счётчик застревания парой «эпоха + UID»: без пары сохранённый номер после смены эпохи
  -- указывал бы на другое письмо нового ящика, которому «осталась одна попытка».
  stuck_uid_validity bigint,
  stuck_uid bigint,
  stuck_attempts integer NOT NULL DEFAULT 0,
  last_poll_at timestamptz,
  -- Причина, по которой курсор стоит: у застрявшего письма своей строки может не быть вовсе.
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Журнал письма. Он же носитель СНИМКА разбора.
--
-- Наблюдения и события пишутся только при однозначной привязке, а разбор непривязанного письма
-- лежит в `parsed_payload` и применяется, когда человек привяжет аппарат. Потому очередь и
-- остаётся рабочей после того, как сырьё вычищено по сроку хранения.

CREATE TABLE device_mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL REFERENCES device_mail_accounts (account) ON DELETE RESTRICT,
  uid_validity bigint NOT NULL,
  uid bigint NOT NULL,
  -- Заголовок письма. НЕ ссылка: ссылка на эту строку зовётся `mail_message_id`.
  message_id_header text NOT NULL DEFAULT '',
  raw_sha256 text NOT NULL DEFAULT '',
  -- Хеш сырья плюс `Date` письма. Индекс по нему ОБЫЧНЫЙ, а не уникальный: барьер — явная
  -- проверка в ручке и только на дочитывании архива. Уникальный срабатывал бы всегда, и у
  -- аппарата с севшей батарейкой RTC второе замятие роняло бы вставку.
  dedupe_key text NOT NULL DEFAULT '',
  from_address citext NOT NULL DEFAULT '',
  envelope_to citext NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  -- Время, объявленное аппаратом. Справочное: порядок ряда задаёт момент приёма.
  device_time timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  s3_object_key text,
  raw_state device_raw_state NOT NULL DEFAULT 'absent',
  profile_code text,
  parser_version integer,
  status device_message_status NOT NULL DEFAULT 'received',
  equipment_id uuid REFERENCES office_equipment (id) ON DELETE SET NULL,
  parsed_payload jsonb,
  error_code text NOT NULL DEFAULT '',
  error_class text NOT NULL DEFAULT '',
  error_text text NOT NULL DEFAULT '',
  observation_count integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  parsed_at timestamptz,
  -- Закрывающий след очереди: `stuck`-строку иначе не убрать из отбора ничем — сырья у неё обычно
  -- нет, снимка не существует, а «игнорировать» ставит статус, который у неё уже стоит.
  reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Сырьё есть — есть и ключ объекта; нет ключа — состояние обязано это признавать.
  CONSTRAINT device_mail_messages_raw_shape_check
    CHECK ((raw_state = 'stored') = (s3_object_key IS NOT NULL)),
  -- «Кто» без «когда» следом не является — тот же приём, что у виз и подписей смены.
  CONSTRAINT device_mail_messages_review_shape_check
    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);

-- Единственный уникальный ключ приёма. Конфликт по нему — штатный успех ручки, а не ошибка:
-- приём идемпотентен, и отвечать отказом на собственный повтор значило бы застопорить курсор.
CREATE UNIQUE INDEX device_mail_messages_uid_unique
  ON device_mail_messages (account, uid_validity, uid);

CREATE INDEX device_mail_messages_dedupe_idx ON device_mail_messages (account, dedupe_key);
CREATE INDEX device_mail_messages_queue_idx ON device_mail_messages (status, received_at DESC);
CREATE INDEX device_mail_messages_equipment_idx
  ON device_mail_messages (equipment_id, received_at DESC)
  WHERE equipment_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Подтверждённые привязки «ключ → карточка».

CREATE TABLE device_mail_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_kind text NOT NULL,
  -- Нормализованное значение: та же форма, что у уникальных индексов номеров карточки
  -- (`upper(btrim(...))`). Считай её иначе — и резолв перестанет находить заведённое соседним местом.
  key_value text NOT NULL,
  equipment_id uuid NOT NULL REFERENCES office_equipment (id) ON DELETE CASCADE,
  confirmed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_mail_identities_value_not_blank CHECK (btrim(key_value) <> ''),
  -- Род ключа — из перечня контрактов, и перечень этот закрыт CHECK'ом, а не вежливостью маршрута.
  -- Без него первый же писатель, читавший план (там рода записаны змеиным письмом), завёл бы
  -- `device_name`, а резолв ищет `deviceName` — и не нашёл бы. Молча.
  CONSTRAINT device_mail_identities_kind_check CHECK (key_kind IN (
    'serial', 'inventory', 'deviceName', 'host', 'envelopeTo', 'fromAddress'
  ))
);

-- Один ключ не может вести к двум аппаратам: иначе резолв «однозначно или никак» перестаёт быть
-- однозначным ровно там, где цена ошибки — чужая наработка в живой карточке.
CREATE UNIQUE INDEX device_mail_identities_key_unique
  ON device_mail_identities (key_kind, key_value);
CREATE INDEX device_mail_identities_equipment_idx ON device_mail_identities (equipment_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Наблюдения и события — общий слой почты, коллектора и ручного ввода.
--
-- `ON DELETE CASCADE` у карточки: телеметрия производна от неё и без неё бессмысленна, а карточки
-- в этом портале удаляются не только мягко (см. directory-purge). У журнала письма, наоборот,
-- `SET NULL` — след того, что письмо приходило, обязан пережить удаление карточки.

CREATE TABLE device_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES office_equipment (id) ON DELETE CASCADE,
  metric_code text NOT NULL,
  -- Разрез: чей тонер, какой барабан, какой лоток. `NOT NULL DEFAULT ''`, и это несущее решение:
  -- пилот цветной, письмо об уровнях несёт четыре тонера одним кодом метрики. NULL здесь снял бы
  -- уникальный ключ у всей группы счётчиков разом — NULL не равен NULL.
  component text NOT NULL DEFAULT '',
  value numeric(18, 3) NOT NULL,
  unit text NOT NULL,
  -- Момент приёма порталом: часы МФУ без NTP уходят на месяцы, а ряд обязан быть монотонным хотя
  -- бы по одному надёжному времени.
  observed_at timestamptz NOT NULL,
  device_time timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  source device_telemetry_source NOT NULL,
  -- Что принесло данные: строка письма, пачка коллектора, сам ввод. Ключ по письму отвергнут —
  -- он частичный, у коллектора письма нет по определению, и повтор пачки удвоил бы дельту.
  source_ref uuid NOT NULL,
  mail_message_id uuid REFERENCES device_mail_messages (id) ON DELETE SET NULL,
  raw_label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_observations_value_check CHECK (value >= 0),
  -- Коды и единица — из словарей контрактов, и перечень закрыт здесь, а не вежливостью вызывающего.
  -- Ловить неизвестный код надо на ЗАПИСИ: на чтении выброшенная строка соврала бы «аппарат этого
  -- не присылал», а приведением типа неизвестное значение доехало бы до экрана подписью-заглушкой.
  -- Пополнение словаря — выпуск, и это осознанная цена: разбор кладёт неизвестное событие кодом
  -- `other`, а неизвестной метрики у него нет вовсе.
  CONSTRAINT device_observations_metric_code_check CHECK (metric_code IN (
    'marker_life_total', 'printed_impressions_total', 'printed_sheets_total',
    'printed_mono_total', 'printed_color_total',
    'supply_level_percent', 'supply_remaining_pages', 'supply_replacements_total'
  )),
  CONSTRAINT device_observations_unit_check CHECK (unit IN (
    'impressions', 'sheets', 'pages', 'percent', 'count'
  )),
  -- Пустая строка — законное значение «разреза нет», и она обязана быть в перечне.
  CONSTRAINT device_observations_component_check CHECK (component IN (
    '', 'black', 'cyan', 'magenta', 'yellow', 'drum', 'fuser', 'waste',
    'tray1', 'tray2', 'tray3', 'bypass'
  ))
);

CREATE UNIQUE INDEX device_observations_source_unique
  ON device_observations (source, source_ref, metric_code, component);
CREATE INDEX device_observations_series_idx
  ON device_observations (equipment_id, metric_code, observed_at DESC);

CREATE TABLE device_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES office_equipment (id) ON DELETE CASCADE,
  event_code text NOT NULL,
  severity device_event_severity NOT NULL,
  observed_at timestamptz NOT NULL,
  device_time timestamptz,
  source device_telemetry_source NOT NULL,
  source_ref uuid NOT NULL,
  -- Порядковый номер вхождения кода внутри одного источника: писателей у событий двое (разбор и
  -- применение снимка), и без него двойное «привязать» удвоило бы ленту, оставив счётчики целыми.
  ordinal integer NOT NULL DEFAULT 0,
  mail_message_id uuid REFERENCES device_mail_messages (id) ON DELETE SET NULL,
  -- Код вендора как есть: открытая часть словаря, без реестра и без проверки. Ею и держится то,
  -- что закрытая часть не зависит от того, что реально придёт в письме.
  vendor_code text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Тот же довод, что у наблюдений. `other` в перечне — не заглушка, а законный исход: им приезжает
  -- событие, которого нет в словаре, вместе с вендорской строкой в `vendor_code`.
  CONSTRAINT device_events_event_code_check CHECK (event_code IN (
    'toner_low', 'toner_empty', 'drum_low', 'waste_full', 'paper_empty',
    'paper_jam', 'cover_open', 'service_call', 'other'
  ))
);

CREATE UNIQUE INDEX device_events_source_unique
  ON device_events (source, source_ref, event_code, ordinal);
CREATE INDEX device_events_feed_idx ON device_events (equipment_id, observed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Рубильник приёма: ключ в перечень и строка, выключенная.
--
-- Реестр ключей закрыт CHECK'ом и обязан совпадать с перечнем в packages/contracts/src/
-- feature-flags.ts: ключ без строки в базе означает «выключен навсегда», и обнаружилось бы это
-- на проде, а не на ревью выката.
--
-- `ON CONFLICT DO NOTHING` — не только идемпотентность: повторный накат не имеет права погасить
-- уже включённый рубильник молча.

ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_key_check;

ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_key_check
  CHECK (key IN (
    'office_equipment_candidate_intake',
    'service_request_executor_scope',
    'service_estimate_document_mode',
    'service_estimate_exemption',
    'device_mail_intake'
  ));

INSERT INTO feature_flags (key, is_enabled) VALUES
  ('device_mail_intake', false)
ON CONFLICT (key) DO NOTHING;
