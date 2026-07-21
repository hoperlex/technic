-- Инициализация схемы (этап 1).
-- Расширения pgcrypto, citext, pg_trgm включаются ops-ом ДО миграций (§8) —
-- здесь CREATE EXTENSION не выполняется.

CREATE TYPE role AS ENUM ('admin', 'manager', 'dispatcher', 'shtab');
CREATE TYPE request_status AS ENUM ('new', 'confirmed', 'done', 'cancelled');
CREATE TYPE request_type AS ENUM ('onetime', 'weekly');
CREATE TYPE file_status AS ENUM ('pending', 'active', 'deleted');
CREATE TYPE job_status AS ENUM ('pending', 'running', 'done', 'failed', 'dead');

CREATE TABLE construction_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX construction_objects_code_unique ON construction_objects (code);
-- GIN/pg_trgm: в Yandex Managed включается в консоли кластера, не через SQL.
-- Пока btree (поиск — ILIKE); после включения pg_trgm можно заменить на gin_trgm_ops.
CREATE INDEX construction_objects_name_trgm ON construction_objects (name);

CREATE TABLE container_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX container_types_code_unique ON container_types (code);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  role role,
  construction_object_id uuid REFERENCES construction_objects (id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT false,
  must_change_password boolean NOT NULL DEFAULT false,
  auth_version integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_full_name_trgm ON users (full_name);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refresh_sessions_token_hash_unique ON refresh_sessions (token_hash);
CREATE INDEX refresh_sessions_user_idx ON refresh_sessions (user_id);
CREATE INDEX refresh_sessions_family_idx ON refresh_sessions (family_id);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  object_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  status file_status NOT NULL DEFAULT 'pending',
  scan_status text NOT NULL DEFAULT 'pending',
  uploaded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX files_object_key_unique ON files (object_key);
CREATE INDEX files_status_idx ON files (status);

CREATE TABLE waste_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  container_type_id uuid NOT NULL REFERENCES container_types (id) ON DELETE RESTRICT,
  request_type request_type NOT NULL,
  delivery_at timestamptz NOT NULL,
  comment text NOT NULL DEFAULT '',
  status request_status NOT NULL DEFAULT 'new',
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX waste_requests_status_idx ON waste_requests (status);
CREATE INDEX waste_requests_object_idx ON waste_requests (object_id);
CREATE INDEX waste_requests_delivery_idx ON waste_requests (delivery_at);
CREATE INDEX waste_requests_created_at_idx ON waste_requests (created_at);

CREATE TABLE request_files (
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  CONSTRAINT request_files_pk PRIMARY KEY (request_id, file_id)
);
CREATE INDEX request_files_file_idx ON request_files (file_id);

CREATE TABLE request_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  from_status request_status,
  to_status request_status NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_status_history_request_idx ON request_status_history (request_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status job_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (status, next_run_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at);

-- Seed справочника типов контейнеров (управляется менеджером, но начальный набор фиксирован)
INSERT INTO container_types (code, name, sort_order) VALUES
  ('container_8', 'Контейнер 8 м³', 10),
  ('container_20', 'Контейнер 20 м³', 20),
  ('container_27', 'Контейнер 27 м³', 30),
  ('container_25_heavy', 'Контейнер 25 м³ для тяжёлых грузов', 40),
  ('dump_truck_25', 'Самосвал 25 м³', 50),
  ('dump_truck_36', 'Самосвал 36 м³', 60)
ON CONFLICT (code) DO NOTHING;
