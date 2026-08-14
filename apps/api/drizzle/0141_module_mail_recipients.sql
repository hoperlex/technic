-- Служебные адресаты писем модулей и обратный адрес у письма
-- (план `docs/office-equipment-mail-and-history-plan.md`, Р64, Р67, Р68).
--
-- До этой миграции канал уведомлений в портале был один — ролевые сводки по расписанию, и они
-- уходят учётным записям. Отдел ИТ, который ждёт визы по заявке на обслуживание оргтехники, в
-- портал не заходит: он читает почту. Настройка адреса при этом не может лежать в `env` — её
-- меняет администратор, а правка `env` означает перезапуск сервиса руками.
--
-- Ни одного рабочего адреса миграция не заводит: репозиторий публичный, а ящик службы — настройка
-- эксплуатации, а не часть схемы. Пока строк нет, событие даёт исход `no_recipients`, и это
-- штатное состояние «функция выкачена, но не включена».
--
-- Аддитивная миграция: смысл существующих данных не меняется, протокол выката необратимых
-- миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.

CREATE TABLE module_mail_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Событие текстом, а не enum: реестр живёт в контрактах (`MODULE_MAIL_EVENTS`), и добавление
  -- строки в него не должно требовать миграции — тот же приём, что у разделов расписаний.
  event text NOT NULL,
  to_email citext NOT NULL,
  -- Выключенный адресат сохраняет настройку: «до понедельника не шлём» — это не «завести заново».
  is_enabled boolean NOT NULL DEFAULT true,
  -- Куда отвечать на письмо. Режим у строки, а не один на портал: на заявку, ждущую визы, отвечают
  -- заявителю, на отмену — тому, кто отменил, а служебные письма замыкают на ящик оператора.
  reply_to_mode text NOT NULL DEFAULT 'fixed',
  reply_to_email citext NOT NULL DEFAULT '',
  -- «Кому и зачем»: ящик без объяснения через год никто не решится выключить.
  comment text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Один адрес на событие: вторая строка с тем же ящиком означала бы два одинаковых письма.
CREATE UNIQUE INDEX module_mail_recipients_event_email_unique
  ON module_mail_recipients (event, to_email);

-- Отбор при постановке письма идёт ровно этой парой.
CREATE INDEX module_mail_recipients_live_idx
  ON module_mail_recipients (event) WHERE is_enabled;

-- CHECK по списку событий здесь намеренно НЕ ставится: реестр открытый и живёт в контрактах, как
-- `mailing_schedule_sections.section` (миграция 0100). Ограничение сделало бы обещание строкой
-- выше ложным — третье событие потребовало бы миграции, а до неё портал предлагал бы событие,
-- которое база отвергает. Значения проверяет схема запроса; сюда чужой строке взяться неоткуда.
--
-- У режима обратного адреса всё наоборот: это закрытый перечень поведения, от которого зависит
-- вторая колонка, — там ограничение уместно (тот же приём, что у `mailing_schedules.request_scope`).
ALTER TABLE module_mail_recipients ADD CONSTRAINT module_mail_recipients_reply_to_mode_check
  CHECK (reply_to_mode IN ('fixed', 'author', 'actor', 'portal'));

-- Режим и адрес — пара. У `fixed` без адреса отвечать некуда; у `portal` свой адрес означал бы
-- настройку, которой никто не пользуется (там отвечает `MAIL_REPLY_TO`). У `author` и `actor`
-- адрес необязателен: он запасной — на случай, когда у человека почты нет.
ALTER TABLE module_mail_recipients ADD CONSTRAINT module_mail_recipients_reply_to_email_check
  CHECK (
    (reply_to_mode = 'fixed' AND reply_to_email <> '')
    OR (reply_to_mode = 'portal' AND reply_to_email = '')
    OR reply_to_mode IN ('author', 'actor')
  );

-- Обратный адрес письма. Пусто — общий `MAIL_REPLY_TO`, как было до этой колонки: письма, лежащие
-- в очереди с прошлых выпусков, своего поведения не меняют. Адрес принадлежит письму, потому что
-- «кому отвечать» — свойство события, а не портала.
ALTER TABLE mail_messages ADD COLUMN reply_to citext NOT NULL DEFAULT '';
