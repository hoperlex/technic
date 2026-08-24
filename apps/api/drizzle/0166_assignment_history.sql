-- История назначения заявки: временная шкала техники и машиниста
-- (план `docs/assignment-periods-plan.md`, §6; этап 2, волна 2.1, предметная миграция).
--
-- ЧТО ЗАВОДИТСЯ. Таблица изменений назначения — «с какого числа на заявке стоит эта машина и этот
-- машинист» — и три колонки готовности у самой заявки. Сегодня назначение хранится одним снимком
-- (`vehicle_request_assignments`), то есть отвечает только на «что стоит сейчас»: смена машины
-- посреди срока переписывает снимок, и прошлое становится неотличимо от настоящего. Эта таблица —
-- вторая шкала: строка появляется в день, с которого изменение действует, и прежние строки не
-- переписываются никогда.
--
-- КТО В НЕЁ ПИШЕТ И ЧИТАЕТ. Сегодня — никто, и это осознанно. Двери, dual-write и ленивый бэкфилл
-- приходят этапом 3; миграция уезжает в прод раньше кода, который её использует, чтобы выкат схемы
-- и выкат поведения были двумя разными событиями с разными окнами отката. Пустая таблица ничего не
-- стоит и ничего не ломает: прежняя сборка о ней не знает.
--
-- ПОЧЕМУ РАЗДЕЛЕНО НА ДВЕ МИГРАЦИИ (П4). Управляющий контур модуля — режимы записи и чтения,
-- поколения теневого сравнения, аттестации деплоя, журнал переходов — живёт в `0167`. Предметная
-- часть и управляющая выкатываются на разных этапах, и одна неделимая миграция связала бы их
-- намертво: откатить контур, оставив историю, стало бы невозможно.
--
-- ОБРАТИМОСТЬ. Миграция аддитивная: новая таблица, три новых колонки у `vehicle_requests` со
-- значениями по умолчанию и одно ограничение `NOT VALID`. Ни одна существующая строка не
-- переписывается, ни одно существующее ограничение не трогается. Протокол выката необратимых
-- миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.

CREATE TABLE vehicle_request_assignment_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE, как у прочих спутников заявки: строка истории без заявки не значит ничего, а
  -- обоснование правки живёт в журнале коррекций, который заявку переживает.
  request_id uuid NOT NULL REFERENCES vehicle_requests(id) ON DELETE CASCADE,
  -- Дата, С КОТОРОЙ изменение действует; конца у строки нет — его задаёт следующая строка той же
  -- шкалы либо конец срока работ. Хранить пару «с — по» значило бы держать два источника правды об
  -- одной границе и чинить их согласованность руками при каждой вставке в середину.
  effective_date date NOT NULL,
  -- Две независимые шкалы: машина меняется без машиниста, машинист — без машины (Р16).
  dimension text NOT NULL CHECK (dimension IN ('vehicle', 'driver')),
  -- RESTRICT: пока история заявки ссылается на машину и на человека, из справочника их не удалить.
  -- Ровно так же держит их назначение и снимок листа: «кем работали» обязано пережить вывод машины
  -- из парка и увольнение.
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  driver_person_id uuid REFERENCES persons(id) ON DELETE RESTRICT,
  -- Состояние шкалы машиниста (Р16): 'set' — назначен, 'cleared' — снят осознанно (арендный
  -- отрезок, бланк ведёт арендодатель), 'unknown' — история не знает (пишет только бэкфилл и
  -- производный остаток заполнения). «Не менялось» выражается ОТСУТСТВИЕМ строки, а не состоянием:
  -- иначе у одного факта появилось бы два представления.
  driver_state text CHECK (driver_state IN ('set', 'cleared', 'unknown')),
  -- Происхождение строки — не украшение журнала, а признак, по которому команды находят свои
  -- строки: отмена заполнения ищет группу по `known_fill`, решение хвоста — по `tail_resolution`.
  -- Тот же список выписан в контрактах (`ASSIGNMENT_CHANGE_ORIGINS`).
  origin text NOT NULL
    CHECK (origin IN ('assignment', 'reassignment', 'machinist_change', 'backfill',
                      'tail_resolution', 'known_fill', 'unknown_remainder')),
  -- Строки, рождённые ОДНИМ решением: vehicle-изменение и порождённые им driver-строки
  -- (`cleared` при уходе в аренду, названный якорем человек при возврате), решение хвоста целиком.
  -- Гашение всегда групповое: погасив одну строку, мы оставили бы её спутника, который оживёт при
  -- следующем продлении срока (В2). Умолчание — своя группа: одиночное изменение это группа из
  -- одного, и вставке не приходится знать про групповой ключ вовсе.
  change_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Операция журнала коррекций, породившая строку; NULL — обычная работа без бумаги задним числом.
  -- RESTRICT: обоснование правки бланка строгой отчётности не удаляется, пока на него ссылаются.
  correction_id uuid REFERENCES waybill_corrections(id) ON DELETE RESTRICT,
  -- NULL — строка написана не человеком, а бэкфиллом: у восстановленной по бумаге истории автора
  -- нет, и приписывать её запустившему скрипт значило бы называть автором решения того, кто его не
  -- принимал.
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Строка, которую эта заменила (Р3): ссылка обратная — прямую «старая → новая» нельзя записать
  -- ни в каком порядке, пока частичный UNIQUE держит одну актуальную строку на шкалу и дату.
  -- Инлайн-FK здесь нет: цель держит составной ключ ниже, а второй такой же проверкой ограничение
  -- только дублировалось бы.
  supersedes_change_id uuid,
  superseded_at timestamptz,
  superseded_by_user uuid REFERENCES users(id) ON DELETE RESTRICT,
  superseded_kind text CHECK (superseded_kind IN ('replaced', 'cancelled')),
  -- Состав строки задаётся шкалой целиком: у vehicle-изменения нет ни человека, ни состояния, у
  -- driver-изменения нет машины, а человек назван тогда и только тогда, когда состояние `set`.
  -- Четвёртое сочетание («не знаем, но человек назван») схема не принимает: именно оно превратило
  -- бы `unknown` из признания неполноты в мнение.
  CONSTRAINT vehicle_request_assignment_changes_value_check CHECK (
    (dimension = 'vehicle' AND vehicle_id IS NOT NULL AND driver_person_id IS NULL
      AND driver_state IS NULL)
    OR (dimension = 'driver' AND vehicle_id IS NULL AND driver_state IS NOT NULL
      AND (driver_state = 'set') = (driver_person_id IS NOT NULL))
  ),
  -- Все три колонки погашения идут вместе: строка либо актуальна, либо погашена, названа кем и как.
  CONSTRAINT vehicle_request_assignment_changes_supersede_check CHECK (
    (superseded_at IS NULL AND superseded_by_user IS NULL AND superseded_kind IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_by_user IS NOT NULL AND superseded_kind IS NOT NULL)
  ),
  -- Строка не заменяет саму себя: цикл длины один составной FK ниже не ловит — он смотрит только на
  -- существование цели, а цель существует.
  CONSTRAINT vehicle_request_assignment_changes_self_check
    CHECK (supersedes_change_id IS NULL OR supersedes_change_id <> id),
  -- `unknown` — признание неполноты, и завести его человеку нечем (Р19). Два законных источника:
  -- бэкфилл и производный остаток частичного заполнения (Ш4) — последний рождается сервером внутри
  -- коррекции, поэтому у него `correction_id` обязателен: иначе граница появилась бы без автора.
  CONSTRAINT vehicle_request_assignment_changes_unknown_check CHECK (
    driver_state <> 'unknown'
    OR (origin = 'backfill' AND correction_id IS NULL)
    OR (origin = 'unknown_remainder' AND correction_id IS NOT NULL)
  ),
  -- Обратное направление (Щ3): origin остатка не должен встречаться нигде, кроме `unknown`. Без
  -- него `set` или vehicle-строка могли бы надеть его и проскользнуть мимо ослабленного индекса
  -- группы ниже — то есть послабление ради заполнения стало бы дырой в счёте строк группы.
  CONSTRAINT vehicle_request_assignment_changes_remainder_check CHECK (
    origin <> 'unknown_remainder'
    OR (dimension = 'driver' AND driver_state = 'unknown' AND correction_id IS NOT NULL)
  ),
  -- Провенанс заполнения (Ю2): по составу строк группу заполнения не отличить от обычной
  -- исторической смены машиниста, и отмена «по составу» превратила бы известного человека обратно
  -- в `unknown` — молча и необратимо. Поэтому у заполнения свой origin, тоже с двусторонним CHECK.
  CONSTRAINT vehicle_request_assignment_changes_known_fill_check CHECK (
    origin <> 'known_fill'
    OR (dimension = 'driver' AND driver_state = 'set'
        AND driver_person_id IS NOT NULL AND correction_id IS NOT NULL)
  ),
  -- Цель составного FK ниже. Замена физически привязана к той же заявке, шкале и дате: без этих
  -- трёх колонок в ключе строка могла бы объявить заменённой чужую — соседней заявки или другой
  -- шкалы. Перенос даты выражается парой «cancel + set» (Р13), поэтому дата в ключе — ограничение
  -- модели, а не помеха ей.
  CONSTRAINT vehicle_request_assignment_changes_identity_unique
    UNIQUE (id, request_id, dimension, effective_date),
  CONSTRAINT vehicle_request_assignment_changes_supersedes_fk
    FOREIGN KEY (supersedes_change_id, request_id, dimension, effective_date)
    REFERENCES vehicle_request_assignment_changes (id, request_id, dimension, effective_date)
);

COMMENT ON TABLE vehicle_request_assignment_changes IS
  'История назначения заявки (docs/assignment-periods-plan.md §6): изменения шкал техники и '
  'машиниста с датой начала действия. Строки неизменяемы — правка гасит прежнюю и вставляет новую.';

-- Одна действующая строка на шкалу и дату. Это главный инвариант модели: свёртка на дату читает
-- «последнюю строку не позже даты», и две актуальные строки на одну дату дали бы два ответа на
-- вопрос, на который бумага отвечает однозначно.
CREATE UNIQUE INDEX vehicle_request_assignment_changes_actual_unique
  ON vehicle_request_assignment_changes (request_id, dimension, effective_date)
  WHERE superseded_at IS NULL;

-- Замена достаётся ровно одной наследнице: иначе цепочка правок ветвится и «что действует» теряется.
CREATE UNIQUE INDEX vehicle_request_assignment_changes_supersedes_unique
  ON vehicle_request_assignment_changes (supersedes_change_id)
  WHERE supersedes_change_id IS NOT NULL;

-- ОТДЕЛЬНОГО ИНДЕКСА `(request_id, effective_date)` ЗДЕСЬ НЕТ — решение волны 2.1, не недосмотр.
--
-- §6 плана оставил выбор открытым и потребовал записать причину. Нагрузочный спайк
-- (`docs/assignment-periods-spike.md`, §2) не нашёл разницы между этим индексом и его отсутствием
-- ни на 90 тысячах строк, ни на 390 тысячах: по `exec` 0,04 мс и 5–6 буферов в обоих случаях.
-- Замер повторён волной 2.1 на ЭТОЙ таблице, созданной этой же миграцией (240 092 строки, 8000
-- фоновых заявок, 116 MB с индексами, PostgreSQL 16.14, `scripts/assignment-history-spike.ts`), на
-- трёх запросах, которыми историю и будут читать, — вся история заявки, действующая история,
-- свёртка на дату (`EXPLAIN ANALYZE`, медиана 100 клиентских повторов):
--
--   с индексом:  exec 0,043 / 0,041 / 0,046 мс, 5 буферов; медиана 0,392 / 0,243 / 0,158 мс;
--   без него:    exec 0,039 / 0,043 / 0,033 мс, 5 буферов; медиана 0,265 / 0,155 / 0,130 мс —
--                Bitmap Index Scan по `_group_idx` и `_actual_unique`, оба ведут по `request_id`.
--
-- Разница в пределах шума и, если что, в пользу отсутствия. Читать лишний индекс не будут, а
-- писать — будут: он стоил бы четвёртой записи на каждой вставке истории, а вставки здесь идут
-- пачками (смена машиниста на многолетней заявке — это десятки строк в одной транзакции). Без
-- индексов по `request_id` вовсе все три запроса уходят в Seq Scan: exec 15,9 / 16,2 / 16,9 мс и
-- 4700 буферов — то есть индекс по заявке обязателен, и его дают `_actual_unique` и `_group_idx`
-- ниже; именно этот, четвёртый, — нет.
--
-- Условие пересмотра названо прямо: сортировка по `effective_date`, ради которой он был задуман,
-- начнёт стоить, когда история одной заявки перевалит за тысячи строк. Сегодня многолетняя заявка
-- держит 92 строки (§1 спайка), и сортировка 92 строк не видна на фоне круга до сокета.

-- Группа решения (Р31): её читают гашение при сокращении срока, отмена заполнения и решение
-- хвоста. Он же покрывает выборки по заявке — ведёт по `request_id` первой колонкой.
-- Принадлежность группы одной заявке проверяет сервис: цели для составного FK у группы нет.
CREATE INDEX vehicle_request_assignment_changes_group_idx
  ON vehicle_request_assignment_changes (request_id, change_group_id);

-- Одна актуальная строка на шкалу внутри группы — это и есть «группа рождена одним решением».
-- Исключение для заполнения `unknown` (Щ1): его группа — ДВЕ driver-строки, `set` на начале
-- отрезка и граница `unknown` за его концом, и вторая вставка получила бы unique violation.
-- Послабление узкое, по `origin`: для решения хвоста и всех прочих групп строгость сохраняется
-- дословно, а сам `origin` остатка заперт двусторонним CHECK выше.
-- Заявка в ключе (найдено волной 3.1): без неё индекс глобален, и «одна строка на шкалу в группе»
-- означало бы «во всём портале», а не «в этой заявке». Практически коллизия uuid недостижима, но
-- инвариант должен читаться как написан: группа принадлежит заявке, и ограничение — тоже.
CREATE UNIQUE INDEX vehicle_request_assignment_changes_group_dimension_unique
  ON vehicle_request_assignment_changes (request_id, change_group_id, dimension)
  WHERE superseded_at IS NULL AND origin <> 'unknown_remainder';

-- Исключённые строки не должны остаться вовсе без счёта (Э3): остаток нормативно один на группу.
-- Алгоритму это не мешает — отмена гасит прежнюю границу до вставки новой.
CREATE UNIQUE INDEX vehicle_request_assignment_changes_group_remainder_unique
  ON vehicle_request_assignment_changes (request_id, change_group_id)
  WHERE superseded_at IS NULL AND origin = 'unknown_remainder';

-- ── Готовность истории у заявки (Р20, З1, К4) ──
--
-- Три состояния, а не флаг (Р26): `materialized` означает «строки есть, но валидности нет», и
-- ленивый пересчёт в нём ничего не пересобирает. Предикат cutover читает именно эту колонку.
-- `assignment_history_dirty` — метка загрязнения внутри дня (К4): её ставят все четыре ручки смен
-- и `on_demand`, потому что они меняют отменяемость бумаги, а `validated_on` при этом остаётся
-- сегодняшним и ленивое правило устаревания молчит.
ALTER TABLE vehicle_requests
  ADD COLUMN assignment_history_state text NOT NULL DEFAULT 'empty'
    CHECK (assignment_history_state IN ('empty', 'materialized', 'ready')),
  -- День, на который состояние считалось. Это не `asOf` запроса: календарь двигает валидность сам,
  -- без всякой двери, и «посчитано сегодня» — единственное, что делает состояние пригодным для
  -- решения о бумаге (З1).
  ADD COLUMN assignment_history_validated_on date,
  ADD COLUMN assignment_history_dirty boolean NOT NULL DEFAULT false;

-- `empty` тогда и только тогда, когда дня расчёта нет. NOT VALID — по Р2: файл миграции идёт одной
-- транзакцией, а проверка нового ограничения делает полный скан `vehicle_requests` под
-- ACCESS EXCLUSIVE, то есть останавливает портал на время скана. Существующие строки условию
-- удовлетворяют по построению (`empty` + NULL), но `VALIDATE CONSTRAINT` всё равно выносится
-- отдельной миграцией: он берёт лишь SHARE UPDATE EXCLUSIVE и не мешает работе.
ALTER TABLE vehicle_requests
  ADD CONSTRAINT vehicle_requests_history_state_check
  CHECK ((assignment_history_state = 'empty') = (assignment_history_validated_on IS NULL))
  NOT VALID;

-- ── Журнал коррекций: два новых вида и снимок авторизации (Р9, Р32) ──
--
-- Действующий CHECK знает семь видов, и первая же вставка `crew` была бы отвергнута базой — а
-- контракты этапа 1 (`ASSIGNMENT_OPERATION_OUTCOMES`) их уже отдают. Без этого блока двери этапа 3
-- не поедут вовсе.
alter table waybill_corrections
  add column authorization_scope jsonb;

alter table waybill_corrections
  drop constraint waybill_corrections_kind_check;

alter table waybill_corrections
  add constraint waybill_corrections_kind_check
  check (kind in ('route', 'transfer', 'esm2', 'cancel', 'issue',
                  'request_date', 'weekly', 'crew', 'assignment_tail'));

-- Снимок обязателен только у новых видов: старые авторизуются на повторе прежним, своим для
-- каждого входа путём, и переписывать их миграция не должна. Новый вид без снимка — внутренняя
-- ошибка, а не повод пересчитать права по текущему состоянию: пересчёт и есть та дыра, ради
-- которой снимок заведён.
alter table waybill_corrections
  add constraint waybill_corrections_authorization_scope_check
  check (kind not in ('crew', 'assignment_tail') or authorization_scope is not null);
