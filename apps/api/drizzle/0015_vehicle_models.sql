-- Справочник «Марка/модель» ТС (ADR 0007). Единая сущность: одна запись = одно наименование
-- марки/модели, используемое в проекте («Mustang 2700V», «JCB TLT30C», «МАЗ 6501В5»).
-- Отдельной таблицы производителей (vehicle_makes) НЕТ: изготовитель — текстовое поле.
-- Модель жёстко принадлежит плоскому типу ТС (ADR 0005): одинаковое имя в разных типах — разные записи.

-- 1. Нормализация наименований — IMMUTABLE-функции, используются в GENERATED-колонках.
--    Это ЕДИНСТВЕННЫЙ источник истины: приложение не дублирует нормализацию, а вызывает функцию
--    в запросах (WHERE normalized_name = vehicle_model_normalize($1)).
--
--    vehicle_model_normalize — механическая нормализация: регистр, ё→е, любые разделители
--    (пробелы, дефисы, запятые, кавычки, точки) схлопываются в один пробел.
--    Транслитерация (Мустанг→Mustang) сюда НЕ входит — это знание, а не функция от строки;
--    такие случаи разбираются человеком при заведении записи.
CREATE FUNCTION vehicle_model_normalize(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT btrim(regexp_replace(translate(lower(t), 'ё', 'е'), '[^a-z0-9а-я]+', ' ', 'g'))
$$;

--    vehicle_reg_normalize — госномер: удаляем разделители, верхний регистр и заменяем кириллические
--    гомоглифы на латиницу. Алфавит регистрационных знаков РФ — АВЕКМНОРСТУХ, у каждой буквы есть
--    визуальный латинский двойник, поэтому замена однозначна и безопасна. «В 094 ЕТ 77», «В094ЕТ77»
--    и «B094ET77» дают одно значение B094ET77; «ХО 4654 50» и «ХО4654 50» → XO465450.
CREATE FUNCTION vehicle_reg_normalize(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT nullif(
    translate(
      upper(regexp_replace(t, '[^0-9A-Za-zА-Яа-яЁё]+', '', 'g')),
      'АВЕКМНОРСТУХ',
      'ABEKMHOPCTYX'
    ),
    ''
  )
$$;

-- 2. Таблица марок/моделей.
CREATE TABLE vehicle_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_type_id uuid NOT NULL REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  name text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (vehicle_model_normalize(name)) STORED,
  description text NOT NULL DEFAULT '',
  manufacturer_name text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Имя должно оставаться значимым после нормализации: «---» или « » недопустимы.
  -- CHECK ссылается на name (не на generated-колонку) — так ограничение не зависит от порядка вычисления.
  CONSTRAINT vehicle_models_name_not_blank_check CHECK (vehicle_model_normalize(name) <> ''),
  -- Цель составного FK из vehicles: позволяет сослаться на пару (модель, её тип) и тем самым
  -- физически запретить расхождение типа ТС и типа его модели. См. миграцию 0017.
  CONSTRAINT vehicle_models_id_type_unique UNIQUE (id, vehicle_type_id)
);

-- Один и тот же нормализованный текст внутри типа — одна запись (защита от дублей при заведении).
CREATE UNIQUE INDEX vehicle_models_type_name_unique ON vehicle_models (vehicle_type_id, normalized_name);
CREATE INDEX vehicle_models_type_active_idx ON vehicle_models (vehicle_type_id, is_active);
CREATE INDEX vehicle_models_normalized_name_idx ON vehicle_models (normalized_name);
