-- «Заказ ТС» / DaData (ADR 0005): метаданные верификации адресов погрузки/разгрузки.
-- Аддитивно и обратимо: канонические строки (loading_location/unloading_location) не трогаем,
-- рядом храним jsonb с происхождением и ФИАС/гео. NULL = адрес введён вручную (не верифицирован).
-- Мягкая модель: сервер доверяет данным подсказки, внешних вызовов в write-path нет.

ALTER TABLE freight_transport_request_details
  ADD COLUMN loading_address jsonb,
  ADD COLUMN unloading_address jsonb;

-- Если метаданные заданы — это объект с обязательным ключом source (структуру валидирует Zod).
ALTER TABLE freight_transport_request_details
  ADD CONSTRAINT freight_loading_address_shape_check
    CHECK (loading_address IS NULL OR (jsonb_typeof(loading_address) = 'object' AND loading_address ? 'source')),
  ADD CONSTRAINT freight_unloading_address_shape_check
    CHECK (unloading_address IS NULL OR (jsonb_typeof(unloading_address) = 'object' AND unloading_address ? 'source'));
