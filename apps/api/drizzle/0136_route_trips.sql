-- Ездки в заявке, маршрут как порядок точек. План — `docs/route-trips-plan.md` (редакция 27), §5.
--
-- До этой миграции у грузовой заявки ровно одна пара адресов: `loading_location` и
-- `unloading_location` лежат прямо в строке деталей. Из этого следует всё, чего портал сегодня не
-- умеет. «Забрать с карьера и развезти на два объекта» одной заявкой не выражается — второй пары
-- колонок нет. «Съездить туда же ещё трижды» не выражается тоже: количество у заявки одно, и три
-- рейса пришлось бы заводить тремя заявками с одинаковыми адресами. А маршрут дня — это сегодня
-- просто список заявок (`vehicle_route_requests`), и порядок объезда в нём выразить нечем: заявка
-- занимает одну позицию, хотя машина заезжает по ней дважды — на погрузку и на разгрузку.
--
-- Отсюда три сущности вместо одной пары колонок:
--
--   * `vehicle_request_trips` — ЕЗДКА: своя пара адресов, своё количество, свои контакты, своё
--     время подачи. Строка заявки, а не маршрута (Р1): «ТС-40/2» существует и до того, как заявку
--     кто-то положил в рейс, и после того, как рейс пересобрали;
--   * `vehicle_route_points` — ТОЧКА маршрута: адрес и место в порядке объезда (Р4). Один и тот же
--     адрес может стоять в маршруте несколькими точками — это два заезда, и модель обязана уметь
--     их различать;
--   * `vehicle_route_point_trips` — что на точке ДЕЛАЮТ: погрузка ездки, разгрузка ездки или
--     работа линейного дня (Р5, Р5а). Связка, а не колонка в точке, потому что на одной остановке
--     законно сходятся две ездки разных заявок — тот самый случай «в двух заявках одно и то же
--     место погрузки, ехать дважды незачем».
--
-- Три составных ключа связки дают инварианты без единой строки кода: точка из своего маршрута,
-- ездка из своей заявки, заявка из состава этого маршрута. Приём тот же, каким строка состава
-- держит день рейса (0127) и назначение — заказанный тип заявки (0083).
--
-- Миграция НЕОБРАТИМА по смыслу данных: она переносит адреса, количество и контакты с заявки на
-- ездку и удаляет колонки-источники. Выкат — по протоколу `docs/schema-cutover-protocol.md`
-- (решение Р23): остановка записи, верификатор `backfill:trips --check` до подъёма сервисов,
-- постоянная граница отката. Обратный ход на время репетиции — `apps/api/teardown/0136_route_trips.sql`,
-- он возвращает колонки из ПЕРВОЙ ездки каждой заявки; заявок с двумя ездками к моменту отката не
-- существует, потому что teardown выполняется до записи floor, когда новый код не отработал ни
-- секунды.
--
-- Старым заявкам отдельной обработки не заводится (Р24): бэкфил делает из каждой ровно одну ездку,
-- а из каждой строки собранного маршрута — одну или две точки. После него легаси-данных не
-- существует, есть просто данные. Цена решения — полнота переноса, и её держат предохранители: у
-- миграции их четыре, и каждый называет числа, а не «не сошлось».
--
-- Номер 0136 — следующий свободный за 0135 (ADR 0077 §4: номер берётся с конца, а не вставляется в
-- середину).

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Предохранитель до всякого действия: грузовая заявка без строки деталей.
--
-- Бэкфил ездок идёт ОТ строк деталей, и заявка без них не получит ни одной ездки — молча, потому
-- что считать было бы нечего. Такая заявка после миграции стала бы битой: адресов у неё нет ни в
-- старом месте (колонки удалены), ни в новом. Схема этого не запрещает — детали лежат отдельной
-- таблицей, и их отсутствие технически возможно, — поэтому спрашиваем прямо и до изменений.
DO $$
DECLARE
  orphan int;
BEGIN
  SELECT count(*) INTO orphan
  FROM vehicle_requests r
  WHERE r.request_type = 'freight_transport'
    AND NOT EXISTS (
      SELECT 1 FROM freight_transport_request_details d WHERE d.request_id = r.id
    );
  IF orphan > 0 THEN
    RAISE EXCEPTION
      'Заявок на грузоперевозку без строки деталей: % шт. Каждая такая заявка потеряет адреса: '
      'бэкфил ездок идёт от деталей, а колонки-источники миграция удаляет. Разберите их до выката 0136.',
      orphan;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Ездка заявки (§5.1).
--
-- `request_id` колонкой, а не связкой: у ездки ровно одна заявка, и второй у неё не бывает (Р1).
-- CASCADE — ездка живёт ровно столько, сколько живёт заявка; «удалить насовсем» (ADR 0070) уносит
-- её вместе с заявкой, а от удаления заявки, побывавшей в выданном листе, по-прежнему защищает
-- RESTRICT со стороны листа (`waybill_trips.trip_id` ниже, как сегодня `waybill_requests`).
CREATE TABLE vehicle_request_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  -- Номер внутри заявки: «ТС-40/2». Неизменяем и НЕ переиспользуется после мягкого удаления
  -- (Р13а) — иначе «ТС-40/2» в старом листе и «ТС-40/2» в новом означали бы разное.
  num smallint NOT NULL,
  from_location text NOT NULL,
  to_location text NOT NULL,
  -- Метаданные верификации адреса (ADR 0006, ADR 0069) — те же, что уехали из деталей заявки:
  -- `source|fiasId|fiasLevel|geoLat|geoLon|refId`, NULL = введён вручную.
  from_address jsonb,
  to_address jsonb,
  -- Количество ЭТОЙ ездки, а не всей заявки: у заявки с ездками A→B и A→C общего количества не
  -- существует. Итог по заявке считается суммой (`requestCargoTotal`).
  volume_m3 numeric(12, 3),
  weight_tons numeric(12, 3),
  -- Контакт на каждом конце: грузят и принимают разные люди в разных местах (приём миграции 0062).
  -- Пусто — законное состояние: у заявок старше 0062 контакта нет вовсе. Телефон — десять цифр без
  -- кода страны (ADR 0066).
  from_responsible_name text NOT NULL DEFAULT '',
  from_responsible_phone text NOT NULL DEFAULT '',
  to_responsible_name text NOT NULL DEFAULT '',
  to_responsible_phone text NOT NULL DEFAULT '',
  -- Своё время подачи; NULL — «как у заявки» (Р3). Шесть ездок за смену едут по графику, а не
  -- одновременно, но отвечать на «когда» списком и фильтрами продолжает заявка.
  scheduled_at timestamptz,
  comment text NOT NULL DEFAULT '',
  -- Мягкое удаление (Р13а). Ездку, побывавшую в выданном листе, снести нельзя — на неё ссылается
  -- `waybill_trips` с RESTRICT, и это правильно: журнал бланков строгой отчётности обязан помнить,
  -- что именно печаталось. Но аннулирование листа размораживает маршрут, и диспетчер вправе
  -- пересобрать день, в том числе убрав ездку; жёсткое удаление упёрлось бы в ссылку навсегда.
  deleted_at timestamptz,

  -- Номер в заявке единственный. Он же и есть индекс «ездки этой заявки по порядку»: отдельного
  -- индекса `(request_id, num)` заводить не нужно — уникальное ограничение создаёт ровно его.
  CONSTRAINT vehicle_request_trips_num_unique UNIQUE (request_id, num),
  -- Цель составного FK из связки точки: «ездка из своей заявки» становится физическим фактом.
  -- Индекс под этим ограничением дублирует первичный ключ по `id`, и иначе нельзя — PostgreSQL
  -- требует, чтобы цель составного FK была уникальна именно этим набором колонок (та же плата,
  -- что у `vehicle_routes_id_date_unique` в 0127).
  CONSTRAINT vehicle_request_trips_id_request_unique UNIQUE (id, request_id),

  CONSTRAINT vehicle_request_trips_from_not_blank_check CHECK (btrim(from_location) <> ''),
  CONSTRAINT vehicle_request_trips_to_not_blank_check CHECK (btrim(to_location) <> ''),
  CONSTRAINT vehicle_request_trips_volume_positive_check
    CHECK (volume_m3 IS NULL OR volume_m3 > 0),
  CONSTRAINT vehicle_request_trips_weight_positive_check
    CHECK (weight_tons IS NULL OR weight_tons > 0),
  -- Форма метаданных адреса — ровно та же, что держали снятые ниже `freight_*_address_shape_check`
  -- (0013): объект с обязательным ключом `source`, структуру внутри проверяет Zod. Переносится
  -- вместе с колонками — иначе миграция тихо ослабила бы гарантию, которая стоит с ADR 0006.
  CONSTRAINT vehicle_request_trips_from_address_shape_check
    CHECK (from_address IS NULL OR (jsonb_typeof(from_address) = 'object' AND from_address ? 'source')),
  CONSTRAINT vehicle_request_trips_to_address_shape_check
    CHECK (to_address IS NULL OR (jsonb_typeof(to_address) = 'object' AND to_address ? 'source'))
);

COMMENT ON TABLE vehicle_request_trips IS
  'Ездка заявки на грузоперевозку: пара адресов, количество и контакты одной поездки. '
  'Строка заявки, а не маршрута: существует и до укладки в рейс, и после его пересборки.';
COMMENT ON COLUMN vehicle_request_trips.num IS
  'Номер ездки внутри заявки («ТС-40/2»): неизменяем и не переиспользуется после мягкого удаления.';
COMMENT ON COLUMN vehicle_request_trips.scheduled_at IS
  'Своё время подачи ездки; NULL — время заявки. Списки и фильтры по-прежнему отбирает заявка.';
COMMENT ON COLUMN vehicle_request_trips.deleted_at IS
  'Мягкое удаление: ездку из выданного листа держит RESTRICT, а маршрут после аннулирования пересобирают.';

-- Бэкфил ездок (§5.6). Раскладка однозначна: у каждой существующей заявки ровно одна ездка.
--
-- Фильтра по `deleted_at` заявки здесь нет намеренно: детали архивных заявок лежат на месте, их
-- карточки открываются и печатаются, и заявка без ездки после миграции стала бы пустой. Закрытые
-- и отменённые — по той же причине.
--
-- Переносится и то, что жёсткая модель сегодня уже не пропустила бы: пустой контакт у заявок
-- старше 0062, адрес без метаданных. Это законное состояние, а не пропуск, и счётом оно не
-- ловится; правимость таких заявок обеспечивает сервер (Р2а), спрашивая жёсткую модель за новое
-- значение, а не за перезапись прежнего.
INSERT INTO vehicle_request_trips (
  request_id, num, from_location, to_location, from_address, to_address,
  volume_m3, weight_tons,
  from_responsible_name, from_responsible_phone, to_responsible_name, to_responsible_phone
)
SELECT
  d.request_id, 1, d.loading_location, d.unloading_location, d.loading_address, d.unloading_address,
  d.volume_m3, d.weight_tons,
  d.loading_responsible_name, d.loading_responsible_phone,
  d.unloading_responsible_name, d.unloading_responsible_phone
FROM freight_transport_request_details d;

-- Предохранитель «ездка на каждую грузовую заявку» (§5.6). Пара к пункту 1: тот ловит заявку без
-- деталей, этот — деталь, не доехавшую до ездки.
DO $$
DECLARE
  trips int;
  details int;
BEGIN
  SELECT count(*) INTO trips FROM vehicle_request_trips;
  SELECT count(*) INTO details FROM freight_transport_request_details;
  IF trips <> details THEN
    RAISE EXCEPTION
      'Бэкфил ездок не сошёлся: ездок % шт., строк деталей % шт. Ожидалась ровно одна ездка на строку деталей.',
      trips, details;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Точка маршрута (§5.2).
--
-- Колонок ответственного у точки нет, хотя тождество точки его включает (Р9), — и это осознанно.
-- Ответственный приходит от строки задания: у роли `load` это контакт погрузки ездки, у `unload` —
-- контакт разгрузки, у `work` — ответственный заявки спецтехники. Значит ответственные точки это
-- множество контактов её ролей, и вычислять его дешевле, чем поддерживать копию, которая
-- разойдётся с заявкой при первой же правке контакта (Р9в).
--
-- Адрес при этом ХРАНИТСЯ снимком (Р10), и разница не в непоследовательности, а в однозначности: у
-- точки с двумя ездками разных адресов «адрес» не определён без выбора, а «ответственные»
-- определены всегда — их просто двое. Расхождение снимка с ездкой портал помечает и чинит кнопкой.
CREATE TABLE vehicle_route_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes (id) ON DELETE CASCADE,
  -- Порядок объезда. До двадцати: две точки на ездку, а строк задания в бланке максимум десять
  -- (ADR 0068). Верхняя граница здесь — защита от переполнения, а сколько строк влезет в
  -- конкретный маршрут, по-прежнему решает его бланк, и держит это сервер.
  position smallint NOT NULL,
  location text NOT NULL,
  address jsonb,
  -- План прибытия; NULL — не задан. `time`, а не `timestamptz`: день у точки один и тот же, что у
  -- рейса, и второй копией даты она разошлась бы с ним при переносе (ADR 0082).
  arrival_time time,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_route_points_position_check CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT vehicle_route_points_location_not_blank_check CHECK (btrim(location) <> ''),
  CONSTRAINT vehicle_route_points_address_shape_check
    CHECK (address IS NULL OR (jsonb_typeof(address) = 'object' AND address ? 'source')),
  -- DEFERRABLE INITIALLY IMMEDIATE — тот же приём, что у порядка строк состава (0072):
  -- перестановка переписывает позиции одним запросом, и построчная проверка упала бы на первой же
  -- строке; транзакция перестановки откладывает ограничение через `SET CONSTRAINTS`.
  CONSTRAINT vehicle_route_points_position_unique UNIQUE (route_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  -- Цель составного FK из связки: «точка из своего маршрута» — физический факт, а не проверка.
  CONSTRAINT vehicle_route_points_id_route_unique UNIQUE (id, route_id)
);

COMMENT ON TABLE vehicle_route_points IS
  'Точка маршрута: адрес остановки и её место в порядке объезда. Один адрес может стоять '
  'несколькими точками — это два заезда. Ответственных у точки нет: они выводятся из её ролей.';
COMMENT ON COLUMN vehicle_route_points.location IS
  'Адрес остановки снимком (не ссылкой на ездку): на точке сходятся ездки разных заявок.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Что делаем на точке (§5.3).
--
-- КЛЮЧ СУРРОГАТНЫЙ, И ИНАЧЕ НЕЛЬЗЯ. Естественного составного PK тут нет: колонки первичного ключа
-- PostgreSQL делает NOT NULL, а `trip_id` у линейной строки обязан быть пустым — «role = 'work' и
-- trip_id IS NULL» с `trip_id` в PK невыполнимо в принципе. Пара `(point_id, request_id, role)`
-- тоже не годится: две ездки одной заявки законно грузятся на одной точке, и строк было бы две.
-- Отсюда `id` и уникальности ЧАСТИЧНЫМИ ИНДЕКСАМИ — табличными ограничениями `UNIQUE … WHERE` в
-- PostgreSQL не объявляются вовсе.
CREATE TABLE vehicle_route_point_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_id uuid NOT NULL,
  route_id uuid NOT NULL,
  request_id uuid NOT NULL,
  -- Ездка грузоперевозки; NULL — строка линейного дня, у него ездок нет (Р5а): машина приезжает
  -- на объект и работает там, «откуда — куда» у неё не существует.
  trip_id uuid,
  role text NOT NULL,

  CONSTRAINT route_point_trips_role_check CHECK (role IN ('load', 'unload', 'work')),
  -- Роль и наличие ездки согласованы: `work` без ездки, `load`/`unload` — только с ней.
  CONSTRAINT route_point_trips_role_trip_check
    CHECK ((role = 'work' AND trip_id IS NULL) OR (role <> 'work' AND trip_id IS NOT NULL)),

  CONSTRAINT route_point_trips_point_fk FOREIGN KEY (point_id, route_id)
    REFERENCES vehicle_route_points (id, route_id) ON DELETE CASCADE,
  -- MATCH SIMPLE (умолчание): при NULL в `trip_id` ключ не проверяется вовсе — ровно то, что нужно
  -- линейной строке. Тем же приёмом устроен `vehicle_route_requests_route_date_fk` (0127).
  --
  -- RESTRICT, а не CASCADE: ездку, побывавшую в маршруте, нельзя снести из-под задания. Как она
  -- удаляется — мягко, `deleted_at` (Р13а).
  CONSTRAINT route_point_trips_trip_fk FOREIGN KEY (trip_id, request_id)
    REFERENCES vehicle_request_trips (id, request_id) ON DELETE RESTRICT,
  -- Строка обслуживается только там, где её заявка стоит в составе маршрута — физически, а не
  -- проверкой. Изъятие заявки из состава каскадом снимает все её роли, а опустевшие точки
  -- доудаляет сервис (Р13): точка без ролей задания не несёт и в бланке не печатается.
  CONSTRAINT route_point_trips_composition_fk FOREIGN KEY (route_id, request_id)
    REFERENCES vehicle_route_requests (route_id, request_id) ON DELETE CASCADE
);

-- Ездка обслуживается ровно одной погрузкой и одной разгрузкой (Р5). Совмещение двух ездок на
-- одном заезде — это две строки `load` у одной точки, и оно этим индексом не задевается.
CREATE UNIQUE INDEX route_point_trips_trip_role_unique
  ON vehicle_route_point_trips (trip_id, role) WHERE trip_id IS NOT NULL;
-- Линейный день занимает ровно одну точку своего маршрута (Р5а). Какой именно это день, отдельно
-- не хранится: он лежит в `work_date` той строки состава, на которую смотрит третий ключ. Второй
-- копии дня не заводим — она разошлась бы с составом при переносе рейса на другую дату (ADR 0082).
CREATE UNIQUE INDEX route_point_trips_linear_unique
  ON vehicle_route_point_trips (route_id, request_id) WHERE role = 'work';
-- «Что делают на этой точке» — главный вопрос к таблице; он же покрывает каскад от точки.
CREATE INDEX route_point_trips_point_idx ON vehicle_route_point_trips (point_id);
-- Под каскад от состава маршрута. Частичный индекс линейных строк его не закрывает: у грузовых
-- ролей `role <> 'work'`, и изъятие заявки из состава сканировало бы таблицу целиком.
CREATE INDEX route_point_trips_composition_idx
  ON vehicle_route_point_trips (route_id, request_id);

COMMENT ON TABLE vehicle_route_point_trips IS
  'Что делают на точке: погрузка или разгрузка ездки, либо работа линейного дня. Три составных '
  'ключа держат инварианты физически — точка из своего маршрута, ездка из своей заявки, заявка '
  'из состава этого маршрута.';
COMMENT ON COLUMN vehicle_route_point_trips.trip_id IS
  'Ездка грузоперевозки; NULL — строка линейного дня: ездок у него нет.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Бэкфил точек и ролей (§5.6).
--
-- Состав уже собранных маршрутов смешанный, и переносится он по-разному:
--   * грузовая строка (`work_date IS NULL`) — две точки, погрузка и разгрузка, роли `load`/`unload`;
--   * линейный день (`work_date IS NOT NULL`) — одна точка с ролью `work`, адрес берётся у объекта
--     заявки: линейная техника едет работать на площадку, другого адреса у дня нет (ADR 0100 §10).
--
-- ПОДРЯД ИДУЩИЕ ОДИНАКОВЫЕ АДРЕСА НЕ СКЛЕИВАЮТСЯ: бэкфил не принимает решений за диспетчера.
-- Совмещение точек — явное действие человека (Р9а), и сделанное миграцией «за него» пришлось бы
-- разносить обратно вручную, не зная, что именно было склеено.

-- Предохранитель адреса линейного дня. Строка задания такого дня печатает «наименование объекта,
-- адрес» (та же склейка, что в `waybill-issue.ts`), и пустой она быть не может: у точки CHECK на
-- непустой адрес, и он упал бы кодом 23514 без единого слова о том, у какого объекта дыра.
DO $$
DECLARE
  blank int;
BEGIN
  SELECT count(*) INTO blank
  FROM vehicle_route_requests rr
  JOIN vehicle_requests r ON r.id = rr.request_id
  LEFT JOIN construction_objects co ON co.id = r.object_id
  WHERE rr.work_date IS NOT NULL
    AND btrim(concat_ws(', ', nullif(btrim(co.name), ''), nullif(btrim(co.address), ''))) = '';
  IF blank > 0 THEN
    RAISE EXCEPTION
      'Дней линейных заказов, у объекта которых нет ни наименования, ни адреса: % шт. '
      'Точке маршрута нечего записать адресом — заполните объекты до выката 0136.',
      blank;
  END IF;
END $$;

-- План раскладки во временной таблице, а не в CTE: точки и роли заводятся двумя вставками, и
-- вторая обязана видеть уже присвоенные `id` точек. Data-modifying CTE выдал бы их одним запросом,
-- но порядок срабатывания ссылочных проверок внутри одного запроса — деталь реализации, на
-- которую опираться в миграции незачем; отдельный шаг стоит одну временную таблицу.
CREATE TEMP TABLE route_point_plan AS
WITH parts AS (
  -- Погрузка грузовой строки.
  SELECT rr.route_id, rr.request_id, rr.position AS comp_position, 1 AS leg,
         'load'::text AS role, t.id AS trip_id,
         t.from_location AS location, t.from_address AS address
  FROM vehicle_route_requests rr
  JOIN vehicle_request_trips t ON t.request_id = rr.request_id AND t.num = 1
  WHERE rr.work_date IS NULL
  UNION ALL
  -- Её же разгрузка — следующей точкой: погрузка раньше разгрузки (Р6).
  SELECT rr.route_id, rr.request_id, rr.position, 2,
         'unload', t.id, t.to_location, t.to_address
  FROM vehicle_route_requests rr
  JOIN vehicle_request_trips t ON t.request_id = rr.request_id AND t.num = 1
  WHERE rr.work_date IS NULL
  UNION ALL
  -- Линейный день: одна точка, адрес — объект заявки. Метаданных адреса у него нет: в справочнике
  -- объектов адрес хранится строкой, и выдумывать `source` за него нечем.
  SELECT rr.route_id, rr.request_id, rr.position, 1,
         'work', NULL::uuid,
         btrim(concat_ws(', ', nullif(btrim(co.name), ''), nullif(btrim(co.address), ''))),
         NULL::jsonb
  FROM vehicle_route_requests rr
  JOIN vehicle_requests r ON r.id = rr.request_id
  LEFT JOIN construction_objects co ON co.id = r.object_id
  WHERE rr.work_date IS NOT NULL
)
SELECT
  p.route_id,
  p.request_id,
  p.role,
  p.trip_id,
  p.location,
  p.address,
  -- Порядок объезда повторяет порядок строк задания, а внутри строки — «сначала грузим, потом
  -- везём». Потолок в двадцать позиций при этом не пробивается по построению: строк состава не
  -- больше десяти (UNIQUE `(route_id, position)` при CHECK 1..10), и каждая даёт максимум две.
  (row_number() OVER (PARTITION BY p.route_id ORDER BY p.comp_position, p.leg))::smallint
    AS point_position
FROM parts p;

INSERT INTO vehicle_route_points (route_id, position, location, address)
SELECT route_id, point_position, location, address FROM route_point_plan;

INSERT INTO vehicle_route_point_trips (point_id, route_id, request_id, trip_id, role)
SELECT pt.id, pl.route_id, pl.request_id, pl.trip_id, pl.role
FROM route_point_plan pl
JOIN vehicle_route_points pt
  ON pt.route_id = pl.route_id AND pt.position = pl.point_position;

DROP TABLE route_point_plan;

-- Предохранитель раскладки маршрутов (§5.6). Счёт ролей — ровно два на грузовую строку состава и
-- один на линейный день; точек столько же, потому что бэкфил ничего не склеивает.
DO $$
DECLARE
  roles int;
  points int;
  expected int;
  freight_rows int;
  linear_rows int;
BEGIN
  SELECT count(*) FILTER (WHERE work_date IS NULL), count(*) FILTER (WHERE work_date IS NOT NULL)
    INTO freight_rows, linear_rows
  FROM vehicle_route_requests;
  expected := 2 * freight_rows + linear_rows;
  SELECT count(*) INTO roles FROM vehicle_route_point_trips;
  SELECT count(*) INTO points FROM vehicle_route_points;
  IF roles <> expected THEN
    RAISE EXCEPTION
      'Бэкфил состава маршрутов не сошёлся: строк задания % шт., ожидалось % '
      '(2 × % грузовых строк состава + 1 × % линейных дней).',
      roles, expected, freight_rows, linear_rows;
  END IF;
  IF points <> expected THEN
    RAISE EXCEPTION
      'Бэкфил точек не сошёлся: точек % шт., ожидалось % — по точке на строку задания, '
      'подряд идущие одинаковые адреса не склеиваются.',
      points, expected;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Лист ↔ ездка (§5.5).
--
-- `waybill_requests` остаётся как есть — связью «лист ↔ заявка» (Р20): на неё смотрят
-- `activeWaybillOfRequest`, откат статуса и легаси-проверки, и её первичный ключ
-- `(waybill_id, request_id)` не даёт записать заявку с тремя ездками трижды. Рядом заводится
-- вторая связь: какая ездка какой строкой напечатана.
--
-- Ни `vehicle_route_requests_position_check` (1..10), ни `waybill_requests_slot_unique` при этом НЕ
-- снимаются, хотя прежняя редакция плана снимала оба. Потолок состава верен: строк состава не
-- может быть больше, чем строк задания в бланке, — каждая строка состава это либо грузовая заявка
-- (её ездки занимают строки задания), либо линейный день (одна строка); для линейных дней это к
-- тому же единственная защита от переполнения на уровне базы. `waybill_requests_slot_unique` верен
-- тоже: `slot` объявлен ПЕРВОЙ строкой задания заявки, а первые строки двух разных заявок совпасть
-- не могут — строка задания принадлежит одной заявке.
CREATE TABLE waybill_trips (
  waybill_id uuid NOT NULL REFERENCES waybills (id) ON DELETE CASCADE,
  -- RESTRICT: журнал бланков строгой отчётности обязан помнить, что именно печаталось. Ровно так
  -- же сегодня держит заявку `waybill_requests.request_id`, и поведение «удалить насовсем» от
  -- новой таблицы не меняется: без листа заявка удаляется вместе с ездками, с листом — не
  -- удаляется и сейчас.
  trip_id uuid NOT NULL REFERENCES vehicle_request_trips (id) ON DELETE RESTRICT,
  slot smallint NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waybill_trips_pkey PRIMARY KEY (waybill_id, trip_id),
  CONSTRAINT waybill_trips_slot_check CHECK (slot BETWEEN 1 AND 10),
  CONSTRAINT waybill_trips_slot_unique UNIQUE (waybill_id, slot)
);

-- «В каком листе уехала эта ездка» — вопрос карточки ездки; он же покрывает проверку RESTRICT при
-- удалении ездки. Приём `waybill_requests_request_idx`.
CREATE INDEX waybill_trips_trip_idx ON waybill_trips (trip_id);

COMMENT ON TABLE waybill_trips IS
  'Лист ↔ ездка: какая ездка какой строкой задания напечатана. Покрывает только грузовые строки — '
  'у линейного дня ездки нет, и его строка опознаётся парой «заявка + work_date».';

-- Бэкфил старых листов: та же строка `waybill_requests`, тот же `slot`, единственная ездка заявки.
-- Отбор сужен видом заявки намеренно: у линейных строк выданных листов ездки нет и не будет.
INSERT INTO waybill_trips (waybill_id, trip_id, slot, added_at)
SELECT wr.waybill_id, t.id, wr.slot, wr.added_at
FROM waybill_requests wr
JOIN vehicle_requests r ON r.id = wr.request_id AND r.request_type = 'freight_transport'
JOIN vehicle_request_trips t ON t.request_id = wr.request_id AND t.num = 1;

DO $$
DECLARE
  links int;
  expected int;
BEGIN
  SELECT count(*) INTO links FROM waybill_trips;
  SELECT count(*) INTO expected
  FROM waybill_requests wr
  JOIN vehicle_requests r ON r.id = wr.request_id
  WHERE r.request_type = 'freight_transport';
  IF links <> expected THEN
    RAISE EXCEPTION
      'Бэкфил связи «лист ↔ ездка» не сошёлся: строк % шт., ожидалось % — по строке на талон '
      'грузовой заявки (у линейных строк ездки нет, и они в счёт не входят).',
      links, expected;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Под какими предупреждениями выдан лист (Р21).
--
-- Конверт, а не голый массив: различать нужно ТРИ состояния — `not_checked` (лист выдан до колонки
-- либо мимо рукопожатия — повтором запроса из истории, старой вкладкой, `curl`), `clean`
-- (проверено, предупреждений не было) и `acknowledged` (были и подтверждены, с отпечатком и
-- списком). Пустой массив первых двух не различал бы, а через полгода «не проверяли» не должно
-- читаться как «всё чисто».
--
-- Умолчание — константа, поэтому PostgreSQL добавляет колонку метаданными и таблицу не переписывает.
ALTER TABLE waybills
  ADD COLUMN issue_warnings jsonb NOT NULL
    DEFAULT '{"schemaVersion":1,"status":"not_checked"}'::jsonb;

COMMENT ON COLUMN waybills.issue_warnings IS
  'Под какими предупреждениями выдан лист: not_checked | clean | acknowledged (с отпечатком и списком).';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 8. Что теряет заявка (§5.4).
--
-- Держать адреса, количество и контакты в двух местах нельзя: у заявки с ездками A→B и A→C «адрес
-- разгрузки заявки» не существует (Р2). Остаётся то, что описывает заказ целиком — заказчик, тип и
-- категория ТС, время подачи, комментарий, файлы; `scheduled_at` и `scheduled_time_unspecified`
-- остаются на месте, по ним считается дата маршрута и работают фильтры (Р3).
--
-- Чтения «на всякий случай» из старых колонок не оставляем: второй источник истины породил бы
-- вечный вопрос, откуда читать, а откат за границу floor всё равно запрещён (Р23) — запасного пути
-- эти колонки не дали бы.
--
-- Ограничения снимаются явно, хотя `DROP COLUMN` снял бы их и сам: так в файле видно ВСЁ, что
-- исчезает из схемы, и teardown симметричен строка в строку. Их семь, а не три, как называла §5.4
-- плана: к трём перечисленным там добавляются два «положительного количества» (0021) и два «формы
-- метаданных адреса» (0013) — их предмет переехал на ездку вместе с колонками.
ALTER TABLE freight_transport_request_details
  DROP CONSTRAINT freight_volume_or_weight_check,
  DROP CONSTRAINT freight_volume_positive_check,
  DROP CONSTRAINT freight_weight_positive_check,
  DROP CONSTRAINT freight_loading_not_blank_check,
  DROP CONSTRAINT freight_unloading_not_blank_check,
  DROP CONSTRAINT freight_loading_address_shape_check,
  DROP CONSTRAINT freight_unloading_address_shape_check;

ALTER TABLE freight_transport_request_details
  DROP COLUMN loading_location,
  DROP COLUMN loading_address,
  DROP COLUMN unloading_location,
  DROP COLUMN unloading_address,
  DROP COLUMN volume_m3,
  DROP COLUMN weight_tons,
  DROP COLUMN loading_responsible_name,
  DROP COLUMN loading_responsible_phone,
  DROP COLUMN unloading_responsible_name,
  DROP COLUMN unloading_responsible_phone;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 9. Запись выпуска (ADR 0077 §4).
--
-- В той же миграции, потому что бандл необратимого выката — ровно одна миграция (протокол §6):
-- окажись запись выпуска отдельным файлом, снятие нашей оставило бы её в журнале без файла, и
-- предыдущий образ не стартовал бы вовсе (`missing`).
--
-- Хвост версии — `0108`, номер ADR этой переработки (решения Р1–Р26). ADR пишется последним этапом
-- плана; 0107 занял соседний поток (заморозка линейного режима), поэтому взят следующий свободный.
-- Если займут и его — поправить нужно оба места: здесь и в самом
-- ADR, номер выпуска сверяется с каталогом перед выкатом (та же оговорка, что у номера миграции).
INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  19, '0.1.18.0108', '2026-08-13', 'Ездки в заявке и порядок объезда в рейсе', '{108}',
  '[
    {"kind":"feature","text":"Заявка на грузоперевозку описывается ездками: у каждой свои «откуда» и «куда», своё количество, свои контакты на обоих концах и своё время подачи. «Забрать с карьера и развезти на два объекта» и «съездить туда же ещё трижды» оформляются одной заявкой, а не тремя одинаковыми"},
    {"kind":"feature","text":"У рейса появился порядок объезда: список точек, который диспетчер выстраивает стрелками. Одна ездка занимает две точки — погрузку и разгрузку, — а день линейной техники одну: приехал на площадку и работает"},
    {"kind":"feature","text":"Точки совмещаются и разносятся вручную: две заявки с одним местом погрузки становятся одним заездом, а один адрес с двумя разными ответственными портал сам не склеивает — решение «это один заезд» принимает человек"},
    {"kind":"improvement","text":"Взятие заявки в работу раскладывает её ездки по маршруту само: погрузка садится на подходящую точку, если такая в рейсе уже есть, иначе заводится новая. Дальше диспетчер правит порядок руками"},
    {"kind":"improvement","text":"Портал не даёт выписать лист, в котором ездка разгружается раньше, чем грузится, и предупреждает, если адрес точки разошёлся с адресом ездки — заявку поправили после сборки дня. Расхождение чинится одной кнопкой «подтянуть из ездки»"},
    {"kind":"improvement","text":"Выписка листа спрашивает подтверждение, когда есть о чём предупредить: пробелы в документах водителя, расхождение адресов, пустой бланк. Под какими предупреждениями выдан номер, остаётся в журнале — «не проверяли» больше не читается как «всё чисто»"},
    {"kind":"improvement","text":"В строке задания печатается адрес точки, а в графе «заказчик, телефон» — ответственные по этой точке, а не по заявке. Талон по-прежнему выписывается на строку задания, и заказчик у него один"},
    {"kind":"improvement","text":"В журнале листов видно, какая ездка какой строкой напечатана, а в карточке ездки — в каком листе она уехала. Ездку, побывавшую в выданном листе, портал не удаляет насовсем: она скрывается из задания, но остаётся видимой из журнала и истории"},
    {"kind":"improvement","text":"Задание водителю — письмом накануне и в кабинете — идёт порядком объезда: точка за точкой, с адресами, временем прибытия и записками диспетчера"},
    {"kind":"improvement","text":"История правок заявки называет ездки по номерам («ТС-40/2»), а записи, сделанные до переработки, читаются как раньше — прежние подписи полей сохранены"}
  ]'::jsonb
);
