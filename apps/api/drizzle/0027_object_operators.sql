-- Кто вывозит мусор с объекта (ADR 0010): связь «объект ↔ контрагент-оператор», многие-ко-многим.
--
-- На объекте одновременно работает несколько операторов (разные типы отходов, подстраховка на
-- пиковых объёмах), и один оператор обслуживает несколько объектов — поэтому связь отдельной
-- таблицей, а не колонкой в любой из сторон.
--
-- Смысл связи — сузить выбор исполнителя заявки вывоза: назначать оператора, который на объекте
-- не работает, диспетчер не должен. Проверку держит сервис (waste-requests): объект, у которого
-- операторы ещё не заведены, назначению не мешает — иначе первая же заявка на новом объекте
-- встала бы до заполнения справочника.
CREATE TABLE construction_object_operators (
  construction_object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES counterparties (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Пара и есть запись: повторная привязка того же оператора к тому же объекту невозможна.
  PRIMARY KEY (construction_object_id, counterparty_id)
);
-- Обратная сторона связи («объекты этого оператора») — отдельным индексом: PK покрывает только
-- проход от объекта.
CREATE INDEX construction_object_operators_counterparty_idx
  ON construction_object_operators (counterparty_id);

-- Требование «тип контрагента = operator» держит сервис — тем же решением, что и
-- waste_requests.operator_counterparty_id в 0022: составной FK потребовал бы хранить тип
-- контрагента в самой таблице связи и синхронизировать его при смене типа.
--
-- Каскад по контрагенту, а не RESTRICT: физически контрагентов не удаляют (soft-delete), но
-- привязка — производная запись, и переживать удаление владельца ей незачем. Soft-delete
-- контрагента привязки не трогает: восстановление вернёт запись с прежними объектами.
