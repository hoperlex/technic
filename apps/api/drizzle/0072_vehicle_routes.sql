-- Маршруты: рейс одной машины на одну дату (план docs/vehicle-routes-plan.md, релиз 1 — expand).
--
-- До сих пор «день машины» существовал только как побочный эффект правила «один лист на машину и
-- дату» (ADR 0037 п. 3): вторая заявка дописывалась талоном в уже выданный бланк. Планировать
-- рейс было негде — единственной записью о нём был документ строгой отчётности, уже выданный, с
-- порядком заявок «в котором нажимали кнопки». Маршрут вклинивается между заявкой и листом:
-- заявку кладут в рейс переводом в работу, лист выписывают с рейса отдельным действием, когда
-- состав собран.
--
-- Миграция аддитивная и ничего не убирает. Штатный деплой накатывает миграции ДО перезапуска API
-- (runbook), а `deploy-auto --previous` откатывает код, не трогая схему, — поэтому работающий в
-- этот момент старый код обязан остаться рабочим: старый UNIQUE (vehicle_id, issued_for_date) у
-- листов и vehicle_request_assignments.driver_person_id остаются на месте, waybills.route_id
-- добавляется nullable. Убирает их вторая миграция — после переноса истории скриптом
-- backfill:routes.

-- 1. Сам рейс.
CREATE TABLE vehicle_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Человекочитаемый номер: «Р-12». По нему о рейсе говорят по телефону — как о заявке «ТС-123».
  num integer GENERATED ALWAYS AS IDENTITY,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  -- День рейса по МСК. Все заявки маршрута подаются в этот день: лист печатает задание на день,
  -- и заявка соседнего дня напечатала бы рейс, которого в этот день не было.
  route_date date NOT NULL,
  -- Кто за рулём. Пусто — водителя ещё не назначили: маршрут собирают заранее, человека ставят
  -- утром; лист без водителя не выписывается (это проверяет сервер). Один водитель на рейс:
  -- бланк 4-П держит одного, а вторая смена — это второй маршрут со своим листом.
  driver_person_id uuid REFERENCES persons (id) ON DELETE RESTRICT,
  -- Реквизиты рейса. Прицеп — признак выезда, а не свойство машины (ADR 0037 п. 8); гаражный
  -- номер, вид сообщения и вид перевозки — графы шапки бланка, которых нет ни в заявке, ни в
  -- справочниках. Раньше они лежали в назначении заявки, хотя описывают выезд.
  with_trailer boolean NOT NULL DEFAULT false,
  trailer1_model text NOT NULL DEFAULT '',
  trailer1_reg_number text NOT NULL DEFAULT '',
  trailer2_model text NOT NULL DEFAULT '',
  trailer2_reg_number text NOT NULL DEFAULT '',
  garage_number text NOT NULL DEFAULT '',
  communication_kind text NOT NULL DEFAULT '',
  transportation_kind text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Оптимистическая блокировка, как у заявки: состав рейса и выписку листа правят одновременно
  -- несколько диспетчеров, и «кто последний, тот и прав» здесь означало бы лист не на тот состав.
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Тот же CHECK, что у листа: реквизиты прицепа без прицепа в рейсе не печатаются.
  CONSTRAINT vehicle_routes_trailer_fields_check CHECK (
    with_trailer OR (
      trailer1_model = '' AND trailer1_reg_number = ''
      AND trailer2_model = '' AND trailer2_reg_number = ''
    )
  )
);

CREATE UNIQUE INDEX vehicle_routes_num_unique ON vehicle_routes (num);
-- «Что у этой машины на этот день» — главный вопрос к таблице: им форма перевода в работу
-- предлагает существующий рейс, а не заводит второй. UNIQUE здесь нет намеренно: день и ночь на
-- одной машине — это два маршрута с двумя водителями и двумя листами.
CREATE INDEX vehicle_routes_vehicle_date_idx ON vehicle_routes (vehicle_id, route_date);
CREATE INDEX vehicle_routes_date_idx ON vehicle_routes (route_date DESC);
CREATE INDEX vehicle_routes_driver_idx ON vehicle_routes (driver_person_id)
  WHERE driver_person_id IS NOT NULL;

-- 2. Состав рейса: заявки в порядке талонов бланка.
CREATE TABLE vehicle_route_requests (
  route_id uuid NOT NULL REFERENCES vehicle_routes (id) ON DELETE CASCADE,
  -- RESTRICT: заявку, которая стоит в рейсе, из базы не удаляют — на неё ссылается работа.
  request_id uuid NOT NULL REFERENCES vehicle_requests (id) ON DELETE RESTRICT,
  -- Позиция в рейсе, она же slot талона заказчика в бланке 4-П. Больше четырёх бланк не держит,
  -- поэтому пятая заявка — это второй маршрут, а не «ещё одна строка».
  position smallint NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (route_id, request_id),
  CONSTRAINT vehicle_route_requests_position_check CHECK (position BETWEEN 1 AND 4),
  -- Заявка ровно в одном рейсе: «в работе и без маршрута» — законное состояние (её вынули или
  -- переносят), «в двух рейсах сразу» — нет.
  CONSTRAINT vehicle_route_requests_request_unique UNIQUE (request_id),
  -- Перестановка меняет позиции местами и переписывает их одним запросом; построчная проверка
  -- обычного уникального индекса упала бы на первой же строке. DEFERRABLE INITIALLY IMMEDIATE:
  -- по умолчанию проверка немедленная (как у всех), а транзакция перестановки откладывает её
  -- до COMMIT через SET CONSTRAINTS.
  CONSTRAINT vehicle_route_requests_position_unique UNIQUE (route_id, position)
    DEFERRABLE INITIALLY IMMEDIATE
);

-- «В каком рейсе эта заявка» — вопрос со стороны списка заявок: по нему рисуется колонка
-- «Маршрут» и предупреждение «Без маршрута».
CREATE INDEX vehicle_route_requests_request_idx ON vehicle_route_requests (request_id);

-- 3. Лист привязывается к рейсу.
--
-- Nullable, потому что у всех выданных до сих пор листов рейса нет: их переносит скрипт
-- backfill:routes, и только после него вторая миграция ставит NOT NULL и добавляет
-- «один действующий лист на рейс». Старый UNIQUE (vehicle_id, issued_for_date) до тех пор
-- работает и продолжает запрещать вторую смену — сервер проверяет это сам и объясняет словами.
ALTER TABLE waybills
  ADD COLUMN route_id uuid REFERENCES vehicle_routes (id) ON DELETE RESTRICT;

CREATE INDEX waybills_route_idx ON waybills (route_id) WHERE route_id IS NOT NULL;
