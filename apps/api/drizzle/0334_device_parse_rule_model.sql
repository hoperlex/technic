-- Условие правила разбора по МОДЕЛИ аппарата: одно правило на модельный ряд вместо правила на
-- каждый аппарат.
--
-- Решение — docs/adr/0204-device-parse-rule-model.md; правила разбора заведены
-- docs/adr/0200-device-mail-identity-ui.md (миграция 0324_device_parse_rules.sql).
--
-- ОТКУДА НОМЕР. Снимок ls apps/api/drizzle 22.09.2026: последней в дереве стоит
-- 0333_releases_recognition_health.sql, файлов 0334 нет ни в одной ветке.
--
-- ПУСТАЯ СТРОКА, А НЕ NULL. «Условия нет» у отправителя и темы уже выражается пустой строкой;
-- третье состояние у четвёртого условия читалось бы как особое, и `coalesce` в уникальном индексе
-- пришлось бы держать ещё для одной колонки.
--
-- УНИКАЛЬНЫЙ ИНДЕКС ПЕРЕСОБИРАЕТСЯ, И ЭТО ОБЯЗАТЕЛЬНАЯ ЧАСТЬ ПРАВКИ. Ключ дубля перечисляет
-- условия применимости поимённо; не добавь сюда модель — и два правила одной метки, писанные для
-- разных модельных рядов, столкнулись бы как повтор: второе получило бы отказ «Такое правило уже
-- заведено», а человек не увидел бы причины, потому что видимой разницы между ними нет ни одной.
--
-- ОКНО ВЫКАТА. Миграция идёт при работающем портале и до перезапуска приложения (docs/runbook.md),
-- значит какое-то время колонку не пишет никто: старый код о ней не знает. Умолчание `''` делает
-- это безопасным — правила, заведённые в окне, получают «условия нет», то есть ровно то поведение,
-- которое у них было до выката.
--
-- ОТКАТ КОДА ОПАСНЕЕ ВЫКАТА, И ЭТО НАДО СКАЗАТЬ ПРЯМО. `deploy-auto --previous` (docs/runbook.md)
-- возвращает прежний код и СХЕМУ НЕ ТРОГАЕТ: колонка остаётся, а старый загрузчик правил её не
-- читает. Правило, писанное на один модельный ряд, после такого отката применяется КО ВСЕМУ ПАРКУ
-- — то есть кладёт чужое число в чужой ряд наработки, и заметить это некому. Поэтому откат кода
-- этой волны обязан сопровождаться выключением правил с моделью:
--   UPDATE device_mail_parse_rules SET is_enabled = false WHERE when_model <> '';
--
-- ОБРАТИМОСТЬ (выполнять ОДНОЙ командой, в одной транзакции): вернуть прежний уникальный индекс и
-- снять колонку. Построчно эти три инструкции выполнять нельзя: `DROP INDEX` закоммитится, а
-- `CREATE` упадёт на правилах, различавшихся только моделью, — и таблица останется без сторожа
-- уникальности вовсе.
--   DROP INDEX device_mail_parse_rules_unique;
--   CREATE UNIQUE INDEX device_mail_parse_rules_unique ON device_mail_parse_rules
--     (target, coalesce(key_kind,''), coalesce(metric_code,''), coalesce(component,''), expression,
--      coalesce(when_profile,''), when_from, when_subject);
--   ALTER TABLE device_mail_parse_rules DROP COLUMN when_model;
-- Правила, различавшиеся только моделью, к этому моменту станут дублями, и индекс не соберётся,
-- пока лишние не убраны, — это признак, а не помеха: они и правда неразличимы без колонки.

ALTER TABLE device_mail_parse_rules
  ADD COLUMN IF NOT EXISTS when_model text NOT NULL DEFAULT '';

ALTER TABLE device_mail_parse_rules
  DROP CONSTRAINT IF EXISTS device_mail_parse_rules_model_check;

ALTER TABLE device_mail_parse_rules
  ADD CONSTRAINT device_mail_parse_rules_model_check CHECK (length(when_model) <= 200);

DROP INDEX IF EXISTS device_mail_parse_rules_unique;

CREATE UNIQUE INDEX device_mail_parse_rules_unique
  ON device_mail_parse_rules (
    target,
    coalesce(key_kind, ''),
    coalesce(metric_code, ''),
    coalesce(component, ''),
    expression,
    coalesce(when_profile, ''),
    when_from,
    when_subject,
    when_model
  );

-- Индекс под выбор писем для проверки правила: `WHERE raw_state = 'stored' ORDER BY received_at
-- DESC LIMIT 50`. Частичный, потому что отбор частичный: строки писем не удаляются никогда (по
-- сроку чистится только сырьё, и строка становится `purged`), так что доля годных со временем
-- падает, а очередной поиск без индекса сканировал бы всю таблицу ради пятидесяти строк.
CREATE INDEX IF NOT EXISTS device_mail_messages_samples_idx
  ON device_mail_messages (received_at DESC, id DESC)
  WHERE raw_state = 'stored';

-- Караул: колонка есть, и ключ дубля её знает. Проверяется РЕЗУЛЬТАТ, а не число изменённых
-- объектов: повторный накат обязан проходить молча.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'device_mail_parse_rules' AND column_name = 'when_model'
  ) THEN
    RAISE EXCEPTION 'миграция 0334: колонка when_model не появилась';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'device_mail_parse_rules_unique'
       AND indexdef LIKE '%when_model%'
  ) THEN
    RAISE EXCEPTION 'миграция 0334: ключ дубля не знает о модели — два правила одного ряда столкнутся';
  END IF;
END $$;
