-- Показания техники: одометр, моточасы и заправленное за смену.
-- План — `docs/driver-portal-plan.md`, §4 (решения Р14–Р26); ADR 0103.
--
-- До этой миграции портал не хранил состояния машины вообще. Ближайшее, что было, — смены заказа
-- спецтехники (`vehicle_request_shifts`, миграция 0071): там машиночасы за день и заправка
-- СВОБОДНЫМ ТЕКСТОМ, и это учёт по договору с арендодателем, а не состояние единицы. Пробега,
-- наработки и показаний счётчика не было нигде.
--
-- Четыре решения задают всю схему ниже, и каждое выражено ключом, а не соглашением в коде.
--
-- 1. ПОКАЗАНИЕ ПРИНАДЛЕЖИТ ВЫЕЗДУ, А НЕ ДНЮ. У машины за сутки законно бывает две смены (день и
--    ночь — это два рейса и два листа: `vehicle_routes` намеренно не держит UNIQUE по паре
--    «машина + дата»). Ключ «машина + день» заставил бы вторую смену перезаписывать первую, а без
--    источника невозможно ответить, в каком порядке они шли и кому относится разница. Поэтому
--    строка ожидания ссылается на рейс либо на недельный ЭСМ-2 — и ровно на один из двух.
--
-- 2. СОСТАВ ДНЯ ФИКСИРУЕТСЯ ОТПРАВКОЙ. Строки ожидания — снимок задания на момент отправки.
--    Иначе рейс, заведённый после приёмки, молча превращал бы принятый день в неполный: полнота
--    менялась бы задним числом без единой правки. Появившийся позже источник становится
--    расхождением, которое разбирает человек.
--
-- 3. СНИМОК НЕ РАСХОДИТСЯ С ПОКАЗАНИЕМ. Копии машины, дня и позиции смены живут и в строке
--    ожидания, и в показании — ради индексов и цепочки, — и скреплены составным внешним ключом с
--    `ON UPDATE CASCADE`. Подменить машину в обход строки ожидания нельзя, а исправленный порядок
--    смены уезжает в показание сам.
--
-- 4. ИСТОРИЯ ТРАНЗАКЦИОННА. `writeAudit` (`apps/api/src/lib/audit.ts`) пишет отдельным соединением
--    и гасит ошибку в лог: учётное число могло бы измениться без следа. Поэтому у отчёта и у
--    показания свои таблицы истории, и пишутся они той же транзакцией, что и правка.
--
-- ОБРАТИМОСТЬ. Миграция аддитивная: новые типы и таблицы, ни одной перезаписи. Новые типы
-- создаются здесь же — запрет «нельзя пользоваться значением в своей транзакции» касается только
-- `ALTER TYPE ... ADD VALUE` (см. 0130). Откат кода схему не ломает: прежняя сборка этих таблиц не
-- знает и не пишет в них. Обратной миграции репозиторий не держит — `migrate.ts` только накатывает.

-- ── Перечисления ──

-- `needs_reacceptance` — принятый отчёт, который после этого правили: `accepted_*` сохраняются, и
-- расхождение версий показывает, насколько принятое разошлось с текущим. `voided` — отчёт, из
-- которого перенос строки унёс последнюю: приёмке не подлежит, историю хранит.
CREATE TYPE driver_report_state AS ENUM (
  'draft', 'submitted', 'accepted', 'needs_reacceptance', 'voided'
);

-- Чем задан выезд. Третьего не бывает: у 4-П и формы № 3 источник — сам рейс
-- (`waybills_form_source_check`), и лист таких форм отдельной строкой ожидания не становится —
-- иначе один выезд получил бы две карточки в форме и две точки в цепочке.
CREATE TYPE reading_source_kind AS ENUM ('route', 'esm2');

-- `no_data` — «работали, но снять нечего»: счётчик неисправен, машину увёл сменщик, кабина
-- опечатана. Это ЗАКРЫТИЕ строки с причиной, а не пропуск, и различать их обязательно: приёмка
-- требует закрытых строк, а пустая строка в отправленном отчёте — это забыли.
CREATE TYPE reading_kind AS ENUM ('values', 'no_data');

CREATE TYPE reading_source AS ENUM ('driver', 'staff');

-- Начала ряда здесь нет намеренно: «предшественника не было» — состояние, а не отклонение. Заведи
-- его аномалией — и первое показание каждой машины навсегда осталось бы расхождением в гараже.
CREATE TYPE reading_anomaly AS ENUM ('counter_reset', 'implausible_jump');

CREATE TYPE reading_event AS ENUM ('created', 'updated', 'anomaly_confirmed', 'chain_relinked');

CREATE TYPE report_event AS ENUM (
  'created', 'submitted', 'accepted', 'reopened', 'voided',
  'item_added', 'item_removed', 'shift_order_changed', 'discrepancy_resolved'
);

CREATE TYPE discrepancy_kind AS ENUM (
  'driver', 'vehicle', 'date', 'source_state', 'missing_source'
);

-- `revoked` отменяет прежнее решение при НЕИЗМЕННОМ отпечатке: без него расхождение, однажды
-- признанное допустимым, нельзя было бы снова сделать неразобранным — вторая запись с тем же
-- исходом ничего не меняет.
CREATE TYPE discrepancy_resolution AS ENUM ('accepted_as_is', 'source_added', 'revoked');

-- ── Отчёт дня ──
--
-- Шапка, без которой отсутствие строки не является фактом: только с ней различимы «машину
-- пропустили намеренно», «не дозаполнили» и «строка не сохранилась». К ней же относится приёмка —
-- принимают день, а не отдельное число.
CREATE TABLE driver_daily_reports (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id                uuid NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  report_date              date NOT NULL,
  state                    driver_report_state NOT NULL DEFAULT 'draft',
  submitted_at             timestamptz,
  accepted_by              uuid REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at              timestamptz,
  -- Редакция содержимого, которую подтвердил принимающий: приём фиксирует данные, а не нажатие.
  accepted_content_version integer,
  -- Числа, вид строки, причины, комментарии, состав строк ожидания и порядок смен.
  content_version          integer NOT NULL DEFAULT 0,
  -- Оптимистическая блокировка: растёт при ЛЮБОМ изменении шапки, включая смену состояния. Ею же
  -- упорядочен журнал решений по расхождениям — время начала транзакции для этого не годится.
  version                  integer NOT NULL DEFAULT 0,
  -- Идемпотентность отправки: ключ клиента и отпечаток принятого тела. Тот же ключ с другим телом
  -- — это уже другая команда под старым ключом, и молча подтверждать её нельзя.
  submit_idempotency_key   uuid,
  submit_fingerprint       text NOT NULL DEFAULT '',
  created_by               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by               uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT driver_daily_reports_versions_check CHECK (
    content_version >= 0 AND version >= 0
    AND (accepted_content_version IS NULL
      OR (accepted_content_version >= 0 AND accepted_content_version <= content_version))
  ),

  -- Полная матрица состояний ОДНИМ условием, а не поля по одному: иначе `draft` с заполненной
  -- приёмкой и `accepted` с разошедшимися версиями остаются формально законными. Две средние
  -- ветки и есть определение принятых состояний: `accepted` — «подтверждённая редакция равна
  -- текущей», `needs_reacceptance` — «подтверждали редакцию младше».
  CONSTRAINT driver_daily_reports_state_check CHECK (
    (state = 'draft' AND submitted_at IS NULL AND accepted_at IS NULL
      AND accepted_by IS NULL AND accepted_content_version IS NULL)
    OR (state = 'submitted' AND submitted_at IS NOT NULL AND accepted_at IS NULL
      AND accepted_by IS NULL AND accepted_content_version IS NULL)
    OR (state = 'accepted' AND submitted_at IS NOT NULL AND accepted_at IS NOT NULL
      AND accepted_by IS NOT NULL AND accepted_content_version = content_version)
    OR (state = 'needs_reacceptance' AND submitted_at IS NOT NULL AND accepted_at IS NOT NULL
      AND accepted_by IS NOT NULL AND accepted_content_version < content_version)
    OR (state = 'voided' AND submitted_at IS NOT NULL
      AND ((accepted_at IS NULL AND accepted_by IS NULL AND accepted_content_version IS NULL)
        OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL
            AND accepted_content_version < content_version)))
  ),

  CONSTRAINT driver_daily_reports_idempotency_check CHECK (
    (submit_idempotency_key IS NULL) = (submit_fingerprint = '')
  )
);

CREATE UNIQUE INDEX driver_daily_reports_key ON driver_daily_reports (person_id, report_date);
-- Цель составного внешнего ключа из строк ожидания: день строки равен дню своего отчёта.
ALTER TABLE driver_daily_reports
  ADD CONSTRAINT driver_daily_reports_date_unique UNIQUE (id, report_date);
-- «Что ждёт приёмки» — вопрос, с которого начинают утро.
CREATE INDEX driver_daily_reports_open_idx ON driver_daily_reports (report_date DESC)
  WHERE state IN ('submitted', 'needs_reacceptance');

-- ── Строки ожидания ──
--
-- Снимок источников дня. Состояния у строки нет намеренно: оно выводится из наличия и вида
-- показания. Хранимое «сдано» дублировало бы факт и допускало расхождение с ним — строку можно
-- было бы пометить закрытой, не записав ни одного числа.
CREATE TABLE driver_daily_report_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES driver_daily_reports(id) ON DELETE CASCADE,
  source_kind  reading_source_kind NOT NULL,
  route_id     uuid REFERENCES vehicle_routes(id) ON DELETE RESTRICT,
  waybill_id   uuid REFERENCES waybills(id) ON DELETE RESTRICT,
  -- Снимок машины: по нему считаются расхождение и цепочка, а не по живому источнику.
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  -- Копия дня отчёта: входит в ключ снимка и скреплена с шапкой внешним ключом ниже.
  report_date  date NOT NULL,
  -- Позиция смены машины в дне. Начальное значение назначает сервер (сначала недельные листы,
  -- затем рейсы), но это ПРИБЛИЖЕНИЕ: `vehicle_routes.num` говорит, когда рейс завели, а не когда
  -- машина выехала, и утренний рейс, заведённый после вечернего, встал бы в цепочку последним.
  -- Поэтому позиция исправляется человеком — с причиной, историей и перестройкой цепочки.
  shift_order  smallint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_items_source_check CHECK (
    (source_kind = 'route') = (route_id IS NOT NULL)
    AND (source_kind = 'esm2') = (waybill_id IS NOT NULL)
  ),
  CONSTRAINT report_items_shift_order_check CHECK (shift_order > 0),
  CONSTRAINT report_items_report_date_fk FOREIGN KEY (report_id, report_date)
    REFERENCES driver_daily_reports (id, report_date) ON UPDATE CASCADE
);

-- Источник занят ГЛОБАЛЬНО, а не внутри отчёта: рейс — один на портал, недельный лист — один на
-- день. Уникальность внутри отчёта пропускала бы тот же рейс во второй отчёт после переназначения
-- водителя, и один выезд закрывали бы двое.
CREATE UNIQUE INDEX report_items_route_key ON driver_daily_report_items (route_id)
  WHERE route_id IS NOT NULL;
CREATE UNIQUE INDEX report_items_waybill_key ON driver_daily_report_items (waybill_id, report_date)
  WHERE waybill_id IS NOT NULL;

-- Точка цепочки одна на машину, день и позицию смены. ОГРАНИЧЕНИЕМ, а не индексом: перестановка
-- позиций меняет несколько строк сразу, и на время транзакции проверка откладывается — иначе
-- обычная перестановка «1 ↔ 2» падала бы на первой же строке.
ALTER TABLE driver_daily_report_items
  ADD CONSTRAINT report_items_chain_key UNIQUE (vehicle_id, report_date, shift_order)
  DEFERRABLE INITIALLY IMMEDIATE;
-- Цель составного ключа из показаний: копии снимка не должны расходиться.
ALTER TABLE driver_daily_report_items
  ADD CONSTRAINT report_items_snapshot_unique
  UNIQUE (id, report_id, vehicle_id, report_date, shift_order);
-- Цель ключа из журнала решений: решение отчёта A не ссылается на строку отчёта B.
ALTER TABLE driver_daily_report_items
  ADD CONSTRAINT report_items_report_unique UNIQUE (id, report_id);
CREATE INDEX report_items_report_idx ON driver_daily_report_items (report_id);

-- ── Показания ──
--
-- Хранится СНИМОК СЧЁТЧИКА, а не работа за смену: водитель списывает цифру с прибора, а не
-- вычитает, и вычитание на его стороне — это ошибки, которых потом никто не восстановит. Пробег и
-- наработка считаются разностями соседних снимков и живут в гараже, а не в таблице.
CREATE TABLE vehicle_readings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES driver_daily_report_items(id) ON DELETE CASCADE,
  -- Копии снимка: по ним идут цепочка и индексы. Составной ключ ниже не даёт им разойтись.
  report_id    uuid NOT NULL,
  vehicle_id   uuid NOT NULL,
  report_date  date NOT NULL,
  shift_order  smallint NOT NULL,
  kind         reading_kind NOT NULL,
  odometer_km        integer,
  engine_hours       numeric(9,1),
  -- ЗАПРАВЛЕНО за смену, не остаток в баке. Ноль здесь значим («не заправлялись») и отличается от
  -- незаполненного — поэтому колонка NULL-абельная, а не с умолчанием. Расхода по одному этому
  -- полю не бывает: фактический требует остатков, а показатель гаража честно зовётся
  -- «заправлено на 100 км».
  fuel_filled_liters numeric(7,1),
  no_data_reason text NOT NULL DEFAULT '',
  comment        text NOT NULL DEFAULT '',
  -- Две независимые цепочки: строка с одними моточасами не разрывает ряд одометра, и у каждого
  -- счётчика свой предшественник — тот, у кого этот счётчик заполнен.
  previous_odometer_id     uuid,
  previous_engine_hours_id uuid,
  odometer_anomaly              reading_anomaly,
  odometer_anomaly_confirmed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  odometer_anomaly_confirmed_at timestamptz,
  engine_hours_anomaly              reading_anomaly,
  engine_hours_anomaly_confirmed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  engine_hours_anomaly_confirmed_at timestamptz,
  source       reading_source NOT NULL,
  -- Когда нажали кнопку. Служебное: порядок цепочки задаёт `shift_order`, а не этот момент, —
  -- показания сдают вечером или через три дня, и время отправки о порядке смен не говорит ничего.
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  version      integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_readings_values_check CHECK (
    (kind = 'values' AND no_data_reason = ''
      AND (odometer_km IS NOT NULL OR engine_hours IS NOT NULL OR fuel_filled_liters IS NOT NULL))
    OR (kind = 'no_data' AND odometer_km IS NULL AND engine_hours IS NULL
      AND fuel_filled_liters IS NULL AND btrim(no_data_reason) <> '')
  ),
  CONSTRAINT vehicle_readings_non_negative_check CHECK (
    (odometer_km IS NULL OR odometer_km >= 0)
    AND (engine_hours IS NULL OR engine_hours >= 0)
    AND (fuel_filled_liters IS NULL OR fuel_filled_liters >= 0)
  ),
  -- Подтверждение бывает только у проставленной аномалии, а «кто» без «когда» подписью не
  -- является — тот же приём, что у визы заявки и подписи смены.
  CONSTRAINT vehicle_readings_odometer_anomaly_check CHECK (
    (odometer_anomaly_confirmed_by IS NULL) = (odometer_anomaly_confirmed_at IS NULL)
    AND (odometer_anomaly IS NOT NULL OR odometer_anomaly_confirmed_at IS NULL)
  ),
  CONSTRAINT vehicle_readings_engine_hours_anomaly_check CHECK (
    (engine_hours_anomaly_confirmed_by IS NULL) = (engine_hours_anomaly_confirmed_at IS NULL)
    AND (engine_hours_anomaly IS NOT NULL OR engine_hours_anomaly_confirmed_at IS NULL)
  ),
  -- Снимок один на двоих: подменить машину, отчёт, день или позицию в обход строки ожидания
  -- нельзя, а исправленный порядок смены уезжает в показание сам.
  CONSTRAINT vehicle_readings_snapshot_fk
    FOREIGN KEY (item_id, report_id, vehicle_id, report_date, shift_order)
    REFERENCES driver_daily_report_items (id, report_id, vehicle_id, report_date, shift_order)
    ON UPDATE CASCADE,
  CONSTRAINT vehicle_readings_previous_odometer_fk
    FOREIGN KEY (previous_odometer_id) REFERENCES vehicle_readings(id) ON DELETE SET NULL,
  CONSTRAINT vehicle_readings_previous_engine_hours_fk
    FOREIGN KEY (previous_engine_hours_id) REFERENCES vehicle_readings(id) ON DELETE SET NULL
);

-- Одна строка показаний на одну строку ожидания.
CREATE UNIQUE INDEX vehicle_readings_item_key ON vehicle_readings (item_id);
-- По этому индексу строится цепочка машины и ищется предшественник каждого счётчика.
CREATE INDEX vehicle_readings_chain_idx
  ON vehicle_readings (vehicle_id, report_date DESC, shift_order DESC);
CREATE INDEX vehicle_readings_report_idx ON vehicle_readings (report_id);

-- Файлы показания: фото приборной панели, чеки. Как во всех модулях (ADR 0024) — файл живёт
-- максимум в одном месте, кросс-модульную часть держит общий файловый сервис.
CREATE TABLE vehicle_reading_files (
  reading_id uuid NOT NULL REFERENCES vehicle_readings(id) ON DELETE CASCADE,
  file_id    uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reading_id, file_id)
);
CREATE UNIQUE INDEX vehicle_reading_files_file_unique ON vehicle_reading_files (file_id);

-- ── Журнал решений по расхождениям ──
--
-- Хранятся не расхождения, а РЕШЕНИЯ по ним: само расхождение вычисляется сравнением снимка с
-- живым источником, и материализовать его значило бы держать в согласии две правды.
--
-- Таблица append-only, уникальности здесь нет вовсе. Диспетчер вправе передумать и на неизменном
-- расхождении — сегодня признать допустимым, завтра отменить и добавить источник, — и все записи
-- должны остаться. Действует ПОСЛЕДНЕЕ решение по предмету, а «последнее» считается по
-- `report_version_after`: всякая запись берёт отчёт `FOR UPDATE` и двигает его версию, поэтому
-- порядок причинный. `now()` для этого негодна — это время начала транзакции, и две записи,
-- начатые одновременно, получили бы одну метку.
CREATE TABLE driver_report_discrepancy_resolutions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES driver_daily_reports(id) ON DELETE CASCADE,
  kind        discrepancy_kind NOT NULL,
  -- Предмет: строка ожидания либо (у `missing_source`) сам источник, строки у которого нет.
  -- Ссылка ИСТОРИЧЕСКАЯ: после переноса строки в другой отчёт она законно расходится с текущей
  -- принадлежностью — решение остаётся там, где его приняли, и перестаёт действовать само.
  item_id     uuid REFERENCES driver_daily_report_items(id) ON DELETE CASCADE,
  route_id    uuid REFERENCES vehicle_routes(id) ON DELETE RESTRICT,
  waybill_id  uuid REFERENCES waybills(id) ON DELETE RESTRICT,
  -- `v1:<hash>` — с версией алгоритма: канонизацию полей однажды придётся поменять, и без версии
  -- это молча обесценило бы все прежние решения.
  fingerprint text NOT NULL,
  resolution  discrepancy_resolution NOT NULL,
  reason      text NOT NULL,
  report_version_after integer NOT NULL,
  resolved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT discrepancy_resolutions_subject_check CHECK (
    (kind = 'missing_source') = (item_id IS NULL)
    AND (kind = 'missing_source' OR (route_id IS NULL AND waybill_id IS NULL))
    AND (kind <> 'missing_source' OR ((route_id IS NULL) <> (waybill_id IS NULL)))
  ),
  CONSTRAINT discrepancy_resolutions_resolution_check CHECK (
    (resolution <> 'source_added' OR kind = 'missing_source')
    AND btrim(reason) <> '' AND report_version_after > 0
  )
);

CREATE INDEX discrepancy_resolutions_item_idx
  ON driver_report_discrepancy_resolutions (report_id, kind, item_id, report_version_after DESC)
  WHERE item_id IS NOT NULL;
-- У `missing_source` предмет — сам источник, и NULL в общем ключе не работает: в PostgreSQL два
-- NULL различны, поэтому индексы раздельные, по одному на вид источника.
CREATE INDEX discrepancy_resolutions_route_idx
  ON driver_report_discrepancy_resolutions (report_id, route_id, report_version_after DESC)
  WHERE item_id IS NULL AND route_id IS NOT NULL;
CREATE INDEX discrepancy_resolutions_waybill_idx
  ON driver_report_discrepancy_resolutions (report_id, waybill_id, report_version_after DESC)
  WHERE item_id IS NULL AND waybill_id IS NOT NULL;

-- ── Истории ──
--
-- Две, по числу сущностей: приём относится к отчёту, а правка числа — к показанию, и событию
-- приёмки в истории строки места нет. Обе пишутся ТОЙ ЖЕ транзакцией, что и правка.
CREATE TABLE driver_daily_report_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  uuid NOT NULL REFERENCES driver_daily_reports(id) ON DELETE CASCADE,
  event      report_event NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason     text NOT NULL DEFAULT '',
  -- Обе версии: содержательная отвечает «что изменилось в числах», версия отчёта — «в каком
  -- порядке шли события», включая неконтентные (приём, подтверждение аномалии, решение).
  content_version integer NOT NULL,
  report_version  integer NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_daily_report_history_idx ON driver_daily_report_history (report_id, changed_at);

CREATE TABLE vehicle_reading_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id uuid NOT NULL REFERENCES vehicle_readings(id) ON DELETE CASCADE,
  event      reading_event NOT NULL,
  before     jsonb NOT NULL DEFAULT '{}'::jsonb,
  after      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Обязательна при правке персоналом: чужое число меняют с объяснением.
  reason     text NOT NULL DEFAULT '',
  version    integer NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_reading_history_idx ON vehicle_reading_history (reading_id, changed_at);
