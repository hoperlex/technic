-- Реестр прицепов и полуприцепов, привязка прицепа к тягачу и порядок граф прицепа в рейсе
-- (план `docs/vehicle-trailers-plan.md`, §4.1, §4.2, §4.7, §5; шаг 2, этап Э0).
--
-- ЗАЧЕМ. Шесть полуприцепов парка порталу негде вести вовсе: графы бланка 4-П «прицеп 1» и
-- «прицеп 2» диспетчер набивает текстом при каждом выезде, а сверять этот текст не с чем —
-- справочника прицепов нет. Отсюда и разнобой в марках, и невозможность спросить «за какой
-- машиной стоит этот полуприцеп».
--
-- ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ ПРИЦЕПНОЙ ТИП В `vehicles` (§4.1). Прицеп похож на технику: то же
-- СТС, тот же госномер, ПТС, год, массы. Соблазн завести его строкой в `vehicles` велик и дорог:
-- `vehicles` читают 74 запроса в 37 файлах — заявки, назначения, рейсы, листы, гараж, показания,
-- ТО, автозапчасти, рассылки. Прицепная строка означала бы аудит каждой из этих точек, а цена
-- промаха в любой из них — прицеп в списке заказываемой техники: его предложат назначить на
-- заявку, спросят одометр и категорию прав водителя. Такую ошибку видно не на ревью, а на рабочем
-- экране диспетчера.
--
-- Довод здесь не теоретический. На проде УЖЕ есть заведённый руками тип «полуприцеп низкорамный»,
-- и в нём лежит настоящий тягач `Е646СК799`, потерявший при переносе марку: модель принадлежит
-- типу, и составной ключ `vehicles_model_type_fk` снял её вместе со сменой типа (§2.2).
-- Классификатор техники протёк ровно потому, что прицепам не нашлось своего места. Эта таблица
-- закрывает уже открытую дверь, а не гипотетическую.
--
-- МАРКА — ТЕКСТ, А НЕ ССЫЛКА НА `vehicle_models` (§4.1). Модель в справочнике привязана к
-- `vehicle_type_id`, и ссылаться на неё значило бы вернуть прицепные типы в классификатор — то
-- самое, от чего таблица уводит. В бланке графа называется «(марка)» и печатается строкой.
--
-- СОСТОЯНИЕ — СУЩЕСТВУЮЩИЙ `vehicle_status`. Свой enum не заводится: значения те же самые
-- («в работе», «не используется», «в ремонте», «списан»), а второй тип с тем же смыслом означал бы
-- две таблицы соответствий в портале и два места, где их правят.
--
-- ЧЕГО ЗДЕСЬ НЕТ. Ни одной строки данных: шесть полуприцепов и разбор пяти заведённых руками
-- тягачей — миграция `0209`, у неё свой сверочный счётчик. И нет ссылок `trailer1_id`/`trailer2_id`
-- у рейса: лист и рейс хранят текст-снимок (§4.5), а не ссылку.
--
-- ОБРАТИМОСТЬ. Аддитивна, кроме одного `UPDATE` по `vehicle_routes` (§3 ниже) — он поднимает
-- второй прицеп в первый слот там, где первый пуст. На проде предпусковой запрос §5 плана обязан
-- вернуть по нулю обеим строкам; если у рейсов ноль не вышел, `UPDATE` их и чинит, а если строки
-- нашлись у листов — так и задумано, ограничение на листы не ставится (§3).

-- ── 1. Реестр прицепов ──
CREATE TABLE vehicle_trailers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Графа «Тип ТС» из СТС: «полуприцеп» опирается на седло тягача, «прицеп» едет на своих осях.
  -- Различие печатается и подсказывает человеку, что он цепляет; умолчание — полуприцеп, потому
  -- что весь парк сегодня из них.
  kind text NOT NULL DEFAULT 'semi_trailer',
  -- «ШМИТЦ SPR-24» — печатается в графе «(марка)» бланка целиком, как строка.
  model text NOT NULL,
  registration_number text NOT NULL,
  -- Нормализуется той же функцией, что у техники: правило написания госномера в портале должно
  -- быть одно, иначе «ВХ933277» из реестра и «вх 933277» из бланка перестанут быть одним номером.
  registration_number_normalized text
    GENERATED ALWAYS AS (vehicle_reg_normalize(registration_number)) STORED,
  vin text NOT NULL DEFAULT '',
  passport_number text NOT NULL DEFAULT '',
  manufactured_year smallint,
  color text NOT NULL DEFAULT '',
  -- Массы переносятся с того же документа, хотя сегодня ни на что не влияют: они — единственное,
  -- чем когда-нибудь можно заменить галочку прицепа проверкой («свыше 750 кг нужна E-категория»,
  -- ADR 0037 п. 8). Сама проверка в эту работу не входит.
  max_mass_kg integer,
  curb_mass_kg integer,
  -- Юрлицо, за которым числится прицеп. NULL — за основной организацией портала, как у техники.
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  status vehicle_status NOT NULL DEFAULT 'active',
  note text NOT NULL DEFAULT '',
  source_name text NOT NULL DEFAULT '',
  -- ПРИВЯЗКА ЖИВЁТ У ПРИЦЕПА, А НЕ У МАШИНЫ (§4.2). Инвариант «полуприцеп стоит за одним тягачом»
  -- получается физическим: одна строка — одно значение, и запретить второго тягача нечем, потому
  -- что записать его некуда. Обратная раскладка (`vehicles.default_trailer_id`) допускала бы один
  -- прицеп за двумя машинами и потребовала бы отдельного частичного индекса против этого.
  hitched_vehicle_id uuid REFERENCES vehicles (id) ON DELETE RESTRICT,
  -- 1|2 — слот бланка 4-П: тот же порядок, в каком графы печатаются.
  hitch_position smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  CONSTRAINT vehicle_trailers_kind_check CHECK (kind IN ('trailer', 'semi_trailer')),
  -- Марка и госномер печатаются в бланке: пустые они дали бы графу, по которой прицеп не опознать.
  CONSTRAINT vehicle_trailers_model_not_blank CHECK (btrim(model) <> ''),
  CONSTRAINT vehicle_trailers_reg_not_blank CHECK (btrim(registration_number) <> ''),
  CONSTRAINT vehicle_trailers_year_range
    CHECK (manufactured_year IS NULL OR manufactured_year BETWEEN 1900 AND 2100),
  CONSTRAINT vehicle_trailers_mass_positive
    CHECK ((max_mass_kg IS NULL OR max_mass_kg > 0) AND (curb_mass_kg IS NULL OR curb_mass_kg > 0)),
  CONSTRAINT vehicle_trailers_mass_order
    CHECK (max_mass_kg IS NULL OR curb_mass_kg IS NULL OR curb_mass_kg <= max_mass_kg),
  -- Половина привязки бессмысленна: машина без слота не скажет, какую графу заполнять, а слот без
  -- машины не скажет, чей он.
  CONSTRAINT vehicle_trailers_hitch_pair
    CHECK ((hitched_vehicle_id IS NULL) = (hitch_position IS NULL)),
  CONSTRAINT vehicle_trailers_hitch_position_check
    CHECK (hitch_position IS NULL OR hitch_position IN (1, 2)),
  -- Списанный и удалённый за машиной не стоят: снятие держит сервис (списание и мягкое удаление
  -- снимают привязку в той же транзакции, §4.2.3), а это — физический запрет, чтобы забытая
  -- привязка не пережила списание и не подставилась в рейс из архива.
  CONSTRAINT vehicle_trailers_hitch_status_check
    CHECK (hitched_vehicle_id IS NULL OR status <> 'retired'),
  CONSTRAINT vehicle_trailers_hitch_alive_check
    CHECK (hitched_vehicle_id IS NULL OR deleted_at IS NULL)
);

-- ── 2. Индексы ──

-- Уникальность среди живых: удалённый освобождает номер — тот же приём, что у техники (`0017`).
CREATE UNIQUE INDEX vehicle_trailers_reg_unique
  ON vehicle_trailers (registration_number_normalized) WHERE deleted_at IS NULL;
-- «Слот занят один раз»: два прицепа не могут претендовать на графу «прицеп 1» одной машины.
-- Обратное — «прицеп стоит за одним тягачом» — индекса не требует, оно следует из того, что
-- строка одна.
CREATE UNIQUE INDEX vehicle_trailers_hitch_slot_unique
  ON vehicle_trailers (hitched_vehicle_id, hitch_position) WHERE hitched_vehicle_id IS NOT NULL;
-- «Что закреплено за этой машиной» спрашивают при каждой сборке рейса — ради подстановки граф.
CREATE INDEX vehicle_trailers_hitched_vehicle_idx
  ON vehicle_trailers (hitched_vehicle_id) WHERE hitched_vehicle_id IS NOT NULL;
CREATE INDEX vehicle_trailers_status_idx ON vehicle_trailers (status) WHERE deleted_at IS NULL;

-- ── 3. Порядок слотов прицепа в рейсе ──
--
-- Второй слот при пустом первом — это графа, которую негде напечатать: бланк печатает слоты по
-- порядку. Сначала данные, потом ограничение: `ALTER TABLE … ADD CONSTRAINT` проверяет уже
-- лежащие строки и свалил бы миграцию на первой же такой. Через окна портала она появиться не
-- могла — второй слот не спрашивался нигде, — но остаются прямой вызов API, перенос
-- `backfill-routes.ts` и правки руками, поэтому починка идёт безусловно.
--
-- Рейс правят и дальше, и порядок граф в нём означает только порядок печати, — поэтому подъём
-- второго прицепа в первый слот здесь ничего не искажает.
UPDATE vehicle_routes
   SET trailer1_model = trailer2_model, trailer1_reg_number = trailer2_reg_number,
       trailer2_model = '', trailer2_reg_number = ''
 WHERE (trailer2_model <> '' OR trailer2_reg_number <> '')
   AND trailer1_model = '' AND trailer1_reg_number = '';

-- НА `waybills` ТАКОГО ОГРАНИЧЕНИЯ НЕТ — ни обычного, ни `NOT VALID`, и это решение, а не
-- недосмотр (§5). Лист помнит выданную бумагу (ADR 0037 п. 10): сдвинуть в нём графы нельзя, а
-- `NOT VALID` не спасает — он не проверяет старые строки, но проверяет каждую при `UPDATE`, а
-- листы обновляют (аннулирование пишет статус, время, причину и версию; коррекция задним числом —
-- `cancel_correction_id`). Старый лист с нарушенным порядком дожил бы до дня, когда его надо
-- аннулировать, и отказал бы именно тогда — сообщением про CHECK, в котором про прицепы нет ни
-- слова. Ограничение, ломающее списание бумаги, хуже отсутствующего.
--
-- Асимметрия закрепляется: порядок слотов проверяет рейс — там, где его правят; лист принимает
-- то, что ему передали.
ALTER TABLE vehicle_routes ADD CONSTRAINT vehicle_routes_trailer_order_check
  CHECK (trailer1_model <> '' OR trailer1_reg_number <> ''
         OR (trailer2_model = '' AND trailer2_reg_number = ''));
