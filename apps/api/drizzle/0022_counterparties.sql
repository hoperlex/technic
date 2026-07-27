-- Контрагенты (ADR 0010): генподрядчики, подрядчики и операторы вывоза мусора.
--
-- Идентичность контрагента — ИНН. Под одним ИНН организация встречается в документах под разными
-- наименованиями («ООО «Ромашка»», «Ромашка ООО», «РОМАШКА»), поэтому наименований два уровня:
-- основное (counterparties.name — как пишем сами) и синонимы (counterparty_synonyms — как пишут
-- в накладных и выгрузках). Тип у записи один: организация в двух ролях — это решение о смене
-- типа записи, а не вторая запись с тем же ИНН.

-- 1. Нормализация наименования — IMMUTABLE-функция для GENERATED-колонок и поиска (приём из 0015:
--    приложение не дублирует нормализацию, а вызывает функцию в запросах). Регистр, ё→е, кавычки
--    и любые разделители схлопываются в один пробел: «ООО «Ромашка-2»» → «ооо ромашка 2».
--    Организационно-правовая форма НЕ отбрасывается: «ООО Ромашка» и «АО Ромашка» — разные лица.
CREATE FUNCTION counterparty_name_normalize(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT btrim(regexp_replace(translate(lower(t), 'ё', 'е'), '[^a-z0-9а-я]+', ' ', 'g'))
$$;

CREATE TYPE counterparty_type AS ENUM ('general_contractor', 'contractor', 'operator');

-- 2. Контрагенты.
CREATE TABLE counterparties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type counterparty_type NOT NULL,
  name text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (counterparty_name_normalize(name)) STORED,
  inn text NOT NULL,
  comment text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counterparties_name_not_blank_check CHECK (counterparty_name_normalize(name) <> ''),
  -- ИНН: 10 знаков у организации, 12 — у ИП/физлица. Контрольная сумма проверяется в сервисе
  -- (алгоритм с весами в CHECK нечитаем и меняется вместе с требованиями ФНС).
  CONSTRAINT counterparties_inn_format_check CHECK (inn ~ '^([0-9]{10}|[0-9]{12})$')
);
-- ИНН — ключ идентичности: одна живая запись на ИНН. Soft-delete не занимает ИНН навсегда.
CREATE UNIQUE INDEX counterparties_inn_unique ON counterparties (inn) WHERE deleted_at IS NULL;
CREATE INDEX counterparties_type_active_idx ON counterparties (type, is_active)
  WHERE deleted_at IS NULL;
CREATE INDEX counterparties_name_trgm ON counterparties USING gin (name gin_trgm_ops);
CREATE INDEX counterparties_normalized_name_idx ON counterparties (normalized_name);
CREATE INDEX counterparties_deleted_at_idx ON counterparties (deleted_at);

-- 3. Синонимы наименования. Основное наименование в этой таблице не дублируется — поиск идёт
--    объединением двух источников (counterparties.normalized_name и синонимы).
CREATE TABLE counterparty_synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES counterparties (id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (counterparty_name_normalize(name)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counterparty_synonyms_name_not_blank_check
    CHECK (counterparty_name_normalize(name) <> '')
);
-- Уникальность глобальная, а не внутри контрагента: синоним существует ради однозначного ответа
-- «чьё это наименование», и один и тот же текст не может указывать на двух контрагентов.
CREATE UNIQUE INDEX counterparty_synonyms_name_unique ON counterparty_synonyms (normalized_name);
CREATE INDEX counterparty_synonyms_counterparty_idx ON counterparty_synonyms (counterparty_id);
CREATE INDEX counterparty_synonyms_name_trgm ON counterparty_synonyms USING gin (name gin_trgm_ops);

-- 4. Оператор заявки на вывоз мусора: кто фактически вывозит. Назначается менеджером/диспетчером,
--    пустое значение — оператор ещё не выбран. Ограничение «тип контрагента = operator» держит
--    сервис: составной FK потребовал бы хранить тип контрагента в самой заявке.
ALTER TABLE waste_requests
  ADD COLUMN operator_counterparty_id uuid REFERENCES counterparties (id) ON DELETE RESTRICT;
CREATE INDEX waste_requests_operator_idx ON waste_requests (operator_counterparty_id)
  WHERE operator_counterparty_id IS NOT NULL;

-- 5. Контрагент учётной записи: для роли «Оператор» задаёт, чьи заявки видит пользователь
--    (аналог construction_object_id у «Штаба»). RESTRICT — удалить контрагента с учётками нельзя.
ALTER TABLE users
  ADD COLUMN counterparty_id uuid REFERENCES counterparties (id) ON DELETE RESTRICT;
CREATE INDEX users_counterparty_idx ON users (counterparty_id) WHERE counterparty_id IS NOT NULL;

-- 6. Роль оператора вывоза мусора. CHECK «у оператора обязан быть контрагент» — в 0023: новое
--    значение enum нельзя использовать в той же транзакции, где оно добавлено.
ALTER TYPE role ADD VALUE IF NOT EXISTS 'operator';
