-- Аннулирование применённой недельной заявки (ADR 0218): кто развернул, когда и почему, плюс
-- правка трёх инвариантов шапки под новое состояние.
--
-- Использует значение `annulled`, добавленное 0354 отдельным файлом (PostgreSQL не даёт
-- использовать значение enum'а в транзакции, где оно создано).
--
-- ОКНО ВЫКАТА. Миграция идёт при работающем старом коде и до перезапуска: старый код `annulled` не
-- пишет вовсе, новые колонки приезжают с умолчаниями, а пересозданный частичный индекс для старого
-- кода равносилен прежнему — заявок в новом статусе ещё нет. Обратного хода в teardown нет
-- намеренно: миграция аддитивна.

-- Кто аннулировал, когда и почему. `RESTRICT` на автора — той же причиной, что у `created_by`:
-- увольнение диспетчера обычное дело, а «кто развернул неделю» обязано пережить его уход.
--
-- Причина — `NOT NULL DEFAULT ''`, как `cancel_reason`, а не nullable: CHECK с `btrim` на
-- nullable-колонке не держит ничего — при NULL правая часть равенства тоже NULL, и проверка
-- проходит молча. Строкам, заведённым до этой миграции, умолчание даёт пустоту, и CHECK ниже
-- требует непустоту ровно у аннулированных.
ALTER TABLE weekly_vehicle_requests
  ADD COLUMN annulled_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN annulled_at timestamptz,
  ADD COLUMN annul_reason text NOT NULL DEFAULT '';

-- Полная развилка, а не три «или»: у аннулированной заполнены все три поля и причина непуста, у
-- любой другой — все три пусты. Полуснимок («аннулирована, автора нет») — мусор, который однажды
-- прочитают как факт.
ALTER TABLE weekly_vehicle_requests
  ADD CONSTRAINT weekly_requests_annul_check CHECK (
    (status = 'annulled') = (
      annulled_by IS NOT NULL AND annulled_at IS NOT NULL AND btrim(annul_reason) <> ''
    )
  );

-- Виза и момент применения у аннулированной СОХРАНЯЮТСЯ: она была применена, и именно это
-- объясняет, откуда у заказов взялись продления, которые потом развернули. Прежние два равенства
-- говорили «только applied», и аннулированная упёрлась бы в них на самом переходе.
ALTER TABLE weekly_vehicle_requests
  DROP CONSTRAINT weekly_requests_applied_check,
  ADD CONSTRAINT weekly_requests_applied_check CHECK (
    (status IN ('applied', 'annulled')) = (applied_at IS NOT NULL)
  );

ALTER TABLE weekly_vehicle_requests
  DROP CONSTRAINT weekly_requests_approved_status_check,
  ADD CONSTRAINT weekly_requests_approved_status_check CHECK (
    (status IN ('applied', 'annulled')) = (approved_by IS NOT NULL)
  );

-- Пара «объект + неделя» освобождается у обоих терминальных состояний: после аннулирования
-- площадка собирает ту же неделю заново, и занятый индекс не дал бы ей этого никаким способом,
-- кроме удаления документа насовсем — то есть вместе с объяснением.
--
-- Сам индекс при этом не единственный держатель правила: «живость» недели спрашивают ещё три
-- чтения в маршрутах (создание, предложение состава, предупреждение о другой активной неделе), и
-- без их правки освобождённый индекс ничего бы не изменил. Правило сведено в предикат контрактов
-- `isWeeklyRequestLive`.
DROP INDEX weekly_requests_object_week_uniq;
CREATE UNIQUE INDEX weekly_requests_object_week_uniq
  ON weekly_vehicle_requests (object_id, week_start)
  WHERE status NOT IN ('cancelled', 'annulled');
