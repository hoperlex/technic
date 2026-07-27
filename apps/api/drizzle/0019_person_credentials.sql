-- Документы работников и квалификационные категории, фаза 2 (ADR 0008).
-- Два уровня справочника: вид документа (credential_types) → категория (qualification_categories).
-- Уровень «система квалификации» не заводится: «C» водительского и «C» тракториста разводятся
-- принадлежностью категории к виду документа.
-- Категория человека не существует отдельно от документа: person_credentials →
-- person_credential_categories. Истёк документ — перестают действовать все его категории.
-- Справочники создаются ПУСТЫМИ (наполнение — отдельным шагом).

-- 1. Статус проверки документа. Отделён от срока действия: непросроченный, но непроверенный
--    документ не является подтверждённым допуском (решение о блокировке — на уровне сервиса).
CREATE TYPE credential_verification_status AS ENUM ('unverified', 'verified', 'rejected');

-- 2. Виды документов: национальное ВУ, удостоверение тракториста-машиниста, удостоверение
--    машиниста крана, оператора КМУ, стропальщика, медицинское заключение и т. п.
--    has_categories=false — документ без категорий (медзаключение, свидетельство об обучении).
--    expiry_required=false — бессрочный документ.
CREATE TABLE credential_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  has_categories boolean NOT NULL DEFAULT true,
  expiry_required boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_types_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT credential_types_name_not_blank CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX credential_types_code_unique ON credential_types (code);

-- 3. Категории (квалификации) конкретного вида документа. UNIQUE (id, credential_type_id) —
--    цель составного FK из person_credential_categories (тот же приём, что и в 0009).
CREATE TABLE qualification_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_type_id uuid NOT NULL REFERENCES credential_types (id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qualification_categories_id_type_unique UNIQUE (id, credential_type_id),
  CONSTRAINT qualification_categories_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT qualification_categories_name_not_blank CHECK (btrim(name) <> '')
);
-- Код категории уникален внутри вида документа, но не глобально: 'c' есть и у ВУ, и у тракториста.
CREATE UNIQUE INDEX qualification_categories_code_unique
  ON qualification_categories (credential_type_id, code);

-- 4. Документы конкретных людей. Новый документ не перезаписывает старый — история сохраняется;
--    аннулирование (revoked_at) отделено от удаления записи (deleted_at) и от истечения срока.
CREATE TABLE person_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons (id) ON DELETE CASCADE,
  credential_type_id uuid NOT NULL REFERENCES credential_types (id) ON DELETE RESTRICT,
  series text NOT NULL DEFAULT '',
  number text NOT NULL DEFAULT '',
  issued_on date,
  expires_on date,
  issued_by text NOT NULL DEFAULT '',
  verification_status credential_verification_status NOT NULL DEFAULT 'unverified',
  verified_by uuid REFERENCES users (id) ON DELETE SET NULL,
  verified_at timestamptz,
  verification_comment text NOT NULL DEFAULT '',
  revoked_at timestamptz,
  revoke_reason text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_credentials_id_type_unique UNIQUE (id, credential_type_id),
  CONSTRAINT person_credentials_date_order_check
    CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  -- Проверка — учётное действие: у проверенного/отклонённого документа известно, когда это было.
  CONSTRAINT person_credentials_verified_at_check
    CHECK ((verification_status = 'unverified') = (verified_at IS NULL))
);
CREATE INDEX person_credentials_person_idx ON person_credentials (person_id) WHERE deleted_at IS NULL;
CREATE INDEX person_credentials_type_idx ON person_credentials (credential_type_id);
CREATE INDEX person_credentials_verification_idx
  ON person_credentials (verification_status) WHERE deleted_at IS NULL;
-- Под отчёт по истекающим документам и напоминания через существующий outbox jobs.
CREATE INDEX person_credentials_expires_idx
  ON person_credentials (expires_on) WHERE deleted_at IS NULL AND revoked_at IS NULL;
-- Один и тот же документ не заводится дважды (серия может быть пустой, номер — нет).
CREATE UNIQUE INDEX person_credentials_number_unique
  ON person_credentials (credential_type_id, series, number)
  WHERE number <> '' AND deleted_at IS NULL;

-- 5. Категории, открытые конкретным документом. Собственные сроки категории (valid_from/valid_to)
--    сужают срок документа, но не продлевают его.
--    credential_type_id денормализован ради двух составных FK: категория обязана принадлежать
--    тому же виду документа, что и сам документ — «C» тракториста не встанет в водительское.
CREATE TABLE person_credential_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL,
  qualification_category_id uuid NOT NULL,
  credential_type_id uuid NOT NULL,
  valid_from date,
  valid_to date,
  restrictions text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_credential_categories_credential_fk
    FOREIGN KEY (credential_id, credential_type_id)
    REFERENCES person_credentials (id, credential_type_id) ON DELETE CASCADE,
  CONSTRAINT person_credential_categories_category_fk
    FOREIGN KEY (qualification_category_id, credential_type_id)
    REFERENCES qualification_categories (id, credential_type_id) ON DELETE RESTRICT,
  CONSTRAINT person_credential_categories_date_order_check
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX person_credential_categories_unique
  ON person_credential_categories (credential_id, qualification_category_id);
CREATE INDEX person_credential_categories_category_idx
  ON person_credential_categories (qualification_category_id);

-- 6. Сканы документа: у одного документа может быть несколько файлов. Паттерн — как
--    vehicle_request_files: UNIQUE (file_id), файл не принадлежит двум документам.
CREATE TABLE person_credential_files (
  credential_id uuid NOT NULL REFERENCES person_credentials (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, file_id)
);
CREATE UNIQUE INDEX person_credential_files_file_unique ON person_credential_files (file_id);
