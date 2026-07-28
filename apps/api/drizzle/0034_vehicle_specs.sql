-- ТТХ типов ТС — Фаза 1: справочник характеристик и их привязка к типам.
-- См. docs/adr/0016-vehicle-type-specs-and-categories.md.
-- Таблицы создаются ПУСТЫМИ: наполняет человек через справочник (генерации/сида нет).

-- 1. Справочник ТТХ. Глобальный, а не «поле типа»: «Грузоподъёмность, т» — одна запись, общая
--    для автокранов и самосвалов, иначе кросс-типовой отбор по характеристике невозможен.
--    unit/decimals входят в смысл канонизации значения и замораживаются после первого значения
--    (проверяет сервис — ссылки на значения через тип, одним CHECK'ом не выразить).
CREATE TABLE vehicle_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  -- Короткое имя для наименования категории («г/п»); пусто — берётся name.
  short_name text NOT NULL DEFAULT '',
  -- Единица измерения; пусто — безразмерная характеристика (число осей).
  unit text NOT NULL DEFAULT '',
  -- Задел под перечисления/флаги: расширение аддитивно (снять CHECK + таблица опций).
  value_kind text NOT NULL DEFAULT 'number',
  decimals smallint NOT NULL DEFAULT 0,
  min_value numeric(14, 4),
  max_value numeric(14, 4),
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_specs_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT vehicle_specs_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT vehicle_specs_value_kind_check CHECK (value_kind IN ('number')),
  CONSTRAINT vehicle_specs_decimals_range_check CHECK (decimals BETWEEN 0 AND 3),
  CONSTRAINT vehicle_specs_bounds_check
    CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);
CREATE UNIQUE INDEX vehicle_specs_code_unique ON vehicle_specs (code);
-- Пара «наименование + единица» уникальна: «Длина, м» и «Длина, мм» — разные ТТХ, но два
-- «Грузоподъёмность, т» — дубль, который развёл бы категории по двум одинаковым характеристикам.
CREATE UNIQUE INDEX vehicle_specs_name_unit_unique
  ON vehicle_specs (lower(btrim(name)), lower(btrim(unit)));
CREATE INDEX vehicle_specs_active_sort_idx ON vehicle_specs (is_active, sort_order);

-- 2. Привязка ТТХ к типу. Привязка = обязательность: колонки is_required нет намеренно — раз ТТХ
--    привязан к типу, каждая категория типа обязана иметь по нему значение (ADR 0016 §2).
--    PK (vehicle_type_id, spec_id) — одновременно цель составного FK из значений категорий (0035):
--    он и запрещает значение по ТТХ, не привязанному к типу.
--    RESTRICT на spec_id: используемый ТТХ нельзя удалить из справочника.
CREATE TABLE vehicle_type_specs (
  vehicle_type_id uuid NOT NULL REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  spec_id uuid NOT NULL REFERENCES vehicle_specs (id) ON DELETE RESTRICT,
  -- Порядок полей в форме категории и порядок частей в её наименовании.
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_type_specs_pkey PRIMARY KEY (vehicle_type_id, spec_id)
);
CREATE INDEX vehicle_type_specs_spec_idx ON vehicle_type_specs (spec_id);
