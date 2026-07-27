-- Плоский классификатор ТС — Фаза 3 (Contract). См. docs/adr/0005-vehicle-types-flatten.md.
-- НЕОБРАТИМО: сносит старую иерархию (типы+подтипы, колонки parent_id/is_selectable) и таблицу
-- сопоставлений. Применять ТОЛЬКО когда старых клиентов не осталось (Фазы 1–2 выкачены и
-- подтверждены): иначе ещё живой старый бэкенд/фронт сломается. Один файл = одна транзакция.

-- 1. Guard: не должно остаться заявок, ссылающихся на НЕплоскую строку
--    (плоская строка — parent_id IS NULL AND is_selectable = true). Иначе — стоп, разбор вручную.
DO $$
DECLARE
  stale int;
BEGIN
  SELECT count(*) INTO stale
  FROM vehicle_requests r
  JOIN vehicle_types t ON t.id = r.vehicle_type_id
  WHERE NOT (t.parent_id IS NULL AND t.is_selectable = true);
  IF stale > 0 THEN
    RAISE EXCEPTION 'Заявки ТС (% шт.) всё ещё ссылаются на старые типы/подтипы. Дождитесь выката Фаз 1–2 и ремапа перед 0014.', stale;
  END IF;
END $$;

-- 2. Таблица сопоставлений исходных «Тип ТС» больше не нужна (тип = исходный «Тип ТС»).
DROP TABLE IF EXISTS vehicle_type_source_mappings;

-- 3. Снимаем самоссылочные ограничения, чтобы удаление родителей не блокировалось детьми.
ALTER TABLE vehicle_types
  DROP CONSTRAINT IF EXISTS vehicle_types_parent_same_kind,
  DROP CONSTRAINT IF EXISTS vehicle_types_no_self_parent,
  DROP CONSTRAINT IF EXISTS vehicle_types_id_kind_unique;
DROP INDEX IF EXISTS vehicle_types_parent_idx;

-- 4. Удаляем всё, кроме плоских типов (старые родители + подтипы). Заявки уже не ссылаются на них (guard).
DELETE FROM vehicle_types WHERE NOT (parent_id IS NULL AND is_selectable = true);

-- 5. Убираем иерархические колонки. Плоская модель: тип = kind_id + code + name + описательные поля.
ALTER TABLE vehicle_types
  DROP COLUMN parent_id,
  DROP COLUMN is_selectable;
