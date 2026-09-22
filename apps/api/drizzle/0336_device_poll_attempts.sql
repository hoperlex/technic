-- Журнал попыток опроса аппаратов по сети (SNMP).
--
-- Решение — docs/adr/0205-device-network-poll.md. Телеметрия оргтехники заведена
-- docs/adr/0197-device-mail-telemetry.md: показания и события уже есть, и второй их таблицы здесь
-- не появляется — снятое опросом ложится в device_observations источником 'collector'.
--
-- ОТКУДА НОМЕР. Снимок ls apps/api/drizzle 22.09.2026: последней в дереве стоит
-- 0335_releases_parse_rule_model.sql, файлов 0336 нет ни в одной ветке.
--
-- ЗАЧЕМ ТАБЛИЦА, ЕСЛИ ПОКАЗАНИЕ ПИШЕТСЯ В device_observations. Потому что опрос чаще всего
-- показания НЕ даёт: молчание сети, чужой серийный номер по знакомому адресу, отсутствие
-- стандартного счётчика у модели. Каждый такой исход — факт, который спрашивают на следующий день
-- («почему за среду нет числа»), и держать его негде: ряд наблюдений по построению хранит только
-- удавшееся, и строка «не вышло» в нём была бы порчей ряда, а не записью о сбое.
--
-- ЦЕЛЬ — ТЕКСТОМ, А НЕ ССЫЛКОЙ. Цели опроса живут в настройке окружения (DEVICE_POLL_TARGETS):
-- контур тестовый, и форма цели до ручных проверок не устоялась. Ключ поэтому хранится значением и
-- означает «так эта цель называлась в тот день»; правка реестра историю попыток не переписывает.
-- Когда цели переедут в таблицу, столбец станет внешним ключом — данные к этому готовы.
--
-- COMMUNITY НЕ ХРАНИТСЯ ВОВСЕ. В SNMP v2c это пароль чтения; журналу опросов он не нужен ни для
-- чего, а попав сюда, он оказался бы в каждой выгрузке базы и в каждом снимке для отладки.
--
-- ОКНО ВЫКАТА. Миграция идёт при работающем портале и до перезапуска приложения (docs/runbook.md).
-- Таблица новая, и в окне её не пишет никто: старый код о ней не знает, а вкладка опроса появляется
-- вместе с новым. Ни данных, ни поведения окно не затрагивает.
--
-- ОТКАТ КОДА БЕЗОПАСЕН. deploy-auto --previous возвращает прежний код и схему не трогает: таблица
-- остаётся, её просто перестают писать. Ни одна прежняя ручка на неё не смотрит.
--
-- ОБРАТИМОСТЬ (одной командой): DROP TABLE device_poll_attempts;
-- Показания, записанные опросом, при этом остаются в device_observations и остаются верными: они
-- ссылаются на попытку значением source_ref, а не внешним ключом, — ровно потому, что журнал
-- попыток эксплуатационный, а ряд наработки постоянный, и срок жизни у них разный.

CREATE TABLE IF NOT EXISTS device_poll_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text NOT NULL,
  address text NOT NULL,
  equipment_id uuid REFERENCES office_equipment(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL,
  outcome text NOT NULL,
  message text NOT NULL DEFAULT '',
  sys_descr text NOT NULL DEFAULT '',
  sys_name text NOT NULL DEFAULT '',
  device_serial text NOT NULL DEFAULT '',
  metric_code text,
  value numeric(18, 3),
  unit text NOT NULL DEFAULT '',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Перечень исходов закрыт на записи, как и словарь метрик у наблюдений: исход читают и портал, и
-- человек в журнале, и новый код в нём завестись молча не должен.
ALTER TABLE device_poll_attempts
  DROP CONSTRAINT IF EXISTS device_poll_attempts_outcome_check;

ALTER TABLE device_poll_attempts
  ADD CONSTRAINT device_poll_attempts_outcome_check CHECK (
    outcome IN (
      'ok',
      'ok_unverified',
      'no_equipment',
      'serial_mismatch',
      'no_counter',
      'unit_unknown',
      'no_answer',
      'snmp_error',
      'bad_response'
    )
  );

-- Число и метрика ходят парой: число без метрики нечем истолковать (оттиски это или листы —
-- свойство метрики), метрика без числа ничего не сообщает. Порознь они дали бы полуфакт, который
-- назавтра прочтут как факт.
ALTER TABLE device_poll_attempts
  DROP CONSTRAINT IF EXISTS device_poll_attempts_reading_shape;

ALTER TABLE device_poll_attempts
  ADD CONSTRAINT device_poll_attempts_reading_shape CHECK (
    (metric_code IS NULL AND value IS NULL AND unit = '')
    OR (metric_code IS NOT NULL AND value IS NOT NULL AND unit <> '')
  );

ALTER TABLE device_poll_attempts
  DROP CONSTRAINT IF EXISTS device_poll_attempts_value_check;

ALTER TABLE device_poll_attempts
  ADD CONSTRAINT device_poll_attempts_value_check CHECK (value IS NULL OR value >= 0);

-- Экран показывает последнюю попытку каждой цели — этим индексом он её и берёт.
CREATE INDEX IF NOT EXISTS device_poll_attempts_target_idx
  ON device_poll_attempts (target_key, started_at DESC);

-- Частичный: попытки без карточки (серийник не задан, аппарат не опознан) в этот отбор не входят
-- по смыслу, а составляют заметную долю именно на тестовом контуре.
CREATE INDEX IF NOT EXISTS device_poll_attempts_equipment_idx
  ON device_poll_attempts (equipment_id, started_at DESC)
  WHERE equipment_id IS NOT NULL;

-- Караул: таблица есть, оба сторожа формы на месте. Проверяется результат, а не число изменённых
-- объектов, — повторный накат обязан проходить молча.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'device_poll_attempts') THEN
    RAISE EXCEPTION 'миграция 0336: таблица device_poll_attempts не появилась';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_poll_attempts_reading_shape'
  ) THEN
    RAISE EXCEPTION 'миграция 0336: нет сторожа пары «метрика и число» — в журнал пролезет полуфакт';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_poll_attempts_outcome_check'
  ) THEN
    RAISE EXCEPTION 'миграция 0336: перечень исходов не закрыт';
  END IF;
END $$;
