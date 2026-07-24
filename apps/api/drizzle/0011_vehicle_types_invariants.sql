-- Этап 2.1: инварианты классификатора ТС на уровне БД.
-- Все существующие строки (сид 0010) уже удовлетворяют обоим CHECK:
--   родители — parent_id IS NULL, is_selectable=false; подтипы — наоборот; коды ~ regex.

-- 1. Согласованность уровня и is_selectable:
--    тип (parent_id IS NULL) — невыбираемый; подтип (parent_id задан) — выбираемый.
ALTER TABLE vehicle_types
  ADD CONSTRAINT vehicle_types_level_selectable_check
  CHECK (
    (parent_id IS NULL AND is_selectable = false)
    OR
    (parent_id IS NOT NULL AND is_selectable = true)
  );

-- 2. Формат системного кода: ^[a-z][a-z0-9_]*$ (строчные латинские, цифры, _, первый — буква).
ALTER TABLE vehicle_types
  ADD CONSTRAINT vehicle_types_code_format_check
  CHECK (code ~ '^[a-z][a-z0-9_]*$');
