-- Недельная заявка на технику: ADR 0085, план `docs/weekly-vehicle-request-plan.md`.
--
-- Площадка заказывает технику не по одной машине, а неделями: в конце недели штаб объекта решает,
-- что из стоящей на площадке техники остаётся, что уезжает и что нужно добавить. Третьим значением
-- `vehicle_request_type` это не выражается (Р1): заявка ТС физически одномашинная
-- (`vehicle_request_assignments` — одна строка на заявку), ЭСМ-2 привязан к паре «заявка + неделя»
-- (`UNIQUE (source_request_id, period_from)`, ADR 0060), срок у каждой единицы свой, а досрочное
-- завершение согласуется по машине. Поэтому недельная заявка — **документ-основание над заказами
-- ТС**, а не заказ: её виза порождает и продлевает обычные заказы, и дальше всё работает как
-- раньше.
--
-- Единица — будущая календарная неделя пн–вс (Р2). Хранится один ключ, `week_start`; конец недели
-- вычисляется прибавлением шести дней и в базе не лежит — две колонки на одно значение рано или
-- поздно разойдутся. Понятие недели — то же самое, которым режет свои периоды ЭСМ-2
-- (`weekStartKey` в контрактах): второго понятия недели в портале быть не должно.

CREATE TYPE weekly_request_status AS ENUM ('draft', 'pending', 'applied', 'cancelled');
-- Три вида строки (Р5): «остаётся» (продление заказа), «нужна дополнительно» (позиция
-- классификатора без машины — её подберёт диспетчер) и «уезжает». Третий вид заведён потому, что
-- решение об отъезде — часть недельного документа (Р10): снятая галка не «отсутствие строки», и
-- пустой состав из-за снятых галок не должен читаться как «решения не было».
CREATE TYPE weekly_request_item_kind AS ENUM ('extend', 'new', 'leave');
CREATE TYPE weekly_request_item_result AS ENUM (
  'pending', 'extended', 'created', 'left', 'skipped'
);

CREATE TABLE weekly_vehicle_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Свой сквозной номер (Р20), на экране — «НЗ-12»: на пакет ссылаются («продлено по НЗ-12» в
  -- истории заказа, «НЗ-12 ждёт визы» в списке руководителя), а номер заказа этого не называет.
  num integer GENERATED ALWAYS AS IDENTITY,
  object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE RESTRICT,
  week_start date NOT NULL,
  status weekly_request_status NOT NULL DEFAULT 'draft',
  comment text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  approved_at timestamptz,
  applied_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '',
  -- Токен оптимистичной блокировки: состав недели правят несколько человек, а виза применяет
  -- ровно тот состав, который видел визирующий (Р6).
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Неделя начинается с понедельника — иначе `week_start + 6` перестаёт быть неделей, а границы
  -- дат строки (ниже) проверяли бы произвольный семидневный отрезок.
  CONSTRAINT weekly_requests_week_monday_check
    CHECK (extract(isodow from week_start) = 1),
  CONSTRAINT weekly_requests_approval_pair_check
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- Виза и применение — одно событие (Р6), поэтому инвариант жизненного цикла записывается двумя
  -- равенствами, а не тремя «или»: завизированная — это ровно применённая. Промежуточное «pending
  -- с визой» физически невозможно: отдельного действия «применить» нет, потому что оно создавало
  -- бы состояние «завизировано, но ничего не произошло».
  CONSTRAINT weekly_requests_applied_check
    CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CONSTRAINT weekly_requests_approved_status_check
    CHECK ((status = 'applied') = (approved_by IS NOT NULL)),
  CONSTRAINT weekly_requests_cancel_check
    CHECK (status <> 'cancelled' OR btrim(cancel_reason) <> ''),
  -- Цель составного FK из строк: неделя строки физически не может разойтись с неделей шапки.
  -- Приём в проекте не новый: так же `vehicle_requests` держит `unique (id, vehicle_type_id)` ради
  -- составного FK назначения.
  CONSTRAINT weekly_requests_id_week_unique UNIQUE (id, week_start)
);

-- Одна недельная заявка на пару «объект + неделя» (Р3): две заявки означали бы два состава,
-- которые при согласовании подерутся за один и тот же заказ. Отменённые из ограничения выпадают —
-- снятую заявку заводят заново.
CREATE UNIQUE INDEX weekly_requests_object_week_uniq
  ON weekly_vehicle_requests (object_id, week_start)
  WHERE status <> 'cancelled';
CREATE UNIQUE INDEX weekly_requests_num_uniq ON weekly_vehicle_requests (num);
-- «Что ждёт визы» — единственный вопрос очереди руководителя: в неё попадает только `pending`,
-- черновик виден, но не отвлекает (§10).
CREATE INDEX weekly_requests_pending_idx ON weekly_vehicle_requests (week_start, object_id)
  WHERE status = 'pending';

CREATE TABLE weekly_vehicle_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ссылка на шапку — только составным ключом ниже: одиночный FK к тому же родителю дублировал бы
  -- его и требовал бы держать два каскада согласованными.
  weekly_request_id uuid NOT NULL,
  -- Денормализованная неделя шапки: только она даёт проверить границы дат строки внутри CHECK.
  week_start date NOT NULL,
  position integer NOT NULL,
  kind weekly_request_item_kind NOT NULL,

  -- Заказ-основание у строк `extend` и `leave`. RESTRICT — см. примечание об уборке при `purge`
  -- в конце файла.
  source_request_id uuid REFERENCES vehicle_requests (id) ON DELETE RESTRICT,
  -- Позиция классификатора у строки `new` (ADR 0028): тип и, если у типа есть категории,
  -- категория. Конкретную машину строка не называет — её подбирает диспетчер при переводе в
  -- работу: площадка не видит парка и не знает занятости (Р5).
  vehicle_type_id uuid REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  vehicle_category_id uuid,

  date_from date,
  date_to date,
  responsible_name text NOT NULL DEFAULT '',
  responsible_phone text NOT NULL DEFAULT '',
  delivery_needed boolean NOT NULL DEFAULT false,
  delivery_from text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',

  -- Что видел составитель при подаче: эффективный конец срока заказа (Р14). Им сверяется
  -- применимость строки, и он же объясняет отказ словами «было 11.08, стало 15.08».
  expected_date_to date,
  -- Снимок момента применения (Р14). Разведён с ожиданием намеренно: одно поле под обе задачи не
  -- работает — ожидание и снимок расходятся ровно тогда, когда это важнее всего.
  previous_date_to date,
  applied_source_version integer,
  snapshot_vehicle_id uuid REFERENCES vehicles (id) ON DELETE RESTRICT,
  -- Номер порождённого заказа рядом не хранится: пара «идентификатор + номер» проверяема на
  -- полноту, но не на принадлежность одному заказу — CHECK пропустил бы ID одного и номер другого.
  -- Составной FK ради этого потребовал бы нового `unique (id, num)` в `vehicle_requests`, а номер и
  -- так приходит join'ом: карточка всё равно читает статус и машину порождённого заказа.
  created_request_id uuid REFERENCES vehicle_requests (id) ON DELETE RESTRICT,

  result weekly_request_item_result NOT NULL DEFAULT 'pending',
  skip_reason text NOT NULL DEFAULT '',
  -- Явное согласие снять ожидающий досрочный отъезд (Р15). Обычная правка срока снимает такой
  -- запрос молча, и там это безопасно — правит один заказ один человек, глядя на него. В недельной
  -- заявке состав предвыбран целиком, и молчаливое снятие десятка запросов означало бы отмену
  -- чужих решений оптом.
  early_end_override boolean NOT NULL DEFAULT false,

  CONSTRAINT weekly_items_week_fk
    FOREIGN KEY (weekly_request_id, week_start)
    REFERENCES weekly_vehicle_requests (id, week_start) ON DELETE CASCADE,

  -- Форма строки задана её видом целиком: у продления есть заказ и дата, по которую продлить, у
  -- новой — позиция классификатора и срок, у отъезда — только заказ.
  CONSTRAINT weekly_items_kind_shape_check CHECK (
    (kind = 'extend' AND source_request_id IS NOT NULL AND vehicle_type_id IS NULL
       AND vehicle_category_id IS NULL AND date_from IS NULL AND date_to IS NOT NULL
       AND expected_date_to IS NOT NULL)
    OR (kind = 'new' AND source_request_id IS NULL AND vehicle_type_id IS NOT NULL
       AND date_from IS NOT NULL AND date_to IS NOT NULL AND date_from <= date_to
       AND expected_date_to IS NULL)
    OR (kind = 'leave' AND source_request_id IS NOT NULL AND vehicle_type_id IS NULL
       AND vehicle_category_id IS NULL AND date_from IS NULL AND date_to IS NULL
       AND expected_date_to IS NOT NULL)
  ),
  -- Поля, значимые только у своего вида строки: контакт и доставка — принадлежность `new`,
  -- согласие на снятие досрочного отъезда — принадлежность `extend`. Без этих проверок в базе
  -- заводится строка «уезжает с запрошенной доставкой», которую никто не собирался разрешать.
  CONSTRAINT weekly_items_new_fields_check CHECK (
    kind = 'new'
    OR (btrim(responsible_name) = '' AND responsible_phone = ''
        AND NOT delivery_needed AND btrim(delivery_from) = '')
  ),
  CONSTRAINT weekly_items_override_kind_check
    CHECK (kind = 'extend' OR NOT early_end_override),
  -- Границы недели: строка не выходит за пн–вс своей заявки.
  CONSTRAINT weekly_items_week_bounds_check CHECK (
    (date_from IS NULL OR (date_from >= week_start AND date_from <= week_start + 6))
    AND (date_to IS NULL OR (date_to >= week_start AND date_to <= week_start + 6))
  ),
  -- Результат согласован с видом строки и с тем, что после него обязано быть заполнено.
  CONSTRAINT weekly_items_result_kind_check CHECK (
    result = 'pending'
    OR (kind = 'extend' AND result IN ('extended', 'skipped'))
    OR (kind = 'new' AND result IN ('created', 'skipped'))
    OR (kind = 'leave' AND result IN ('left', 'skipped'))
  ),
  -- Развилка, а не равенство: порождённый заказ есть ровно у применённой строки `new`, и у любой
  -- другой его быть не может — ссылка на чужой заказ читалась бы как «этот заказ создан неделей».
  CONSTRAINT weekly_items_created_check CHECK (
    (result = 'created' AND kind = 'new' AND created_request_id IS NOT NULL)
    OR (result <> 'created' AND created_request_id IS NULL)
  ),
  -- Снимок обязателен у обеих строк, ссылающихся на заказ: «уезжает» — такое же согласованное
  -- решение, и через месяц вопрос к нему тот же — какая машина и до какого числа стояла. Развилка
  -- симметричная по той же причине: полуснимок у `pending` или `skipped` — это мусор, который
  -- однажды прочитают как факт.
  CONSTRAINT weekly_items_source_snapshot_check CHECK (
    (result IN ('extended', 'left')
      AND previous_date_to IS NOT NULL AND applied_source_version IS NOT NULL
      AND snapshot_vehicle_id IS NOT NULL)
    OR (result NOT IN ('extended', 'left')
      AND previous_date_to IS NULL AND applied_source_version IS NULL
      AND snapshot_vehicle_id IS NULL)
  ),
  CONSTRAINT weekly_items_skip_check
    CHECK (result <> 'skipped' OR btrim(skip_reason) <> ''),
  CONSTRAINT weekly_items_position_check CHECK (position >= 0),
  -- Контакт встречающего у новой строки обязателен, как в обычной заявке; телефон — десять цифр
  -- без кода страны (ADR 0066), тем же шаблоном, что и во всём портале.
  CONSTRAINT weekly_items_contact_check CHECK (
    kind <> 'new' OR (btrim(responsible_name) <> '' AND responsible_phone ~ '^[0-9]{10}$')
  ),
  CONSTRAINT weekly_items_delivery_from_check
    CHECK (NOT delivery_needed OR btrim(delivery_from) <> ''),
  -- Категория чужого типа невозможна физически (ADR 0028) — тем же приёмом, что и у заявки ТС.
  -- MATCH SIMPLE: у строк без категории ключ не проверяется.
  CONSTRAINT weekly_items_category_type_fk
    FOREIGN KEY (vehicle_category_id, vehicle_type_id)
    REFERENCES vehicle_categories (id, vehicle_type_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX weekly_items_position_uniq
  ON weekly_vehicle_request_items (weekly_request_id, position);
-- Один заказ — одна строка в неделе: два решения об одной машине на одну неделю противоречивы по
-- определению. Между разными неделями запрета нет (§8) — планировать через неделю нормально.
CREATE UNIQUE INDEX weekly_items_source_uniq
  ON weekly_vehicle_request_items (weekly_request_id, source_request_id)
  WHERE source_request_id IS NOT NULL;
-- Порождённый заказ имеет ровно одно основание (Р16): «Создан по НЗ-12» — одна ссылка, а
-- «Продления: НЗ-15, НЗ-18» — список, и он идёт по `source_request_id`.
CREATE UNIQUE INDEX weekly_items_created_uniq
  ON weekly_vehicle_request_items (created_request_id)
  WHERE created_request_id IS NOT NULL;
CREATE INDEX weekly_items_source_idx ON weekly_vehicle_request_items (source_request_id);

-- История заявки: и статусы, и изменения состава — одной транзакционной таблицей (Р17). Узкой
-- «истории статусов» не хватает: состав правится и без перехода (в том числе не человеком —
-- уборкой при `purge`), а `writeAudit` такую запись может потерять, потому что намеренно не
-- роняет операцию при сбое (`apps/api/src/lib/audit.ts`). Событие «строка снята: заказ ТС-341
-- удалён насовсем» обязано пережить сбой записи аудита, иначе состав документа изменится молча.
CREATE TYPE weekly_request_event AS ENUM ('status', 'items_changed', 'item_dropped');

CREATE TABLE weekly_vehicle_request_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_request_id uuid NOT NULL REFERENCES weekly_vehicle_requests (id) ON DELETE CASCADE,
  event weekly_request_event NOT NULL,
  from_status weekly_request_status,
  to_status weekly_request_status,
  -- Что именно изменилось: снятые строки с номерами заказов, состав до и после.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Событий без автора здесь не бывает: состав меняет человек, и уборку при `purge` тоже делает
  -- администратор осознанным действием.
  changed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  comment text NOT NULL DEFAULT '',
  -- Развилка полная: равенство по `to_status` оставляло бы у не-статусного события заполненный
  -- `from_status` — строку, которая читается как несостоявшийся переход.
  CONSTRAINT weekly_history_status_check CHECK (
    (event = 'status' AND to_status IS NOT NULL)
    OR (event <> 'status' AND from_status IS NULL AND to_status IS NULL)
  )
);
CREATE INDEX weekly_history_request_idx
  ON weekly_vehicle_request_history (weekly_request_id, changed_at);

-- `ON DELETE RESTRICT` на `source_request_id`, `created_request_id`, тип, категорию и объект —
-- плюс уборка неприменённых строк при `purge` (ADR 0070, `records.purge`). Применённая заявка не
-- должна терять свои следствия, а `SET NULL` именно это и сделал бы; голый `RESTRICT` даёт
-- обратную беду — брошенный черновик держал бы заказ вечно, а своего `purge` у недельной заявки
-- нет. Политика: намерение уступает, факт держит. `purge` заказа убирает строки `extend`/`leave`
-- неприменённых заявок, `purge` типа или категории — строки `new`, `purge` объекта — неприменённые
-- заявки целиком; применённые заявки держат `RESTRICT` во всех трёх случаях и объясняются словами
-- (`REFERENCING_TABLE_LABELS` в `services/directory-purge.ts`).
--
-- Архива у заявки нет: до применения она снимается отменой, после — удалять её нельзя.
