-- Необязательное время в заявках: «на такую-то дату, время не важно».
--
-- Дата и время остаются ОДНИМ timestamptz (delivery_at / scheduled_at): его используют индексы,
-- сортировка списков и диапазонные фильтры, а расщепление на date + time NULL переписало бы все
-- эти запросы ради поля, которое читается только на отображение. Вместо этого «время не задано»
-- выражается отдельным признаком, а сам timestamp в этом случае несёт полночь по МСК.
--
-- Инвариант «признак ⇒ 00:00 МСК» держит приложение, а не CHECK: приведение timestamptz к времени
-- суток зависит от параметра TimeZone сессии и потому не IMMUTABLE — PostgreSQL такое ограничение
-- в CHECK не принимает.
--
-- Существующие заявки не мигрируют: у всех время задано осознанно (поле было обязательным),
-- поэтому DEFAULT false — корректное значение для всей истории.

ALTER TABLE waste_requests
  ADD COLUMN delivery_time_unspecified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN waste_requests.delivery_time_unspecified IS
  'Время доставки не задано: в delivery_at значима только дата (00:00 МСК)';

ALTER TABLE freight_transport_request_details
  ADD COLUMN scheduled_time_unspecified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN freight_transport_request_details.scheduled_time_unspecified IS
  'Время подачи не задано: в scheduled_at значима только дата (00:00 МСК)';
