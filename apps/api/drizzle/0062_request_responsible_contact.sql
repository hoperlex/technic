-- Ответственный по заявке и его телефон.
--
-- Заявка отвечала на «что и куда», но не на «к кому приехать». Диспетчер выяснял это звонком
-- автору, водитель — звонком диспетчеру, и контакт всё равно жил в комментарии, откуда его не
-- достать ни списком, ни бланком. Поэтому контакт становится реквизитом заявки.
--
-- Одна пара у объектных заявок и две у грузоперевозки — не дублирование ради симметрии: у
-- грузоперевозки два конца маршрута, грузят и принимают разные люди в разных местах, и водителю
-- нужен тот, кто откроет ворота именно здесь. Заявке на объект и на площадку хватает одного:
-- место одно.
--
-- Контакт лежит там же, где предмет заявки, — в detail-таблице своего типа: у спецтехники своя
-- пара, у грузоперевозки своя четвёрка, и общей колонки, пустующей у половины строк, не возникает.
--
-- NOT NULL DEFAULT '' без CHECK на непустоту: у заведённых заявок контакта нет, и жёсткий
-- инвариант в БД сделал бы их невалидными. Обязательность держит приложение — при заведении
-- заявки требуют оба поля, при правке не дают сохранить пустое (тем же приёмом, что и
-- `delivery_time_unspecified`, миграция 0020).

ALTER TABLE special_equipment_request_details
  ADD COLUMN responsible_name text NOT NULL DEFAULT '',
  ADD COLUMN responsible_phone text NOT NULL DEFAULT '';

ALTER TABLE freight_transport_request_details
  ADD COLUMN loading_responsible_name text NOT NULL DEFAULT '',
  ADD COLUMN loading_responsible_phone text NOT NULL DEFAULT '',
  ADD COLUMN unloading_responsible_name text NOT NULL DEFAULT '',
  ADD COLUMN unloading_responsible_phone text NOT NULL DEFAULT '';

ALTER TABLE waste_requests
  ADD COLUMN responsible_name text NOT NULL DEFAULT '',
  ADD COLUMN responsible_phone text NOT NULL DEFAULT '';
