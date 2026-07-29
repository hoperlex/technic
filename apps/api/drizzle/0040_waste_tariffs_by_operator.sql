-- Цена вывоза мусора зависит от оператора (ADR 0026), плюс правки самого прайса.
--
-- До этого прайс был один на всех: пара «что вывозим × чем вывозим» разрешалась в единственную
-- цену. Операторов на объекте несколько, и вывоз одного и того же типа мусора они возят по
-- разным ставкам — без привязки к оператору вторая ставка не заводится вовсе, а первая
-- выдаётся за общую. Поэтому позиция прайса теперь принадлежит оператору, и ключ
-- уникальности расширяется им же.

-- 1. Переименование: «ОССиГ» → «Тринити». `code` остаётся прежним ('ossig') — он неизменяем
--    после создания (ADR 0017), и на нём висят ссылки из заявок и прайса.
--    name_key — GENERATED-колонка (0036), пересчитается сама.
UPDATE waste_types SET name = 'Тринити', updated_at = now() WHERE code = 'ossig';

DO $$
DECLARE renamed int;
BEGIN
  SELECT count(*) INTO renamed FROM waste_types WHERE code = 'ossig' AND name = 'Тринити';
  IF renamed <> 1 THEN
    RAISE EXCEPTION 'Тип мусора ossig не переименован (найдено строк: %)', renamed;
  END IF;
END $$;

-- 2. «Строительные отходы» уходят из прайса вместе со своими ценами и заявками: тип заведён
--    первым пунктом исходного прайса, но в работе не используется — вывоз оформляют
--    «строительным мусором», а заведённые на него заявки пробные. Ссылающиеся заявки удаляются
--    физически: RESTRICT на waste_type_id/waste_tariff_id иначе остановил бы миграцию, а
--    деактивация типа вместо удаления оставила бы в прайсе пункт, которого в работе нет.
--    Файлы, историю статусов и машины таких заявок забирают каскады (request_files,
--    request_status_history, waste_request_vehicles — все ON DELETE CASCADE); заявку установки
--    удаление не заденет — тарификации она не несёт вовсе (waste_requests_install_no_pricing_check),
--    поэтому и self-reference install_request_id обнулять не приходится.
DO $$
DECLARE removed int;
BEGIN
  DELETE FROM waste_requests wr
  WHERE wr.waste_type_id IN (SELECT id FROM waste_types WHERE code = 'construction_waste')
     OR wr.waste_tariff_id IN (
          SELECT tf.id
          FROM waste_tariffs tf
          JOIN waste_types wt ON wt.id = tf.waste_type_id
          WHERE wt.code = 'construction_waste'
        );
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE NOTICE 'Удалено заявок со «Строительными отходами»: %', removed;
  END IF;
END $$;

DELETE FROM waste_tariffs
WHERE waste_type_id IN (SELECT id FROM waste_types WHERE code = 'construction_waste');
DELETE FROM waste_types WHERE code = 'construction_waste';

-- 3. Позиция прайса принадлежит оператору.
--    Требование «тип контрагента = operator» держит сервис — тем же решением, что и у
--    waste_requests.operator_counterparty_id (0022) и construction_object_operators (0027):
--    составной FK потребовал бы хранить тип контрагента в самой таблице и синхронизировать его.
--    ON DELETE RESTRICT: контрагентов не удаляют физически (soft-delete), и цена без владельца
--    не должна пережить даже случайное удаление.
ALTER TABLE waste_tariffs
  ADD COLUMN operator_counterparty_id uuid REFERENCES counterparties (id) ON DELETE RESTRICT;

-- Заведённые цены достаются единственному оператору: до этой миграции прайс был общим, а
-- оператор в справочнике один (0025). Больше одного — переносить цены вслепую нельзя: какая
-- ставка чья, знает только человек.
DO $$
DECLARE
  tariffs int;
  operators int;
  only_operator uuid;
BEGIN
  SELECT count(*) INTO tariffs FROM waste_tariffs;
  IF tariffs = 0 THEN RETURN; END IF;

  SELECT count(*) INTO operators
  FROM counterparties WHERE type = 'operator' AND deleted_at IS NULL;
  IF operators <> 1 THEN
    RAISE EXCEPTION
      'Цены прайса (%) некому передать: контрагентов типа «Оператор» — % (нужен ровно один). Заведите оператора или проставьте operator_counterparty_id вручную.',
      tariffs, operators;
  END IF;

  SELECT id INTO only_operator
  FROM counterparties WHERE type = 'operator' AND deleted_at IS NULL;
  UPDATE waste_tariffs SET operator_counterparty_id = only_operator, updated_at = now();
END $$;

ALTER TABLE waste_tariffs ALTER COLUMN operator_counterparty_id SET NOT NULL;

-- Ключ уникальности расширяется оператором: спор двух цен возможен только внутри одного
-- оператора, а одна и та же пара «мусор × техника» у разных операторов — это и есть прайс.
DROP INDEX waste_tariffs_type_container_unique;
DROP INDEX waste_tariffs_type_kind_unique;
CREATE UNIQUE INDEX waste_tariffs_operator_type_container_unique
  ON waste_tariffs (operator_counterparty_id, waste_type_id, container_type_id)
  WHERE container_type_id IS NOT NULL;
CREATE UNIQUE INDEX waste_tariffs_operator_type_kind_unique
  ON waste_tariffs (operator_counterparty_id, waste_type_id, container_kind)
  WHERE container_kind IS NOT NULL;
-- Прайс одного оператора — колонка справочника и проход «все цены этого контрагента»
-- при смене его типа.
CREATE INDEX waste_tariffs_operator_idx ON waste_tariffs (operator_counterparty_id);
