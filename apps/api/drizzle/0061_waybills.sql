-- Путевой лист: сам документ, его серии и талоны заказчиков (ADR 0037).
--
-- Лист — документ, а не выгрузка: у него серия и номер, он подлежит журналу учёта и хранению,
-- и на него ложится будущая подпись. Поэтому таблица, а не «кнопка, собирающая файл».
--
-- Черновика в жизненном цикле нет. Лист рождается переводом заявки в работу, в той же
-- транзакции, сразу выданным: состояние «в работе, а листа нет» не существует по той же причине,
-- по которой ADR 0029 отказался от «выполнена, но чем и почём — узнаем потом». Номер поэтому
-- присваивается сразу и дыр от брошенных черновиков в журнале не бывает.

CREATE TYPE waybill_status AS ENUM ('issued', 'cancelled');

-- 1. Серии бланков. Номер сквозной внутри серии; ширина — сколько знаков печатать с ведущими
--    нулями («00000004897» в образцах). Счётчик в строке, а не sequence: sequence не
--    откатывается вместе с транзакцией и выдаёт дыры, а журнал учёта строгой отчётности читают
--    как непрерывный.
CREATE TABLE waybill_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  -- Печатается в графе «серия»: в образцах это «260604-646-».
  prefix text NOT NULL DEFAULT '',
  next_number bigint NOT NULL DEFAULT 1,
  number_width smallint NOT NULL DEFAULT 8,
  -- Чья это серия: у каждого юрлица своя нумерация бланков. NULL — серия основной организации.
  organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waybill_series_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT waybill_series_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT waybill_series_next_number_check CHECK (next_number >= 1),
  CONSTRAINT waybill_series_number_width_check CHECK (number_width BETWEEN 1 AND 12)
);
CREATE UNIQUE INDEX waybill_series_code_unique ON waybill_series (code);

-- 2. Сам лист.
CREATE TABLE waybills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id uuid NOT NULL REFERENCES waybill_series (id) ON DELETE RESTRICT,
  number bigint NOT NULL,
  -- Бланк, по которому лист выписан (vehicle_types.waybill_form_code). Снимком, а не join'ом:
  -- тип машины могут переклассифицировать, а выданный лист остаётся на своём бланке.
  form_code text NOT NULL,
  status waybill_status NOT NULL DEFAULT 'issued',
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  driver_person_id uuid NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  -- День, на который выписан лист. Он же граница правки: до этой даты лист аннулируют и
  -- выписывают заново, начиная с неё — нет (ADR 0037 п. 9). Проверку держит сервис: CURRENT_DATE
  -- не IMMUTABLE и в CHECK запрещён.
  issued_for_date date NOT NULL,
  -- Прицеп — признак рейса, а не свойство машины: прицепа в реестре техники нет, а требование к
  -- категории водителя он поднимает (ADR 0037 п. 8).
  with_trailer boolean NOT NULL DEFAULT false,
  trailer1_model text NOT NULL DEFAULT '',
  trailer1_reg_number text NOT NULL DEFAULT '',
  trailer2_model text NOT NULL DEFAULT '',
  trailer2_reg_number text NOT NULL DEFAULT '',
  -- Графы шапки, которых нет ни в заявке, ни в справочниках: их наследуют от прошлого листа
  -- этой машины и правят раз в сезон.
  garage_number text NOT NULL DEFAULT '',
  communication_kind text NOT NULL DEFAULT '',
  transportation_kind text NOT NULL DEFAULT '',
  -- Снимок значений бланка: лист печатается из него, а не из справочников. Переименование
  -- объекта или уточнение госномера задним числом не меняет уже выданный документ — и оно же
  -- будет тем, что подписывают, когда дойдёт до электронной подписи.
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waybills_form_code_check CHECK (form_code IN ('4p', 'leg3', 'esm2')),
  -- Аннулирование — учётное действие: у аннулированного известно, когда и почему. Испорченный
  -- бланк списывают с причиной, а не стирают.
  CONSTRAINT waybills_cancelled_check CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT waybills_cancel_reason_check CHECK (
    status <> 'cancelled' OR btrim(cancel_reason) <> ''
  ),
  -- Реквизиты прицепа без прицепа — данные, которых не было в рейсе.
  CONSTRAINT waybills_trailer_fields_check CHECK (
    with_trailer OR (
      trailer1_model = '' AND trailer1_reg_number = ''
      AND trailer2_model = '' AND trailer2_reg_number = ''
    )
  )
);

-- Номер уникален внутри серии — это и есть номер бланка.
CREATE UNIQUE INDEX waybills_series_number_unique ON waybills (series_id, number);
-- Один лист на машину и дату: лист выписывается на день или смену, а разные заказчики
-- вписываются в талоны 1–4 того же бланка (ADR 0037 п. 3). Аннулированные не мешают —
-- испорченный бланк заменяют новым на ту же дату.
CREATE UNIQUE INDEX waybills_vehicle_date_unique ON waybills (vehicle_id, issued_for_date)
  WHERE status <> 'cancelled';
-- Журнал учёта: «какие листы выписаны за период» — главный вопрос к таблице.
CREATE INDEX waybills_issued_for_date_idx ON waybills (issued_for_date DESC);
CREATE INDEX waybills_driver_idx ON waybills (driver_person_id);
-- «На чём человек ездил в прошлый раз» — этим сортируется список водителей при следующей
-- выписке, и им же наследуются графы шапки.
CREATE INDEX waybills_vehicle_issued_idx ON waybills (vehicle_id, issued_for_date DESC);

-- 3. Талоны заказчиков: заявки, которые машина выполняет по этому листу.
--    Форма 4-П держит до четырёх заказчиков, и вторая заявка на ту же машину в тот же день
--    дописывается талоном, а не поднимает второй лист.
CREATE TABLE waybill_requests (
  waybill_id uuid NOT NULL REFERENCES waybills (id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES vehicle_requests (id) ON DELETE RESTRICT,
  slot smallint NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (waybill_id, request_id),
  CONSTRAINT waybill_requests_slot_check CHECK (slot BETWEEN 1 AND 4)
);
CREATE UNIQUE INDEX waybill_requests_slot_unique ON waybill_requests (waybill_id, slot);
-- Заявка в одном листе, но UNIQUE тут нельзя: аннулированный лист сохраняет свою строку, а
-- заявку после него выписывают заново. Условие «лист не аннулирован» живёт в соседней таблице,
-- и держит его сервис.
CREATE INDEX waybill_requests_request_idx ON waybill_requests (request_id);

-- 4. Водитель на назначении (ADR 0027 + ADR 0037): «чем взяли в работу» дополняется тем, «кто
--    за рулём». Колонкой, а не таблицей vehicle_request_operators из бэклога ADR 0008: ADR 0027
--    уже выбрал форму «одна заявка — одно назначение», и второго водителя в ней не бывает.
--    NULL — назначения, сделанные до появления путевых листов, и аренда, где водитель чужой.
ALTER TABLE vehicle_request_assignments
  ADD COLUMN driver_person_id uuid REFERENCES persons (id) ON DELETE RESTRICT;

CREATE INDEX vehicle_request_assignments_driver_idx
  ON vehicle_request_assignments (driver_person_id)
  WHERE driver_person_id IS NOT NULL;

-- 5. Основная серия. В отличие от организации, её можно завести осмысленно: нумерация начинается
--    с единицы, а префикс и ширину правят под бланки типографии.
INSERT INTO waybill_series (code, name, number_width, comment) VALUES
  ('main', 'Основная серия', 8, 'Заведена миграцией 0061; префикс и ширину правит администратор')
ON CONFLICT (code) DO NOTHING;
