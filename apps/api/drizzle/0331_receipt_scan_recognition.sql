-- Распознавание чека на автозапчасти: скан, его страницы и попытки чтения.
--
-- План — docs/auto-part-receipt-ocr-plan.md (Р4, Р7, Р12, §8). Решение того же имени ещё не
-- записано: этот выкат привозит ТОЛЬКО таблицы и воркер, а ручки и окно приедут следом.
--
-- ОТКУДА НОМЕР. Снимок ls apps/api/drizzle 21.09.2026: последней в дереве стоит
-- 0330_releases_receipt_line_article.sql, файлов 0331 нет.
--
-- ТРИ ТАБЛИЦЫ И НИ ОДНОЙ ССЫЛКИ НА ЧЕК. Скан читается РАНЬШЕ, чем появляется чек: в окне «Принять
-- чек» файл грузят первым, а документа ещё нет и может не быть вовсе. Поэтому работа висит на
-- file_id, а не на владельце.
--
-- ПОПЫТКА НЕ ССЫЛАЕТСЯ НИ НА СТРАНИЦУ, НИ НА ФАЙЛ, и это решение, а не пропуск: она принадлежит
-- СОДЕРЖИМОМУ (page_sha256) и служит кэшем. Непривязанный файл сносит и сама форма крестиком, и
-- уборка сирот воркера; с ON DELETE CASCADE круг «загрузил → передумал → загрузил снова» уносил бы
-- кэш, и повторное чтение того же листа снова стоило бы денег. У талонов ссылки нет по той же
-- причине — там её уносит откат заявки.
--
-- ЧАСТИЧНЫЙ UNIQUE КЭША повторяет талонный: одна успешная попытка на ключ, неуспешных сколько
-- угодно (иначе повтор после разрыва сети был бы заперт), и `NOT forced` выводит из-под
-- ограничения принудительный проход — без него кнопка «распознать заново» молча возвращала бы
-- старый ответ.
--
-- ОКНО НАКАТА. Миграция аддитивна: таблицы новые, в старый код не входит ни одна. Пишет в них
-- только воркер этого же выката, и до его старта они просто пусты.
--
-- ОБРАТИМОСТЬ: DROP TABLE в обратном порядке (попытки, страницы, сканы). Данные при этом теряются
-- только служебные — ни один чек на них не ссылается.

CREATE TABLE auto_part_receipt_scans (
  file_id         uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending',
  total_pages     smallint NOT NULL DEFAULT 0,
  processed_pages smallint NOT NULL DEFAULT 0,
  error_class     text NOT NULL DEFAULT '',
  error_scope     text NOT NULL DEFAULT '',
  error           text NOT NULL DEFAULT '',
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_part_receipt_scans_status_check
    CHECK (status IN ('pending', 'done', 'failed', 'unsupported')),
  CONSTRAINT auto_part_receipt_scans_error_class_check
    CHECK (error_class IN ('', 'transient', 'terminal')),
  CONSTRAINT auto_part_receipt_scans_error_scope_check
    CHECK (error_scope IN ('', 'subsystem', 'item')),
  CONSTRAINT auto_part_receipt_scans_pages_check
    CHECK (total_pages >= 0 AND processed_pages >= 0 AND processed_pages <= total_pages)
);

CREATE TABLE auto_part_receipt_scan_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES auto_part_receipt_scans(file_id) ON DELETE CASCADE,
  page_no     smallint NOT NULL,
  page_sha256 char(64) NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  error_class text NOT NULL DEFAULT '',
  error_scope text NOT NULL DEFAULT '',
  error       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_part_receipt_scan_pages_file_page_unique UNIQUE (file_id, page_no),
  CONSTRAINT auto_part_receipt_scan_pages_page_no_check CHECK (page_no >= 1),
  CONSTRAINT auto_part_receipt_scan_pages_status_check
    CHECK (status IN ('pending', 'done', 'failed')),
  CONSTRAINT auto_part_receipt_scan_pages_sha256_check CHECK (page_sha256 ~ '^[0-9a-f]{64}$')
);

-- По хэшу отвечают оба вопроса сразу: «читали ли мы уже этот лист» (кэш) и «не подшит ли он к
-- другому чеку» — второе и есть единственная защита от двойного ввода одной покупки: уникальности
-- у номера чека нет и быть не может, два чека «0001» из разных магазинов законны.
CREATE INDEX auto_part_receipt_scan_pages_sha256_idx ON auto_part_receipt_scan_pages (page_sha256);

CREATE TABLE auto_part_receipt_recognition_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_sha256           char(64) NOT NULL,
  engine                text NOT NULL,
  model                 text NOT NULL DEFAULT '',
  model_reported        text NOT NULL DEFAULT '',
  prompt_version        integer NOT NULL,
  preprocessing_version integer NOT NULL,
  status                text NOT NULL,
  forced                boolean NOT NULL DEFAULT false,
  raw                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens          integer,
  output_tokens         integer,
  duration_ms           integer,
  proxy_request_id      text NOT NULL DEFAULT '',
  upstream_request_id   text NOT NULL DEFAULT '',
  error_code            text NOT NULL DEFAULT '',
  error_class           text NOT NULL DEFAULT '',
  error_scope           text NOT NULL DEFAULT '',
  error                 text NOT NULL DEFAULT '',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_part_receipt_attempts_engine_check CHECK (engine IN ('stub', 'proxy', 'ocr')),
  CONSTRAINT auto_part_receipt_attempts_status_check CHECK (status IN ('done', 'failed')),
  CONSTRAINT auto_part_receipt_attempts_error_class_check
    CHECK (error_class IN ('', 'transient', 'terminal')),
  CONSTRAINT auto_part_receipt_attempts_error_scope_check
    CHECK (error_scope IN ('', 'subsystem', 'item')),
  CONSTRAINT auto_part_receipt_attempts_sha256_check CHECK (page_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX auto_part_receipt_attempts_cache_unique
  ON auto_part_receipt_recognition_attempts
     (page_sha256, engine, model, prompt_version, preprocessing_version)
  WHERE status = 'done' AND NOT forced;

CREATE INDEX auto_part_receipt_attempts_page_created_idx
  ON auto_part_receipt_recognition_attempts (page_sha256, created_at DESC);
