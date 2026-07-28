-- Типы мусора заводятся из прайса: отдельного справочника больше нет, тип появляется вместе
-- с первой ценой. См. docs/adr/0017-waste-types-from-price.md.
--
-- Вариации написания одного типа («Бетонный бой», «бетонный  бой», «Бетонный-бой») — это дубли,
-- а не разные типы: пара «тип × техника» развалилась бы на две цены, и подбор тарифа в заявке
-- стал бы делом того, какое написание выбрал диспетчер. Ключ нормализованного названия
-- материализуется колонкой под UNIQUE; приложение нормализацию не дублирует, а зовёт ту же
-- функцию (приём ADR 0007 §2 и ADR 0016 §1) — иначе смысл индекса разошёлся бы с кодом.

-- 1. Нормализация названия: регистр, «ё» и любые разделители значения не имеют.
CREATE FUNCTION waste_type_name_key(name text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT regexp_replace(translate(lower(name), 'ё', 'е'), '[^0-9a-zа-я]+', '', 'g')
$$;

-- 2. Уже заведённые типы обязаны различаться этим ключом: иначе UNIQUE ниже упал бы кодом 23505,
--    не назвав конфликтующие строки, и миграцию пришлось бы разбирать по журналу.
DO $$
DECLARE dups text;
BEGIN
  SELECT string_agg(names, '; ') INTO dups
  FROM (
    SELECT string_agg(name, ' / ' ORDER BY name) AS names
    FROM waste_types
    GROUP BY waste_type_name_key(name)
    HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION
      'Типы мусора с совпадающим нормализованным названием: %. Оставьте по одному (тарифы и заявки переведите на него) и повторите миграцию.',
      dups;
  END IF;
END $$;

ALTER TABLE waste_types
  ADD COLUMN name_key text GENERATED ALWAYS AS (waste_type_name_key(name)) STORED;

-- Название без единой буквы и цифры («---») даёт пустой ключ и перестало бы ловиться как дубль.
ALTER TABLE waste_types
  ADD CONSTRAINT waste_types_name_key_not_blank_check CHECK (name_key <> '');

CREATE UNIQUE INDEX waste_types_name_key_unique ON waste_types (name_key);
