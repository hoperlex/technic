-- Скан, по которому разбирают качество распознавания талона, живёт дольше самого талона.
-- Миграция 0210 закрепила эту политику ссылкой
-- `waste_ticket_field_events.file_id -> files ON DELETE SET NULL`, но не добавила журнал в
-- `file_is_linked(uuid)`. Из-за этого уборка сирот и явное удаление считали такой скан свободным,
-- а откат заявки дополнительно ставил его на удаление сразу после снятия `request_files`.
--
-- Журнал — не спутник файловой связи вроде `waste_ticket_files`: спутник уходит каскадом вместе с
-- `request_files`, а событие аудита намеренно переживает и талон, и заявку. Поэтому это отдельная
-- ветка реестра связей. При полном удалении заявки маршрут сначала явно снимает `file_id` у её
-- событий; лишь после этого общий файловый сервис снова вправе удалить освободившийся объект.
--
-- Индекс частичный: у старых и намеренно полностью удалённых заявок `file_id` пуст, и в проверке
-- связи эти строки никогда не участвуют. Без индекса каждый кандидат фоновой уборки сканировал бы
-- весь журнал качества.

CREATE INDEX waste_ticket_field_events_file_idx
  ON waste_ticket_field_events (file_id)
  WHERE file_id IS NOT NULL;

-- `CREATE OR REPLACE` повторяет полный актуальный перечень из миграции 0147. Тело SQL-функции
-- заменяется целиком: пропущенная прежняя ветка молча сняла бы защиту с другого вида документа.
CREATE OR REPLACE FUNCTION file_is_linked(p_file_id uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT
    -- Вложения и талоны заявок на вывоз мусора (ADR 0024).
    EXISTS (SELECT 1 FROM request_files WHERE file_id = p_file_id)
    -- Вложения заявок на технику.
    OR EXISTS (SELECT 1 FROM vehicle_request_files WHERE file_id = p_file_id)
    -- Сканы, подшитые к путевому листу (миграция 0087).
    OR EXISTS (SELECT 1 FROM waybill_files WHERE file_id = p_file_id)
    -- Документы заявок на обслуживание оргтехники (ADR 0084, миграция 0105).
    OR EXISTS (SELECT 1 FROM service_request_files WHERE file_id = p_file_id)
    -- Фотографии показаний техники (миграция 0132).
    OR EXISTS (SELECT 1 FROM vehicle_reading_files WHERE file_id = p_file_id)
    -- Сканы документов работника (миграция 0019).
    OR EXISTS (SELECT 1 FROM person_credential_files WHERE file_id = p_file_id)
    -- Сканы актов ТО (миграция 0147).
    OR EXISTS (SELECT 1 FROM vehicle_maintenance_files WHERE file_id = p_file_id)
    -- Исходный скан наблюдения качества распознавания (ADR 0137, миграция 0210).
    OR EXISTS (SELECT 1 FROM waste_ticket_field_events WHERE file_id = p_file_id)
$$;

COMMENT ON FUNCTION file_is_linked(uuid) IS
  'Файл привязан хоть к одной сущности портала или событию аудита распознавания. Единственный '
  'источник правды для проверки привязываемости, доступа, явного удаления и фоновой уборки. '
  'Скан наблюдения освобождается явно только при полном удалении заявки.';
