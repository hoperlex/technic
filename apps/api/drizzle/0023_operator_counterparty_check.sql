-- Инвариант роли «Оператор» (ADR 0010): оператор всегда работает от имени контрагента — без него
-- у учётки нет области видимости (аналог объекта у «Штаба»).
--
-- Отдельный файл, а не хвост 0022: значение 'operator' добавлено в enum `role` там же, а новое
-- значение enum нельзя использовать в транзакции, которая его добавила (раннер выполняет файл
-- целиком в одной транзакции).
ALTER TABLE users
  ADD CONSTRAINT users_operator_counterparty_check
  CHECK (role IS DISTINCT FROM 'operator' OR counterparty_id IS NOT NULL);
