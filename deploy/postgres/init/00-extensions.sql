-- Расширения включаются ДО миграций (§8). В проде это делает ops в Yandex
-- Managed PostgreSQL; здесь — для локального dev-контейнера postgres.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
