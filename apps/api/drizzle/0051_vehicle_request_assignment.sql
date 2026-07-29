-- Техника и ставки при переводе заявки ТС в работу (ADR 0027).
--
-- Заявка заказывает тип ТС, а в работу её берут конкретной машиной: с этого момента известно,
-- кто выходит и по какой цене. Раньше «В работе» означало только смену статуса — машину и ставку
-- держали в переписке, и по заявке нельзя было ответить ни «чем везём», ни «во сколько обойдётся».
--
-- Одна заявка — одна машина, поэтому request_id и есть первичный ключ: заявка заказывает один тип
-- на один срок, и второй машине в ней взяться неоткуда. Ставки — снимок договорённости по этой
-- заявке: подставляются из предложения аренды (vehicles.price_per_hour / price_per_shift), но
-- правятся свободно, и последующая правка прайса их не переписывает.

-- 1. Цели составных FK. Уникальность по (id, <тип>) избыточна сама по себе — id уже первичный
--    ключ, — но без неё на пару колонок не сослаться, а именно ссылкой инвариант «назначенная
--    машина того же типа, что заказан заявкой» становится физическим. Тот же приём уже держит
--    «модель того же типа, что машина» (vehicles_model_type_fk).
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_id_type_unique UNIQUE (id, vehicle_type_id);

ALTER TABLE vehicle_requests
  ADD CONSTRAINT vehicle_requests_id_type_unique UNIQUE (id, vehicle_type_id);

-- 2. Назначение.
CREATE TABLE vehicle_request_assignments (
  request_id uuid PRIMARY KEY,
  vehicle_id uuid NOT NULL,
  -- Копия типа ТС заявки; содержательного смысла не несёт, существует ради обоих FK ниже.
  vehicle_type_id uuid NOT NULL,
  price_per_hour numeric(12, 2),
  price_per_shift numeric(12, 2),
  shift_hours smallint,
  assigned_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Заявка: каскад — назначение живёт ровно столько же, сколько она сама. ON UPDATE намеренно
  -- не задан: сменить тип ТС у заявки, на которой уже стоит машина, нельзя — БД такую правку
  -- отклонит, а сервер отвечает на неё 422 с объяснением, что сначала нужно снять технику.
  CONSTRAINT vehicle_request_assignments_request_type_fk
    FOREIGN KEY (request_id, vehicle_type_id)
    REFERENCES vehicle_requests (id, vehicle_type_id) ON DELETE CASCADE,
  -- Машина: restrict — назначенную технику из справочника не удаляют, на неё ссылается работа.
  CONSTRAINT vehicle_request_assignments_vehicle_type_fk
    FOREIGN KEY (vehicle_id, vehicle_type_id)
    REFERENCES vehicles (id, vehicle_type_id) ON DELETE RESTRICT,

  -- Ставок может не быть вовсе (своя машина), но ноль и минус ставкой не бывают. «Хотя бы одна
  -- цена у аренды» — правило сервера: принадлежность лежит в другой таблице, и CHECK её не видит.
  CONSTRAINT vehicle_request_assignments_prices_positive_check CHECK (
    (price_per_hour IS NULL OR price_per_hour > 0)
    AND (price_per_shift IS NULL OR price_per_shift > 0)
  ),
  CONSTRAINT vehicle_request_assignments_shift_hours_range_check CHECK (
    shift_hours IS NULL OR shift_hours BETWEEN 1 AND 24
  )
);

-- «Где сейчас эта машина» — вопрос к таблице со стороны справочника техники.
CREATE INDEX vehicle_request_assignments_vehicle_idx
  ON vehicle_request_assignments (vehicle_id);
