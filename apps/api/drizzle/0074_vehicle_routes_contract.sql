-- Маршруты, вторая половина (план docs/vehicle-routes-plan.md, релиз 2 — contract).
--
-- Миграция 0072 добавила рейсы, ничего не убирая: деплой накатывает миграции ДО перезапуска API,
-- и работающий в тот момент старый код обязан был остаться рабочим. Здесь убирается то, чем код
-- уже не пользуется — но только после того, как история перенесена скриптом backfill:routes.
--
-- Порядок обязателен: 0074 применяется на базе, где у каждого листа есть рейс. Если перенос не
-- прогнан, миграция падает предохранителем ниже и не портит данные — деплой прерывается на
-- понятной ошибке, а не на середине изменения схемы.
--
-- Что меняется:
--   · waybills.route_id → NOT NULL: листа без рейса больше не существует;
--   · «один действующий лист на рейс» вместо «одного листа на машину и дату» — это и включает
--     вторую смену: день и ночь на одной машине становятся двумя рейсами с двумя бланками;
--   · vehicle_request_assignments.driver_person_id удаляется: за рулём человек сидит в рейсе, и
--     двух источников истины о водителе быть не должно.

-- 1. Предохранитель. Первое условие — перенос истории, второе — водители в назначениях, где рейса
--    не бывает (аренда, спецтехника, тип без бланка): их обнуляет тот же скрипт ключом
--    --clear-orphan-drivers. Без обеих проверок миграция молча потеряла бы данные.
DO $$
DECLARE
  orphan_waybills bigint;
  orphan_drivers bigint;
BEGIN
  SELECT count(*) INTO orphan_waybills FROM waybills WHERE route_id IS NULL;
  IF orphan_waybills > 0 THEN
    RAISE EXCEPTION 'Путевых листов без рейса: %. Прогоните backfill:routes перед этой миграцией',
      orphan_waybills;
  END IF;

  SELECT count(*) INTO orphan_drivers
  FROM vehicle_request_assignments a
  WHERE a.driver_person_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM vehicle_route_requests rr WHERE rr.request_id = a.request_id);
  IF orphan_drivers > 0 THEN
    RAISE EXCEPTION 'Назначений с водителем вне рейсов: %. Прогоните backfill:routes --clear-orphan-drivers',
      orphan_drivers;
  END IF;
END $$;

-- 2. Лист живёт только при рейсе.
ALTER TABLE waybills ALTER COLUMN route_id SET NOT NULL;

-- 3. Один действующий лист на рейс. Аннулированные не в счёт: испорченный бланк списывают и
--    выписывают новый по тому же рейсу — на этом и держится пересборка состава.
CREATE UNIQUE INDEX waybills_route_unique ON waybills (route_id) WHERE status <> 'cancelled';

-- 4. Прежнее ограничение снимается — вторая смена перестаёт быть невозможной (бэклог ADR 0037).
--    Сервер до этого момента проверял его сам и отвечал словами; эта проверка уходит вместе с ним.
DROP INDEX waybills_vehicle_date_unique;

-- 5. Водитель — свойство рейса. Значения колонки уже перенесены в vehicle_routes.driver_person_id
--    (у рейсов, восстановленных из листов) либо обнулены как попавшие туда по ошибке.
DROP INDEX IF EXISTS vehicle_request_assignments_driver_idx;
ALTER TABLE vehicle_request_assignments DROP COLUMN driver_person_id;
