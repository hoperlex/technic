-- Обратная миграция к `0136_route_trips.sql` (протокол выката, §7).
--
-- Вызывается только `db:cutover-down` — из `apps/api/drizzle` этот файл намеренно вынесен: раннер
-- берёт оттуда каждый `*.sql`, и лежи teardown там, ближайший `db:migrate` применил бы его следом
-- за миграцией, сняв только что накатанное и молча.
--
-- ЧТО ЗДЕСЬ ВОЗМОЖНО И ЧЕГО НЕТ. Миграция необратима по смыслу данных: заявка с двумя ездками в
-- пару колонок не помещается, и вернуть её нечем. Teardown это и не обещает — он возвращает
-- колонки из ПЕРВОЙ ездки каждой заявки и рассчитан ровно на то окно, в котором применяется: между
-- накатом и записью границы floor (шаги 5–7 протокола), когда сервисы лежат и новый код не
-- отработал ни секунды. В этом окне у каждой заявки ровно одна ездка — та, которую завёл бэкфил, —
-- и возврат точен. После записи floor teardown не запускается вовсе: там откат запрещён навсегда
-- (Р23), и это гейт `--cutover-revert`, а не оговорка в комментарии.
--
-- Снимается ВСЁ, что завела миграция, включая данные: забытая строка в справочнике или в журнале
-- выпусков не даст накатить миграцию повторно, то есть откат сделает релиз невыкатываемым.
-- Проверяется репетицией (протокол §9, п. 1 и 2).
--
-- Порядок обратный порядку миграции: сначала данные возвращаются в заявку, и только потом сносятся
-- таблицы, из которых они возвращаются.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Возврат колонок заявки.
--
-- Колонки добавляются в том же относительном порядке, в каком стояли: так `\d` таблицы читается
-- как прежде. Совпадения `ordinal_position` при этом не будет и быть не может — `DROP COLUMN`
-- оставляет в каталоге дыру, а новые колонки получают номера с конца. Приложению это безразлично:
-- и запросы, и Drizzle обращаются к колонкам по имени.
--
-- NOT NULL у адресов ставится ПОСЛЕ заполнения: колонка объявлена без умолчания, и добавить её
-- сразу непустой на непустой таблице нечем. Контакты, наоборот, добавляются готовыми — у них
-- умолчание `''`, ровно как было.
ALTER TABLE freight_transport_request_details
  ADD COLUMN volume_m3 numeric(12, 3),
  ADD COLUMN weight_tons numeric(12, 3),
  ADD COLUMN loading_location text,
  ADD COLUMN unloading_location text,
  ADD COLUMN loading_address jsonb,
  ADD COLUMN unloading_address jsonb,
  ADD COLUMN loading_responsible_name text NOT NULL DEFAULT '',
  ADD COLUMN loading_responsible_phone text NOT NULL DEFAULT '',
  ADD COLUMN unloading_responsible_name text NOT NULL DEFAULT '',
  ADD COLUMN unloading_responsible_phone text NOT NULL DEFAULT '';

-- Предохранитель до записи: строка деталей без единой ездки означала бы, что откат оставит заявку
-- без адресов, — и `SET NOT NULL` ниже упал бы кодом 23502, ничего об этом не сказав.
DO $$
DECLARE
  orphan int;
BEGIN
  SELECT count(*) INTO orphan
  FROM freight_transport_request_details d
  WHERE NOT EXISTS (SELECT 1 FROM vehicle_request_trips t WHERE t.request_id = d.request_id);
  IF orphan > 0 THEN
    RAISE EXCEPTION
      'Строк деталей без единой ездки: % шт. Откат оставил бы эти заявки без адресов; '
      'разберите их до `db:cutover-down 0136_route_trips.sql`.',
      orphan;
  END IF;
END $$;

-- ПЕРВАЯ ездка — минимальный `num`, без фильтра по `deleted_at`. Мягкое удаление ездки заводит тот
-- же релиз, что и откатывается: в окне применения teardown удалённых ездок не существует, а
-- фильтр по ним означал бы, что «первая ездка» у заявки меняется в зависимости от того, что с ней
-- делали, — и колонка после отката содержала бы не то, что содержала до миграции.
UPDATE freight_transport_request_details d
SET volume_m3 = t.volume_m3,
    weight_tons = t.weight_tons,
    loading_location = t.from_location,
    unloading_location = t.to_location,
    loading_address = t.from_address,
    unloading_address = t.to_address,
    loading_responsible_name = t.from_responsible_name,
    loading_responsible_phone = t.from_responsible_phone,
    unloading_responsible_name = t.to_responsible_name,
    unloading_responsible_phone = t.to_responsible_phone
FROM (
  SELECT DISTINCT ON (request_id)
    request_id, num, from_location, to_location, from_address, to_address,
    volume_m3, weight_tons,
    from_responsible_name, from_responsible_phone, to_responsible_name, to_responsible_phone
  FROM vehicle_request_trips
  ORDER BY request_id, num
) t
WHERE t.request_id = d.request_id;

ALTER TABLE freight_transport_request_details
  ALTER COLUMN loading_location SET NOT NULL,
  ALTER COLUMN unloading_location SET NOT NULL;

-- Семь ограничений — ровно те, что сняла миграция, и в тех же формулировках (0013, 0020, 0021).
ALTER TABLE freight_transport_request_details
  ADD CONSTRAINT freight_volume_positive_check
    CHECK (volume_m3 IS NULL OR volume_m3 > 0),
  ADD CONSTRAINT freight_weight_positive_check
    CHECK (weight_tons IS NULL OR weight_tons > 0),
  ADD CONSTRAINT freight_volume_or_weight_check
    CHECK (volume_m3 IS NOT NULL OR weight_tons IS NOT NULL),
  ADD CONSTRAINT freight_loading_not_blank_check
    CHECK (btrim(loading_location) <> ''),
  ADD CONSTRAINT freight_unloading_not_blank_check
    CHECK (btrim(unloading_location) <> ''),
  ADD CONSTRAINT freight_loading_address_shape_check
    CHECK (loading_address IS NULL OR (jsonb_typeof(loading_address) = 'object' AND loading_address ? 'source')),
  ADD CONSTRAINT freight_unloading_address_shape_check
    CHECK (unloading_address IS NULL OR (jsonb_typeof(unloading_address) = 'object' AND unloading_address ? 'source'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Снятие заведённого.
--
-- Порядок — от ссылающихся к тем, на кого ссылаются, и БЕЗ `CASCADE`: зависимость, о которой этот
-- файл не знает, обязана уронить откат, а не быть снесённой молча вместе с чужой таблицей.
-- Комментарии, индексы и ограничения уходят вместе со своими объектами.
DROP TABLE waybill_trips;
DROP TABLE vehicle_route_point_trips;
DROP TABLE vehicle_route_points;
DROP TABLE vehicle_request_trips;

ALTER TABLE waybills DROP COLUMN issue_warnings;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Журнал выпусков.
--
-- Строка выпуска — такие же данные миграции, как справочник или бэкфил: оставь её, и повторный
-- накат упадёт на `app_releases_pkey`, то есть откат сделает релиз невыкатываемым. Удаляется по
-- `seq` с проверкой числа строк — молчаливое «удалено ноль» означало бы, что снимают не тот
-- выпуск.
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM app_releases WHERE seq = 19 AND version = '0.1.18.0108';
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION
      'Из журнала выпусков удалено строк: %, ожидалась ровно одна (seq 19, версия 0.1.18.0108).',
      removed;
  END IF;
END $$;
