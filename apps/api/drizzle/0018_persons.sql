-- Модель физических лиц, фаза 1 (ADR 0008): persons, трудовые отношения, специализации.
-- Физлицо отделено от учётной записи (users.person_id); водитель — это специализация,
-- отдельных таблиц drivers/driver_profiles нет. Документы и категории — миграция 0019;
-- требования к типу ТС и назначение на заявку — следующие фазы.
-- Миграция аддитивна: существующие таблицы не меняются, кроме одной nullable-колонки в users.
-- Справочник specializations создаётся ПУСТЫМ (наполнение — отдельным шагом).
--
-- Ограничение Postgres: CHECK не может ссылаться на CURRENT_DATE (не IMMUTABLE), поэтому
-- «дата в разумных пределах» проверяется константой, верхняя граница — на уровне сервиса.

-- 1. Тип трудовых отношений (штат / подрядчик / временный).
CREATE TYPE employment_type AS ENUM ('staff', 'contractor', 'temporary');

-- 2. Физические лица. Только универсальные сведения: ни должности, ни специализации,
--    ни работодателя, ни категорий прав здесь нет.
CREATE TABLE persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  last_name text NOT NULL,
  first_name text NOT NULL,
  middle_name text NOT NULL DEFAULT '',
  -- Отображаемое и поисковое ФИО: генерируется БД, чтобы не было второй точки правды.
  full_name text GENERATED ALWAYS AS (btrim(last_name || ' ' || first_name || ' ' || middle_name)) STORED NOT NULL,
  birth_date date,
  phone text NOT NULL DEFAULT '',
  email citext NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT persons_last_name_not_blank CHECK (btrim(last_name) <> ''),
  CONSTRAINT persons_first_name_not_blank CHECK (btrim(first_name) <> ''),
  CONSTRAINT persons_birth_date_sane_check CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01')
);
-- Поиск по ФИО и предупреждение о вероятных дубликатах при заведении (жёсткого UNIQUE нет:
-- однофамильцы-ровесники встречаются, а СНИЛС/ИНН — лишние персональные данные).
CREATE INDEX persons_full_name_trgm ON persons USING gin (full_name gin_trgm_ops);
CREATE INDEX persons_deleted_at_idx ON persons (deleted_at);
CREATE INDEX persons_phone_idx ON persons (phone) WHERE phone <> '';

-- 3. Трудовые отношения (история). Активность работника выводится отсюда (ended_on IS NULL),
--    отдельного флага в persons нет — он бы рассинхронизировался с периодами.
--    Работодатель пока строкой: справочник организаций появится вместе с подрядной техникой,
--    пустая строка = основная организация портала.
CREATE TABLE person_employments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons (id) ON DELETE CASCADE,
  employment_type employment_type NOT NULL DEFAULT 'staff',
  employer_name text NOT NULL DEFAULT '',
  personnel_no text NOT NULL DEFAULT '',
  job_title text NOT NULL DEFAULT '',
  started_on date NOT NULL DEFAULT CURRENT_DATE,
  ended_on date,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_employments_date_order_check CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX person_employments_person_idx ON person_employments (person_id);
CREATE INDEX person_employments_active_idx ON person_employments (person_id) WHERE ended_on IS NULL;
-- Табельный номер уникален среди действующих отношений одного работодателя
-- (после увольнения номер может быть переиспользован).
CREATE UNIQUE INDEX person_employments_personnel_no_unique
  ON person_employments (employer_name, personnel_no)
  WHERE personnel_no <> '' AND ended_on IS NULL;

-- 4. Справочник специализаций: какую работу человек может выполнять.
--    Это НЕ право по документу (категория) — категории появятся в миграции 0019.
--    Таблица создаётся пустой; список водителей заработает после её наполнения.
CREATE TABLE specializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT specializations_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT specializations_name_not_blank CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX specializations_code_unique ON specializations (code);

-- 5. Специализации конкретного человека (несколько одновременно, с периодом действия).
--    Список водителей = выборка по specializations.code = 'driver' с ended_on IS NULL.
CREATE TABLE person_specializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons (id) ON DELETE CASCADE,
  specialization_id uuid NOT NULL REFERENCES specializations (id) ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT false,
  started_on date NOT NULL DEFAULT CURRENT_DATE,
  ended_on date,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_specializations_date_order_check CHECK (ended_on IS NULL OR ended_on >= started_on)
);
-- Одна действующая запись на пару (человек, специализация); закрытые периоды не мешают.
CREATE UNIQUE INDEX person_specializations_active_unique
  ON person_specializations (person_id, specialization_id)
  WHERE ended_on IS NULL;
-- Основная специализация — не более одной действующей на человека (флаг без индекса разъезжается).
CREATE UNIQUE INDEX person_specializations_primary_unique
  ON person_specializations (person_id)
  WHERE is_primary AND ended_on IS NULL;
CREATE INDEX person_specializations_specialization_idx
  ON person_specializations (specialization_id)
  WHERE ended_on IS NULL;

-- 6. Связь учётной записи с физлицом: одна учётка на человека, обе стороны необязательны
--    (человек без доступа в портал — норма). Миграция users.full_name → persons не делается:
--    ФИО учётки остаётся в users, пока связь не установлена (ADR 0008, п. 1).
ALTER TABLE users ADD COLUMN person_id uuid REFERENCES persons (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX users_person_unique ON users (person_id) WHERE person_id IS NOT NULL;
