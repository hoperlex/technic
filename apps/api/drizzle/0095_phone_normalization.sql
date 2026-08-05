-- Единый вид телефона (ADR 0066).
--
-- Номера копились свободным текстом: телефон учётки и контакт по заявке заводились с явным
-- решением «формат не навязываем» (ADR 0043, миграция 0062), телефон водителя — просто строкой.
-- В итоге один и тот же номер лежит в базе четырьмя написаниями («+7 (926) 123-45-67»,
-- «8 926 123 45 67», «89261234567», «926 1234567»), и ни список, ни путевой лист не могут
-- показать его одинаково: сравнивать и печатать нечего — форматов столько, сколько людей вводило.
--
-- Хранимый вид — десять цифр без кода страны: регион в портале всегда +7, и держать его в каждой
-- строке значит хранить одно и то же в миллионе копий. Вид «+7 (900) 000 00 00» даёт `formatPhone`
-- на выводе, ввод приводит к цифрам `normalizePhone` — обе в контрактах, и обе одни на портал.
--
-- Что нормализуется: десять цифр (как есть) и одиннадцать с ведущей 7 или 8 — этим два
-- российских написания и различаются, а оставшиеся десять цифр у них общие.
--
-- Что НЕ трогается: всё остальное — городской с добавочным («8(495)123-45-67 доб. 12»), два
-- номера в одном поле (у основной организации в шапке бланка так и заведено), короткий
-- внутренний, иностранный, «уточню». Такие записи остаются как есть, потому что цена ошибки
-- здесь — потерянный контакт: по номеру, который не сводится к десяти цифрам, всё равно звонят,
-- и стереть его хуже, чем оставить в старом виде. Портал их показывает как записаны
-- (`formatPhone` возвращает несводимое без изменений) и правит при следующем открытии карточки:
-- форма старый вид уже не примет.
--
-- CHECK на формат поэтому и не ставится: он сделал бы эти строки неправимыми — любая правка
-- соседнего поля падала бы на телефоне, которого человек не трогал. Формат держат контракты, а
-- этой миграции достаточно привести к нему то, что приводится.
--
-- Индексы и поиск не затронуты: `persons_phone_idx` строится по колонке, а поиск сравнивает
-- цифры с цифрами (`phoneSearchCondition`) — он находил записи в любом написании и до, и после.

-- Правило нормализации — временной функцией: точка правды по формату одна и она в контрактах,
-- а в базе после миграции остаётся ровно то, ради чего она написана, — сами номера.
CREATE FUNCTION phone_local_tmp(v text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(digits) = 10 THEN digits
    WHEN length(digits) = 11 AND left(digits, 1) IN ('7', '8') THEN right(digits, 10)
    ELSE v
  END
  FROM (SELECT regexp_replace(v, '[^0-9]', '', 'g') AS digits) d;
$$;

-- Условие `phone <> phone_local_tmp(phone)` оставляет нетронутыми строки, которые уже в нужном
-- виде: без него UPDATE переписал бы каждую запись портала ради нуля изменений.
UPDATE users
   SET phone = phone_local_tmp(phone)
 WHERE phone <> '' AND phone <> phone_local_tmp(phone);

UPDATE persons
   SET phone = phone_local_tmp(phone)
 WHERE phone <> '' AND phone <> phone_local_tmp(phone);

UPDATE organizations
   SET phone = phone_local_tmp(phone)
 WHERE phone <> '' AND phone <> phone_local_tmp(phone);

UPDATE warehouses
   SET contact_phone = phone_local_tmp(contact_phone)
 WHERE contact_phone <> '' AND contact_phone <> phone_local_tmp(contact_phone);

UPDATE waste_requests
   SET responsible_phone = phone_local_tmp(responsible_phone)
 WHERE responsible_phone <> '' AND responsible_phone <> phone_local_tmp(responsible_phone);

UPDATE special_equipment_request_details
   SET responsible_phone = phone_local_tmp(responsible_phone)
 WHERE responsible_phone <> '' AND responsible_phone <> phone_local_tmp(responsible_phone);

UPDATE freight_transport_request_details
   SET loading_responsible_phone = phone_local_tmp(loading_responsible_phone)
 WHERE loading_responsible_phone <> ''
   AND loading_responsible_phone <> phone_local_tmp(loading_responsible_phone);

UPDATE freight_transport_request_details
   SET unloading_responsible_phone = phone_local_tmp(unloading_responsible_phone)
 WHERE unloading_responsible_phone <> ''
   AND unloading_responsible_phone <> phone_local_tmp(unloading_responsible_phone);

DROP FUNCTION phone_local_tmp(text);
