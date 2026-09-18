-- Ключи опознания в интерфейсе и правила разбора писем от аппаратов.
--
-- План — docs/office-equipment-mail-identity-ui-plan.md (§5 «Данные»), решение приёма —
-- docs/adr/0197-device-mail-telemetry.md. РЕЗОЛВ НЕ ПЕРЕОТКРЫВАЕТСЯ: пять его ступеней остаются
-- прежними, меняется только то, чем их кормят.
--
-- ЧТО ЗДЕСЬ ЕСТЬ: снятие привязки со следом, таблица правил разбора и отметка ревизии правил в
-- строке письма.
--
-- ВЫКАТ БЕЗОПАСЕН ПРИ РАБОТАЮЩЕМ ПОРТАЛЕ (docs/runbook.md): колонки добавляются с умолчаниями на
-- таблицах, в которых сейчас пусто (приём писем ещё ни разу не открывали), таблица правил новая, а
-- смена уникального индекса на частичный проходит на пустой таблице привязок.
--
-- ОБРАТИМОСТЬ: DROP TABLE device_mail_parse_rules, снятие трёх колонок привязки и одной у писем,
-- возврат сплошного уникального индекса. Данных, которые при этом потерялись бы, на момент наката
-- нет.

-- ── Снятие привязки со следом ──
--
-- Жёсткое удаление строки не годится: «почему полгода назад эти письма легли в эту карточку» —
-- вопрос, который задают именно тогда, когда привязку уже сняли.
ALTER TABLE device_mail_identities
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN revoke_note text NOT NULL DEFAULT '';

-- Снятие заполняет время и причину ВМЕСТЕ: снятая привязка без объяснения — это то же удаление,
-- только дороже.
ALTER TABLE device_mail_identities
  ADD CONSTRAINT device_mail_identities_revoke_shape
  CHECK ((revoked_at IS NULL) = (btrim(revoke_note) = ''));

-- Автор снятия может исчезнуть из портала (ON DELETE SET NULL), поэтому его наличия проверка не
-- требует; обратное — «снявший есть, а снятия нет» — запрещено.
ALTER TABLE device_mail_identities
  ADD CONSTRAINT device_mail_identities_revoked_by_shape
  CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL);

-- Уникальность ключа становится ЧАСТИЧНОЙ: снятый ключ освобождает значение для новой привязки —
-- ровно так же, как снятая карточка освобождает свой номер (частичные индексы `office_equipment`).
DROP INDEX device_mail_identities_key_unique;
CREATE UNIQUE INDEX device_mail_identities_key_unique
  ON device_mail_identities (key_kind, key_value)
  WHERE revoked_at IS NULL;

-- Резолв читает только живые привязки, и отбор по ним обязан быть дешёвым.
CREATE INDEX device_mail_identities_live_idx
  ON device_mail_identities (key_kind, key_value)
  WHERE revoked_at IS NULL;

-- ── Правила разбора ──
--
-- ОДНА ТАБЛИЦА НА КЛЮЧИ И НА ПОКАЗАНИЯ. Условие применимости, способ поиска, порядок и след у них
-- общие дословно; две таблицы разошлись бы на первом же новом условии.
--
-- ЕДИНИЦЫ ИЗМЕРЕНИЯ ЗДЕСЬ НЕТ НИ ОДНОЙ КОЛОНКИ: она свойство метрики и объявлена в контракте
-- (`metricUnits`). Вторая её копия разошлась бы с реестром на первой правке.
CREATE TABLE device_mail_parse_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  key_kind text,
  metric_code text,
  component text,
  value_form text,
  match_kind text NOT NULL,
  expression text NOT NULL,
  scope text NOT NULL DEFAULT 'any',
  when_profile text,
  when_from text NOT NULL DEFAULT '',
  when_subject text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  is_enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_mail_parse_rules_target_check
    CHECK (target IN ('identity', 'metric')),
  CONSTRAINT device_mail_parse_rules_match_kind_check
    CHECK (match_kind IN ('label', 'regex')),
  CONSTRAINT device_mail_parse_rules_scope_check
    CHECK (scope IN ('any', 'subject', 'text', 'html', 'attachment')),
  CONSTRAINT device_mail_parse_rules_expression_check
    CHECK (btrim(expression) <> '' AND length(expression) <= 200),
  CONSTRAINT device_mail_parse_rules_profile_check
    CHECK (when_profile IS NULL OR when_profile IN ('ricoh', 'kyocera', 'hp', 'pantum', 'unknown')),
  CONSTRAINT device_mail_parse_rules_metric_check
    CHECK (metric_code IS NULL OR metric_code IN (
      'marker_life_total', 'printed_impressions_total', 'printed_sheets_total',
      'printed_mono_total', 'printed_color_total', 'supply_level_percent',
      'supply_remaining_pages', 'supply_replacements_total'
    )),
  CONSTRAINT device_mail_parse_rules_component_check
    CHECK (component IS NULL OR component IN (
      '', 'black', 'cyan', 'magenta', 'yellow', 'drum', 'fuser', 'waste',
      'tray1', 'tray2', 'tray3', 'bypass'
    )),
  -- Форма цели: у правила ключа нет кода метрики, у правила показания нет рода ключа. Проверка
  -- стоит здесь, а не в форме: «заполни нужное» рано или поздно заполняет оба.
  CONSTRAINT device_mail_parse_rules_shape_check CHECK (
    (target = 'identity'
      AND key_kind IN ('serial', 'inventory', 'deviceName', 'host')
      AND metric_code IS NULL AND component IS NULL AND value_form IS NULL)
    OR
    (target = 'metric'
      AND key_kind IS NULL
      AND metric_code IS NOT NULL AND component IS NOT NULL
      AND value_form IN ('number', 'percent'))
  )
);

-- Дубль правила — это два ответа на один вопрос. `coalesce` в ключе потому, что у половины колонок
-- «пусто» законно, а NULL в уникальном индексе не сравнивается сам с собой.
CREATE UNIQUE INDEX device_mail_parse_rules_unique ON device_mail_parse_rules (
  target,
  coalesce(key_kind, ''),
  coalesce(metric_code, ''),
  coalesce(component, ''),
  expression,
  coalesce(when_profile, ''),
  when_from,
  when_subject
);

-- Отбор разбора: включённые правила в порядке, заданном человеком.
CREATE INDEX device_mail_parse_rules_order_idx
  ON device_mail_parse_rules (target, sort_order, id)
  WHERE is_enabled;

-- ── Ревизия набора правил в строке письма ──
--
-- Отвечает на вопрос «по какому набору это разобрано», который задают через неделю после первого
-- правила. Отбора на перечитывание по ней сейчас НЕТ и не планируется в этом этапе: разобранных
-- писем не существует — приём ещё ни разу не открывали.
ALTER TABLE device_mail_messages ADD COLUMN rules_revision timestamptz;
