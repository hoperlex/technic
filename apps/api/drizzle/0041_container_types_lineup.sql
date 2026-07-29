-- Состав справочника контейнеров: 8, 20, 27 и 38 м³.
--
-- «Контейнер 25 м³ для тяжёлых грузов» из обихода вышел, вместо него в работе контейнер 38 м³.
-- Строка 25 м³ не удаляется, а гасится: на неё ссылаются заведённые заявки (FK restrict), и
-- удаление либо не прошло бы вовсе, либо стёрло бы предмет старой заявки. Неактивная запись
-- пропадает из выбора в формах, но в истории остаётся собой.
--
-- Идемпотентно: вставка по code с ON CONFLICT, гашение — по факту.

INSERT INTO container_types (code, name, sort_order, type, volume_m3) VALUES
  ('container_38', 'Контейнер 38 м³', 40, 'cont', 38)
ON CONFLICT (code) DO NOTHING;

UPDATE container_types
SET is_active = false, updated_at = now()
WHERE code = 'container_25_heavy' AND is_active;
