-- Распознавание талонов вывоза и сверка с заявкой: хранилище
-- (план `docs/waste-ticket-ocr-plan.md` §7 «Данные и проверки», решения Р10–Р22, Р29, Р31;
-- обоснования и отвергнутые варианты — [ADR 0114](../../../docs/adr/0114-waste-ticket-recognition.md)).
--
-- ЗАЧЕМ. Сегодня талон — это файл и больше ничего: скан висит строкой `request_files`
-- с `kind = 'ticket'` (ADR 0024), и портал не знает о нём ни номера, ни объёма, ни даты. Три
-- вопроса, ради которых бумагу вообще собирают, — «не предъявлялся ли этот лист раньше»,
-- «сходится ли объём», «сходится ли дата» — задать некому. Эта миграция заводит место, куда
-- ложится прочитанное, и правила, без которых прочитанное нельзя считать проверкой.
--
-- ЧТО ЗАВОДИТСЯ, СВЕРХУ ВНИЗ:
--
--   waste_ticket_files ................. обработка ФАЙЛА: где живёт «отвергнут» (Р10);
--   waste_ticket_pages ................. страница файла и хэш её РАСТРА — единица распознавания;
--   waste_ticket_recognition_attempts .. вызов модели; принадлежит содержимому, а не заявке (Р12);
--   waste_tickets ...................... сам талон: предложение до подтверждения человеком (Р15);
--   waste_ticket_proposals ............. результат перераспознавания, не переписавший человека (Р13);
--   waste_ticket_blind_checks .......... слепая перепроверка и арбитраж (Р31);
--   waste_ticket_check_resolutions ..... принятое расхождение с отпечатком входа (Р21);
--   + две колонки факта закрытия: дата вывоза и честное «неизвестно» у истории (Р19).
--
-- ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
--
--   · ЗАМЕЧАНИЯ НЕ МАТЕРИАЛИЗУЮТСЯ. «Объём не сходится» считается функцией от (заявка, факт,
--     талоны) в `services/waste-ticket-checks.ts`. Таблица замечаний разошлась бы с талонами на
--     первой же правке, и разошлась бы молча. Материализуется только РЕШЕНИЕ человека — принятие
--     расхождения, и оно хранится с отпечатком входа (Р21), чтобы перестать действовать само,
--     когда вход изменился.
--
--   · `file_is_linked(uuid)` НЕ ТРОГАЕТСЯ (`apps/api/src/services/request-files.ts`). Функция
--     отвечает на вопрос «файл к чему-нибудь привязан, удалять его нельзя»; привязка талона как
--     была, так и остаётся строкой `request_files`. Файловая строка и страницы — СПУТНИКИ файла,
--     а не вторая связь: они появляются после привязки и уходят вместе с ней (составной внешний
--     ключ ниже). Добавить их в `file_is_linked` значило бы завести второй ответ на тот же
--     вопрос — и первый же расклеившийся случай (строка есть, привязки нет) запер бы файл
--     навсегда, потому что удалять его стало бы некому.
--
--   · BACKFILL ДАТЫ ВЫВОЗА НЕ ВЫПОЛНЯЕТСЯ (Р19) — объяснено на своём месте, в разделе 8.
--
-- СОСТАВНЫЕ ВНЕШНИЕ КЛЮЧИ ПРОТИВ РАССИНХРОНА ЗАЯВОК. Заявка у файловой строки, страницы и талона
-- хранится своей колонкой — иначе каждый отбор «талоны заявки» шёл бы тремя джойнами. Цена такого
-- хранения известна: три копии одного факта расходятся. Поэтому пара `(request_id, file_id)`
-- файловой строки ссылается на `request_files (request_id, file_id)`, страница — на файловую
-- строку той же парой, талон — на страницу парой `(request_id, page_id)`. Ссылаться есть на что
-- только при поддерживающих ограничениях, отсюда `UNIQUE (request_id, file_id)` у файловой строки
-- и `UNIQUE (request_id, id)` у страницы — они выглядят избыточно рядом с первичными ключами, но
-- существуют ровно ради этих ключей. Без них схема допускает страницу, которая сослалась на файл
-- одной заявки, а `request_id` несёт другой, и талон на странице чужой заявки: ошибка кода
-- превращалась бы в тихо неверную сверку — то есть ровно в то, от чего весь модуль и заводится.
--
-- ОБРАТИМОСТЬ. Миграция аддитивная: семь новых таблиц и две новые колонки со значением по
-- умолчанию у существующей. Ни одна строка не читается и не переписывается, смысл заведённых
-- данных не меняется, `removed_on_source = 'unknown'` у истории — это правда, а не заглушка.
-- Протокол выката необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.
--
-- ТРЕБОВАНИЕ К ВЕРСИИ POSTGRES: 15+, из-за `ON DELETE SET NULL (page_id)` у талона (раздел 4).
-- У нас 16 (dev) и 17 (prod).

-- ── 1. Файл: обработка и её исход (Р10, Р29) ──
--
-- Файл отвечает за обработку, страница — за распознавание, и это не дробление ради дробления:
-- отвергнутый файл страниц не порождает вовсе, и пометить «это не изображение и не PDF» больше
-- негде. Без этой строки недоступное распознавание неотличимо от «талоны в порядке» — худшее,
-- чем может закончиться недоступность прокси (Р29).
CREATE TABLE waste_ticket_files (
  -- PK = FK: у файла ровно одна строка обработки. Отдельный `id` означал бы, что один и тот же
  -- скан можно обрабатывать дважды с разным исходом, и «какой из них показывать» стало бы
  -- вопросом. `CASCADE`: строка обработки без файла не значит ничего.
  file_id uuid PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
  -- Заявка хранится колонкой ради отборов; согласованность с привязкой держит составной ключ
  -- ниже. Прямая ссылка на заявку рядом с ним не лишняя: `request_files` — таблица связи, и
  -- каскад от заявки обязан доходить сюда независимо от того, какими путями удалили связь.
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  -- pending | done | unsupported | failed. `unsupported` отделён от `failed` намеренно: первое —
  -- приговор бумаге (повтор не поможет, нужен человек), второе — приговор попытке (повтор будет).
  -- Человеку это две разные фразы в интерфейсе, а воркеру — два разных решения о ретрае.
  status text NOT NULL,
  -- Причина человеческими словами: «это не изображение и не PDF», «в файле 6 страниц, обработано
  -- 5 (лимит)». Хранится готовой, потому что собрать её заново из кодов нельзя — часть подробностей
  -- известна только в момент обработки.
  reason text NOT NULL DEFAULT '',
  -- Дубль классификации ПОСЛЕДНЕЙ неуспешной попытки (Р29). Источник истины — попытки: за час их
  -- бывает несколько с разной природой, и доля ошибок для баннера считается по ним. Здесь она
  -- лежит затем, чтобы строка талона в списке показывала своё состояние без запроса по попыткам.
  error_class text NOT NULL DEFAULT '',
  error_scope text NOT NULL DEFAULT '',
  -- «В файле 6 страниц, обработано 5». Две колонки, а не одна: сверх лимита `TICKET_OCR_MAX_PAGES`
  -- страницы не теряются молча, а помечаются — разница между «всего» и «обработано» и есть то,
  -- что человек обязан увидеть.
  total_pages smallint NOT NULL DEFAULT 0,
  processed_pages smallint NOT NULL DEFAULT 0,
  -- По ней считается «попытка 3 из 5, следующая в 14:32»: очередь уже умеет и попытки, и паузу
  -- (`jobs`), и переспрашивать её дешевле, чем держать вторую копию счётчика здесь. `SET NULL`:
  -- задачу вычищают как отработавшую, и держать её ради надписи в интерфейсе незачем — надпись
  -- к этому времени уже неинтересна.
  active_job_id uuid REFERENCES jobs (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Поддерживает составной ключ страницы (см. шапку). Заодно ведущим `request_id` обслуживает
  -- каскад от заявки, поэтому отдельного индекса по ней нет.
  CONSTRAINT waste_ticket_files_request_file_unique UNIQUE (request_id, file_id),
  -- Привязка талона к заявке живёт в `request_files`, и обработка идёт следом за ней: откат
  -- заявки в «Новую» отвязывает файлы, и этим же движением обязано исчезнуть распознанное (Р22).
  -- Каскадом, а не уборкой в коде: отвязка идёт из маршрута статуса, который о распознавании
  -- знать не обязан.
  CONSTRAINT waste_ticket_files_link_fk FOREIGN KEY (request_id, file_id)
    REFERENCES request_files (request_id, file_id) ON DELETE CASCADE,
  CONSTRAINT waste_ticket_files_status_check
    CHECK (status IN ('pending', 'done', 'unsupported', 'failed')),
  -- Набор значений закрыт с обеих осей (Р29): опечатка в `error_scope` не сломала бы ничего
  -- видимого, но молча вывела бы строку из числителя health-метрики — то есть погасила бы
  -- баннер ровно тогда, когда он нужен. Пустая строка законна: у файла без сбоя классификации нет.
  CONSTRAINT waste_ticket_files_error_class_check
    CHECK (error_class IN ('', 'transient', 'terminal')),
  CONSTRAINT waste_ticket_files_error_scope_check
    CHECK (error_scope IN ('', 'subsystem', 'item')),
  -- Отрицательных страниц не бывает, а «обработано больше, чем есть» — это не редкий случай, а
  -- рассинхрон счётчиков, который в интерфейсе выглядит законченной работой.
  CONSTRAINT waste_ticket_files_pages_check
    CHECK (total_pages >= 0 AND processed_pages >= 0 AND processed_pages <= total_pages)
);

COMMENT ON TABLE waste_ticket_files IS
  'Обработка файла-скана талонов (docs/waste-ticket-ocr-plan.md Р10): единственное место, где '
  'живёт «файл отвергнут» — у отвергнутого страниц не появляется вовсе.';

-- ── 2. Страница: единица распознавания (Р10) ──
--
-- Хэш считается по РАСТРУ СТРАНИЦЫ, а не по файлу, и это главное в таблице. Хэш всего PDF не
-- узнает страницу, вложенную в другой PDF, — а именно так выглядит повторное предъявление бумаги,
-- когда бухгалтерия сканирует пачкой: тот же лист приезжает вторым файлом с другим соседством.
-- Точный повтор виден до всякого чтения, даже когда номер не прочитался вовсе (Р17).
CREATE TABLE waste_ticket_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  page_no smallint NOT NULL,
  -- Хэш растра страницы после предобработки. `char(64)` — sha256 в шестнадцатеричном виде.
  page_sha256 char(64) NOT NULL,
  -- pending | done | failed. Страница провалилась — файл при этом мог обработаться: пять страниц
  -- из шести прочитаны, шестая не далась, и это состояние обязано быть выразимым.
  status text NOT NULL,
  -- Сколько талонов нашлось на странице. Треть снимков несёт по два талона (замер 18.08.2026),
  -- поэтому ноль здесь — законный ответ «страница есть, талонов на ней нет», а не ошибка.
  tickets_found smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_ticket_pages_file_fk FOREIGN KEY (request_id, file_id)
    REFERENCES waste_ticket_files (request_id, file_id) ON DELETE CASCADE,
  -- Номера страниц внутри файла не повторяются: вторая «страница 3» означала бы, что один и тот
  -- же лист разобран дважды, и сумма по талонам удвоилась бы сама собой.
  CONSTRAINT waste_ticket_pages_file_page_unique UNIQUE (file_id, page_no),
  -- Поддерживает составной ключ талона (см. шапку). Ведущим `request_id` он же обслуживает каскад
  -- от заявки, поэтому отдельного индекса по ней нет — вопреки букве плана, где он перечислен
  -- рядом; второй индекс по тому же префиксу стоил бы записей и не отвечал бы ни на один вопрос,
  -- на который не отвечает этот.
  CONSTRAINT waste_ticket_pages_request_id_unique UNIQUE (request_id, id),
  CONSTRAINT waste_ticket_pages_status_check CHECK (status IN ('pending', 'done', 'failed')),
  CONSTRAINT waste_ticket_pages_page_no_check CHECK (page_no >= 1),
  CONSTRAINT waste_ticket_pages_tickets_found_check CHECK (tickets_found >= 0),
  -- Форма хэша проверяется схемой, потому что на нём стоит обнаружение дубля бумаги: тот же лист,
  -- записанный один раз в верхнем регистре, а другой в нижнем, — это два разных ключа и молча
  -- пропущенный повтор. Регистр закреплён нижний, как его отдаёт `crypto` в Node и `sha256sum`.
  CONSTRAINT waste_ticket_pages_sha256_check CHECK (page_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE waste_ticket_pages IS
  'Страница файла-скана (docs/waste-ticket-ocr-plan.md Р10): единица распознавания, несёт хэш '
  'РАСТРА страницы — им ловится тот же лист, приехавший в другом файле.';

-- Поиск повтора бумаги: «этот растр уже видели». Отдельный вопрос от кэша распознавания ниже —
-- тот спрашивает «этот растр уже читали такой-то моделью», и живёт в другой таблице.
CREATE INDEX waste_ticket_pages_sha256_idx ON waste_ticket_pages (page_sha256);

-- ── 3. Попытка распознавания: принадлежит содержимому (Р12, Р13, Р29) ──
--
-- Таблица НЕ знает ни о заявке, ни о файле, и это её главное свойство: попытка — это ответ на
-- вопрос «что такая-то модель такой-то версии промпта прочитала на таком-то растре». Ответ не
-- меняется от того, к какой заявке приложили бумагу, поэтому строки переживают откат заявки (Р22)
-- и служат кэшем: повторное закрытие тем же листом не стоит ни копейки.
--
-- Строки неизменяемы по договорённости, а не по триггеру: попытка пишется один раз в конце вызова
-- и больше не редактируется. Ставить сюда защиту вроде журнала остатков (`0172`) не за чем —
-- подделка попытки ничего не даёт, она никого ни в чём не убеждает, в отличие от подтверждения
-- талона.
CREATE TABLE waste_ticket_recognition_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ссылки на страницу здесь нет намеренно: страницу удаляет откат заявки, а попытка обязана его
  -- пережить — иначе кэш терял бы смысл ровно в том случае, ради которого заведён.
  page_sha256 char(64) NOT NULL,
  -- stub | proxy | ocr. Наружу портал ходит только через прокси заказчика (Р3), `stub` — тесты и
  -- разработка без сети. Значение входит в ключ кэша: прочитанное заглушкой не должно
  -- подставляться вместо настоящего чтения.
  engine text NOT NULL,
  -- ЗАКАЗАННАЯ модель — та, что в ключе кэша. Прокси вправе отдать запрос другой (Р7), и
  -- фактическая пишется рядом отдельной колонкой. Складывать их в одну нельзя: по заказанной
  -- ищется кэш, по фактической сверяется биллинг, и разойтись они обязаны видимо.
  model text NOT NULL DEFAULT '',
  model_reported text NOT NULL DEFAULT '',
  -- Обе версии в ключе кэша: сменился промпт или предобработка — это другое чтение, и старый
  -- ответ подставлять нельзя, даже если растр тот же.
  prompt_version integer NOT NULL,
  preprocessing_version integer NOT NULL,
  -- done | failed. Неуспешная попытка хранится наравне с успешной: по ней считается доля ошибок
  -- (Р29), и она же объясняет, почему у страницы нет талонов.
  status text NOT NULL,
  -- Принудительный проход мимо кэша (Р13): «перераспознать» при тех же версиях. Флаг выводит
  -- строку из уникального ключа ниже — иначе ограничение не дало бы завести вторую успешную
  -- попытку, и кнопка молча возвращала бы старый результат.
  forced boolean NOT NULL DEFAULT false,
  -- ТОЛЬКО нормализованный ответ, прошедший схему: `tickets[]` и `unreadable`. Ни служебных полей
  -- провайдера, ни полного текста ответа, ни тем более изображения — это данные, попадающие под
  -- вопрос о передаче сканов вовне (В1), и держать их «на всякий случай» нельзя.
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  -- Два идентификатора, а не один: свой — чтобы найти вызов в журнале прокси, апстримовый — чтобы
  -- сверить счёт с оператором. У них разные владельцы, и совпадать они не обязаны.
  proxy_request_id text NOT NULL DEFAULT '',
  upstream_request_id text NOT NULL DEFAULT '',
  -- Код сбоя как он приехал: queue_full | deadline_exceeded | http_403 | …. Множество открыто —
  -- закрывать его `CHECK` значило бы обещать, что мы знаем все ответы чужой подсистемы наперёд.
  error_code text NOT NULL DEFAULT '',
  -- А вот КЛАССИФИКАЦИЯ закрыта, потому что по ней принимаются решения: `transient` — повтор
  -- будет, `terminal` — не будет; `subsystem` поднимает баннер, `item` не поднимает (Р29).
  error_class text NOT NULL DEFAULT '',
  error_scope text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_ticket_recognition_attempts_engine_check
    CHECK (engine IN ('stub', 'proxy', 'ocr')),
  CONSTRAINT waste_ticket_recognition_attempts_status_check CHECK (status IN ('done', 'failed')),
  CONSTRAINT waste_ticket_recognition_attempts_error_class_check
    CHECK (error_class IN ('', 'transient', 'terminal')),
  CONSTRAINT waste_ticket_recognition_attempts_error_scope_check
    CHECK (error_scope IN ('', 'subsystem', 'item')),
  -- Неклассифицированный сбой = слепая метрика: строка попадёт в знаменатель health-метрики и не
  -- попадёт ни в один числитель, то есть УЛУЧШИТ картину самим фактом того, что её не разобрали.
  -- Поэтому классификация обязательна ровно у неуспешных — и обязательна в схеме, а не в коде:
  -- вставок сюда со временем станет больше одной.
  CONSTRAINT waste_ticket_recognition_attempts_classification_check
    CHECK (status <> 'failed' OR (error_class IN ('transient', 'terminal')
                              AND error_scope IN ('subsystem', 'item'))),
  CONSTRAINT waste_ticket_recognition_attempts_sha256_check
    CHECK (page_sha256 ~ '^[0-9a-f]{64}$'),
  -- Разобранный ответ — это объект с `tickets[]`; массив или строка на его месте означали бы, что
  -- в колонку положили сырьё мимо схемы, и читатель обнаружил бы это через полгода.
  CONSTRAINT waste_ticket_recognition_attempts_raw_check CHECK (jsonb_typeof(raw) = 'object')
);

COMMENT ON TABLE waste_ticket_recognition_attempts IS
  'Вызов модели по растру страницы (docs/waste-ticket-ocr-plan.md Р12): принадлежит содержимому, '
  'а не заявке — переживает откат и служит кэшем повторного закрытия тем же листом.';

-- КЛЮЧ КЭША, он же ключ идемпотентности прокси: оба отвечают на вопрос «это та же работа?».
-- Только для УСПЕШНЫХ — ограничение без этого условия запирало бы повтор после разрыва сети,
-- то есть делало бы неудачу окончательной. И мимо принудительных проходов (Р13).
--
-- Ключ полон ровно потому, что контракт движка не принимает изменяемых подсказок (Р3): вызов
-- однозначно задаётся содержимым страницы, движком, моделью и двумя версиями. Появятся подсказки
-- или проходы с разным набором полей — в ключ придётся добавить их хэш, иначе разные вызовы
-- склеятся, и второй молча получит ответ первого.
CREATE UNIQUE INDEX waste_ticket_recognition_attempts_cache_unique
  ON waste_ticket_recognition_attempts (
    page_sha256, engine, model, prompt_version, preprocessing_version
  )
  WHERE status = 'done' AND NOT forced;

-- «Чем и когда читали этот растр» — история страницы, свежее сверху.
CREATE INDEX waste_ticket_recognition_attempts_page_created_idx
  ON waste_ticket_recognition_attempts (page_sha256, created_at DESC);

-- Два индекса под health-метрику (Р29): знаменатель — попытки, ДЕЙСТВИТЕЛЬНО ходившие в прокси,
-- числитель — неуспешные. Частичные, потому что окно у метрики короткое (час), а таблица растёт
-- всем, что когда-либо читали: полный индекс по `created_at` заставлял бы её перебирать заглушки
-- и успешные вызовы ради доли, которая считается по единицам строк.
CREATE INDEX waste_ticket_recognition_attempts_proxy_idx
  ON waste_ticket_recognition_attempts (created_at DESC) WHERE engine = 'proxy';
CREATE INDEX waste_ticket_recognition_attempts_failed_idx
  ON waste_ticket_recognition_attempts (created_at DESC) WHERE status = 'failed';

-- ── 4. Талон (Р15–Р17) ──
--
-- Распознанное — предложение, но проверка считается сразу. У талона два независимых признака:
-- `origin` («откуда взялся», неизменяем) и `status` («что с ним решил человек»). Считать проверки
-- только по подтверждённым нельзя: тогда человек, ещё не разобравший талоны, не видел бы ни
-- одного замечания — сверка появлялась бы уже ПОСЛЕ того, как он принял решение. Поэтому
-- проверки считаются по всем неотклонённым, а ограничения БД — только по подтверждённым: занять
-- номер может лишь бумага, которую человек признал (Р15).
CREATE TABLE waste_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  -- Пусто у ручного талона (страницы у него нет вовсе) и у машинного, чья страница убрана.
  page_id uuid,
  -- Позиция талона на странице: их бывает по два на снимке.
  seq smallint NOT NULL DEFAULT 1,
  -- Обе попытки каскада (Р14): дешёвая читает всё, старшая перечитывает спорное. Хранятся обе,
  -- потому что «чем прочитана эта цифра» — вопрос к живому значению, а не к истории вызовов.
  -- `SET NULL`, а не `RESTRICT`: уборка попыток по TTL не должна упираться в талоны — но пока
  -- талон на попытку ссылается, уборка её и не трогает (Р31), так что обнуление здесь — это
  -- страховка от рассинхрона, а не рабочий путь.
  primary_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  escalation_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  -- СНИМОК оператора-исполнителя, взятый в момент подтверждения, и дальше замороженный: область
  -- уникальности номера — перевозчик, потому что талон выдаёт он, а у двух перевозчиков нумерация
  -- независима. Снимок, а не ссылка на заявку, потому что исполнителя выполненной заявки законно
  -- меняют, и вместе с ним поехала бы область уникальности уже занятого номера. `NULL` законен:
  -- оператор у заявки необязателен, и `NOT NULL` здесь означал бы выдуманного контрагента.
  -- Удаление контрагента запрещено умолчанием (`NO ACTION`) — как и всюду, где хранится снимок:
  -- область, потерявшая имя, перестала бы объяснять, почему номер занят.
  operator_counterparty_id uuid REFERENCES counterparties (id),
  -- Номер в трёх видах, и каждый нужен отдельно (Р16): дословно — человеку, консервативный ключ —
  -- ограничению БД, поисковый — предупреждению о похожем. Агрессивная нормализация в ключе
  -- склеила бы `12-34` и `123-4` в один номер, поэтому дефисы и ведущие нули в нём сохраняются.
  number_raw text NOT NULL DEFAULT '',
  number_key text NOT NULL DEFAULT '',
  number_fuzzy text NOT NULL DEFAULT '',
  -- Дата выполнения с талона. Пусто — не прочиталась или проходы разошлись (Р14): расхождение
  -- двух чтений оставляет поле пустым, а кандидатов показывает человеку.
  issued_on date,
  -- Кубометры из графы «Объем». `NULL` законен дважды: у простоя объёма нет вовсе, и у обычного
  -- талона он бывает не прочитан. Поэтому «объём обязателен у вывоза» здесь не проверяется — такой
  -- `CHECK` запретил бы записать честно нераспознанное и отправил бы весь талон в ручной ввод.
  volume_m3 numeric(12,3),
  -- removal | idle | other. Талон бывает про простой («Простой с 9:10 по 10:10»), и в сумму
  -- объёма он не входит (Р18) — без этого поля такой талон выглядел бы вывозом на ноль кубов.
  work_kind text NOT NULL DEFAULT 'removal',
  -- Адрес выполнения — он же объект. Графа «Заказчик» несёт название компании и для привязки
  -- бесполезна. Дословно: адрес пишут от руки и сокращают как придётся, сравнение нестрогое.
  address_raw text NOT NULL DEFAULT '',
  -- ocr | manual, неизменяемо. Правка машинного талона `origin` НЕ меняет — иначе метрика «доля
  -- правок» переставала бы его видеть ровно тогда, когда он для неё интереснее всего.
  origin text NOT NULL,
  -- unconfirmed | confirmed | dismissed.
  status text NOT NULL DEFAULT 'unconfirmed',
  -- Какие поля модель просит посмотреть: пусто, вне диапазона, разошлись проходы (Р14).
  -- Набор значений намеренно НЕ закрыт `CHECK`, в отличие от `resolved_fields` слепой проверки:
  -- там имена полей несут ограничения целостности, здесь это подсказка интерфейсу, и новый повод
  -- присмотреться не должен стоить миграции.
  needs_review_fields text[] NOT NULL DEFAULT '{}',
  edited_at timestamptz,
  edited_by uuid REFERENCES users (id),
  confirmed_by uuid REFERENCES users (id),
  confirmed_at timestamptz,
  -- Клапан уникальности (Р17): ставится ТОЛЬКО на конфликтующую строку — заводимую или
  -- подтверждаемую сейчас, и только если конфликт под блокировкой действительно нашёлся. Отдельной
  -- ручки «снять ограничение» нет вовсе: сняв его со старшей строки, она открыла бы её номер всем
  -- следующим дублям — то есть починила бы один случай, отключив проверку навсегда.
  duplicate_override_at timestamptz,
  duplicate_override_by uuid REFERENCES users (id),
  duplicate_override_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Обнуляется ТОЛЬКО `page_id` (PostgreSQL 15+): у талона `request_id NOT NULL`, и обычный
  -- `ON DELETE SET NULL` попытался бы обнулить обе колонки ключа — то есть уронил бы удаление
  -- страницы ошибкой NOT NULL вместо того, чтобы отвязать талон. Отвязать, а не удалить: талон,
  -- подтверждённый человеком, переживает уборку страницы.
  CONSTRAINT waste_tickets_page_fk FOREIGN KEY (request_id, page_id)
    REFERENCES waste_ticket_pages (request_id, id) ON DELETE SET NULL (page_id),
  CONSTRAINT waste_tickets_origin_check CHECK (origin IN ('ocr', 'manual')),
  CONSTRAINT waste_tickets_status_check
    CHECK (status IN ('unconfirmed', 'confirmed', 'dismissed')),
  CONSTRAINT waste_tickets_work_kind_check CHECK (work_kind IN ('removal', 'idle', 'other')),
  CONSTRAINT waste_tickets_seq_check CHECK (seq >= 1),
  -- Отрицательный объём — не расхождение, а бессмыслица. Ноль допущен намеренно: он всего лишь
  -- неправдоподобен, а строку нужно суметь записать, чтобы человеку было что исправить.
  CONSTRAINT waste_tickets_volume_check CHECK (volume_m3 IS NULL OR volume_m3 >= 0),
  -- «Кто и когда» ходят парой: половина ответа хуже, чем его отсутствие, — она выглядит ответом.
  CONSTRAINT waste_tickets_edited_check CHECK ((edited_at IS NULL) = (edited_by IS NULL)),
  CONSTRAINT waste_tickets_confirmed_check
    CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  -- Ручной талон создаётся сразу подтверждённым (Р15): его ввёл человек, и ждать, пока он
  -- подтвердит сам себя, не за чем. Отклонить его потом можно — `dismissed` здесь законен.
  CONSTRAINT waste_tickets_manual_confirmed_check
    CHECK (origin <> 'manual' OR status <> 'unconfirmed'),
  -- Все три колонки клапана вместе или ни одной. Снятый клапан — это отсутствие причины, а не
  -- пустая причина: иначе «почему этот дубль разрешён» имело бы два разных представления, и
  -- отбор «строки с клапаном» разошёлся бы с частичными индексами ниже.
  CONSTRAINT waste_tickets_duplicate_override_check
    CHECK ((duplicate_override_at IS NULL) = (duplicate_override_by IS NULL)
       AND (duplicate_override_at IS NULL) = (duplicate_override_reason = ''))
);

COMMENT ON TABLE waste_tickets IS
  'Талон вывоза (docs/waste-ticket-ocr-plan.md Р15–Р17): распознанное — предложение, номер '
  'занимает только подтверждённая человеком строка.';

-- Один талон на позицию страницы: повторный разбор той же страницы не должен раздваивать бумагу.
-- Только машинные: ручной талон заводят к странице свободно, и `seq` у него ничего не занимает.
CREATE UNIQUE INDEX waste_tickets_page_seq_unique
  ON waste_tickets (page_id, seq)
  WHERE page_id IS NOT NULL AND origin = 'ocr';

-- ГЛАВНОЕ ОГРАНИЧЕНИЕ МОДУЛЯ: один лист не закрывает две заявки. Индексов два, потому что
-- «ничьи» заявки надо свести в одну область, а `NULL` в PostgreSQL не равен `NULL` — с одним
-- индексом по паре талоны заявок без исполнителя не конфликтовали бы вообще ни с чем, то есть
-- проверка молча выключалась бы там, где оператор не проставлен.
--
-- Условия обоих: только подтверждённые (Р15) и только без снятого клапана (Р17). Пустой ключ
-- исключён — нераспознанный номер не может занимать чужой.
CREATE UNIQUE INDEX waste_tickets_operator_number_unique
  ON waste_tickets (operator_counterparty_id, number_key)
  WHERE operator_counterparty_id IS NOT NULL AND number_key <> ''
    AND status = 'confirmed' AND duplicate_override_at IS NULL;
CREATE UNIQUE INDEX waste_tickets_number_unique
  ON waste_tickets (number_key)
  WHERE operator_counterparty_id IS NULL AND number_key <> ''
    AND status = 'confirmed' AND duplicate_override_at IS NULL;

-- «Талоны этой заявки» — вопрос, с которого начинается любая сверка.
CREATE INDEX waste_tickets_request_idx ON waste_tickets (request_id);
-- Поиск похожего номера (Р16). Результат такого поиска всегда предупреждение, а не запрет:
-- сведение `О`/`0` и `A`/`А` — это догадка, и запрещать по догадке нельзя.
CREATE INDEX waste_tickets_number_fuzzy_idx ON waste_tickets (number_fuzzy);

-- ── 5. Предложение перераспознавания (Р13) ──
--
-- Кнопка «перераспознать» не переписывает работу человека: `unconfirmed` без правки замещается
-- новыми значениями прямо в талоне, а подтверждённое, ручное и правленое — не трогается, и новое
-- чтение живёт здесь, отдельной строкой, пока человек не примет или не отклонит его.
--
-- Хранится МАТЕРИАЛИЗОВАННЫЙ СНИМОК значений, а не ссылки на попытки, из которых его можно
-- собрать заново. Причина в сроке жизни: попытки, на которые не ссылается талон, убираются по
-- TTL (`TICKET_OCR_ATTEMPT_TTL_DAYS`), и предложение, собираемое из `raw`, в этот день молча
-- обнулилось бы. Ссылки на обе попытки каскада рядом со снимком — «чем это прочитано», и они
-- объявлены `SET NULL` намеренно: иначе непринятое предложение держало бы сырьё вечно.
CREATE TABLE waste_ticket_proposals (
  -- PK = FK: одно активное предложение на талон. Второе означало бы очередь предложений, а
  -- человеку в ней пришлось бы разбирать не бумагу, а историю кнопки.
  ticket_id uuid PRIMARY KEY REFERENCES waste_tickets (id) ON DELETE CASCADE,
  number_raw text NOT NULL DEFAULT '',
  issued_on date,
  volume_m3 numeric(12,3),
  work_kind text NOT NULL DEFAULT 'removal',
  address_raw text NOT NULL DEFAULT '',
  primary_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  escalation_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_ticket_proposals_work_kind_check
    CHECK (work_kind IN ('removal', 'idle', 'other')),
  CONSTRAINT waste_ticket_proposals_volume_check CHECK (volume_m3 IS NULL OR volume_m3 >= 0)
  -- Нормализованного ключа номера здесь нет намеренно: предложение номера не занимает. Принятие,
  -- меняющее номер, идёт тем же путём, что обычная правка (Р27) — с блокировкой по
  -- `(оператор, number_key)` и повторной проверкой конфликта, — а не в обход уникальности.
);

COMMENT ON TABLE waste_ticket_proposals IS
  'Предложение перераспознавания (docs/waste-ticket-ocr-plan.md Р13): снимок нового чтения для '
  'талона, который человек уже трогал; принимается или отклоняется, но сам себя не применяет.';

-- ── 6. Слепая перепроверка и арбитраж (Р31) ──
--
-- Признак `confidence` метрикой не считается: модель уверена и когда ошибается. Разметка,
-- приходящая из работы, тоже неравноценна — правка сильный сигнал, подтверждение слабый (человек
-- смотрит на подставленное значение и склонен согласиться). Поэтому второй человек читает талон,
-- НЕ ВИДЯ ни распознанного, ни подтверждённого, и его чтение сравнивается со снимком машинного.
--
-- Сама перепроверка не измеряет уверенные ошибки: она показывает, что два чтения разошлись, но не
-- говорит, кто прав. Атрибуция требует третьего разбора — арбитража, и в метрику уверенных ошибок
-- идёт только разобранное. Отсюда почти все ограничения ниже: они не дают объявить разобранным
-- то, что не разобрано, и не дают засчитать разбор там, где расхождения не было.
CREATE TABLE waste_ticket_blind_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES waste_tickets (id) ON DELETE CASCADE,
  -- Пусто, пока задание не взято. Строка заводится в момент попадания талона в выборку, ещё без
  -- проверяющего: иначе состояния `pending` в реестре не существовало бы вовсе, и «сколько
  -- заданий ждёт разбора» было бы вопросом без ответа. Взятие атомарно проставляет `checker_id`
  -- (`UPDATE … WHERE checker_id IS NULL RETURNING`), поэтому гонка двух проверяющих разрешается в
  -- пользу первого, а второму реестр отдаёт следующий талон.
  checker_id uuid REFERENCES users (id),
  -- Что прочитал человек.
  review_number_raw text NOT NULL DEFAULT '',
  -- Ключ по Р16: номера сравниваются нормализованными, иначе «№ 12-34» и «12-34» уходили бы в
  -- расхождение, и метрика ошибок OCR наполнялась бы разницей в пробелах.
  review_number_key text NOT NULL DEFAULT '',
  review_issued_on date,
  review_volume_m3 numeric(12,3),
  -- СНИМОК машинного чтения на момент попадания в выборку. Снимок, а не чтение талона по ссылке:
  -- талон правят, и сравнение поехало бы задним числом — вчерашнее расхождение превратилось бы в
  -- совпадение просто потому, что кто-то исправил цифру.
  baseline_number_raw text NOT NULL DEFAULT '',
  baseline_number_key text NOT NULL DEFAULT '',
  baseline_issued_on date,
  baseline_volume_m3 numeric(12,3),
  -- Отпечаток снимка: по нему видно, что сравнивали именно эту версию машинного чтения.
  baseline_fingerprint char(64) NOT NULL,
  -- pending | match | mismatch | arbitrated.
  status text NOT NULL DEFAULT 'pending',
  -- Вердикта одним словом нет: правота бывает разной по полям — номер за машиной, дата за
  -- человеком, объём мимо у обоих. Хранятся итоговые ЗНАЧЕНИЯ, а «кто прав» считается сравнением
  -- с `review_*` и `baseline_*` по каждому полю отдельно.
  final_number_raw text,
  final_number_key text,
  final_issued_on date,
  final_volume_m3 numeric(12,3),
  -- Какие поля арбитр разобрал. Отдельно от значений, потому что «верного значения нет» (объёма на
  -- талоне не было вовсе) и «поле не разобрано» — разные вещи, а `NULL` их не различает.
  resolved_fields text[] NOT NULL DEFAULT '{}',
  arbiter_id uuid REFERENCES users (id),
  arbitrated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Одна перепроверка на талон, а не по одной на человека: иначе «доля расхождений» зависела бы
  -- от того, сколько людей позвали смотреть на один и тот же лист.
  CONSTRAINT waste_ticket_blind_checks_ticket_unique UNIQUE (ticket_id),
  CONSTRAINT waste_ticket_blind_checks_status_check
    CHECK (status IN ('pending', 'match', 'mismatch', 'arbitrated')),
  -- Без проверяющего строка может быть только ожидающей: «совпало» без того, кто читал, — это
  -- совпадение снимка с пустотой.
  CONSTRAINT waste_ticket_blind_checks_pending_check
    CHECK (checker_id IS NOT NULL OR status = 'pending'),
  -- Арбитр не проверяет сам себя: третий разбор затем и нужен, что двое уже высказались.
  -- «Арбитр ≠ подтвердивший талон» держит сервис — подзапрос в `CHECK` невозможен.
  CONSTRAINT waste_ticket_blind_checks_arbiter_check
    CHECK (arbiter_id IS NULL OR arbiter_id <> checker_id),
  -- Статус обязан соответствовать ФАКТИЧЕСКОМУ сравнению. Иначе совпавшую строку можно объявить
  -- разобранной и подмешать в метрику разбор, которого не было, — а метрика для того и заведена,
  -- чтобы ей верили без пересчёта.
  CONSTRAINT waste_ticket_blind_checks_match_check
    CHECK (status <> 'match' OR (
           baseline_number_key IS NOT DISTINCT FROM review_number_key
       AND baseline_issued_on  IS NOT DISTINCT FROM review_issued_on
       AND baseline_volume_m3  IS NOT DISTINCT FROM review_volume_m3)),
  CONSTRAINT waste_ticket_blind_checks_mismatch_check
    CHECK (status NOT IN ('mismatch', 'arbitrated') OR (
           baseline_number_key IS DISTINCT FROM review_number_key
        OR baseline_issued_on  IS DISTINCT FROM review_issued_on
        OR baseline_volume_m3  IS DISTINCT FROM review_volume_m3)),
  -- Разобрать можно только то, что разошлось. `<> ALL`, а не `<> ANY`: нужно «этого имени нет в
  -- массиве», а `ANY` означало бы «отличается хотя бы от одного его элемента» — и совпавшее поле
  -- проходило бы проверку за счёт соседнего, разошедшегося.
  CONSTRAINT waste_ticket_blind_checks_resolved_diff_check
    CHECK (('number'   <> ALL(resolved_fields) OR baseline_number_key IS DISTINCT FROM review_number_key)
       AND ('issuedOn' <> ALL(resolved_fields) OR baseline_issued_on  IS DISTINCT FROM review_issued_on)
       AND ('volumeM3' <> ALL(resolved_fields) OR baseline_volume_m3  IS DISTINCT FROM review_volume_m3)),
  -- «Кто разобрал» и «когда» появляются ровно вместе со статусом разбора, в обе стороны.
  CONSTRAINT waste_ticket_blind_checks_arbitration_check
    CHECK ((status = 'arbitrated') = (arbiter_id IS NOT NULL)
       AND (status = 'arbitrated') = (arbitrated_at IS NOT NULL)),
  -- До арбитража итогов нет вовсе: значение, вписанное в неразобранную строку, — это чужое мнение,
  -- выданное за решение.
  CONSTRAINT waste_ticket_blind_checks_no_final_check
    CHECK (status = 'arbitrated' OR (resolved_fields = '{}'
       AND final_number_raw IS NULL AND final_issued_on IS NULL AND final_volume_m3 IS NULL)),
  -- В массив попадают только имена полей талона: опечатка в имени тихо вывела бы поле из всех
  -- проверок ниже, потому что ни одна из них про несуществующее имя ничего не утверждает.
  CONSTRAINT waste_ticket_blind_checks_resolved_domain_check
    CHECK (resolved_fields <@ ARRAY['number', 'issuedOn', 'volumeM3']::text[]),
  -- Итог пишется только для разобранного поля: значение без разбора — тихая выдумка.
  CONSTRAINT waste_ticket_blind_checks_final_resolved_check
    CHECK ((final_number_raw IS NULL OR 'number'   = ANY(resolved_fields))
       AND (final_issued_on  IS NULL OR 'issuedOn' = ANY(resolved_fields))
       AND (final_volume_m3  IS NULL OR 'volumeM3' = ANY(resolved_fields))),
  -- Дословный итог и его ключ ходят парой: по ключу считается «кто прав по номеру», и итог без
  -- ключа выпал бы из метрики, оставшись видимым в интерфейсе.
  CONSTRAINT waste_ticket_blind_checks_final_key_check
    CHECK ((final_number_key IS NULL) = (final_number_raw IS NULL)),
  -- Разобрано должно быть КАЖДОЕ разошедшееся поле: частично закрытая строка хуже неразобранной,
  -- потому что выглядит законченной и уходит из реестра разбора. Сравнение NULL-safe, номер — по
  -- нормализованному ключу.
  CONSTRAINT waste_ticket_blind_checks_arbitrated_complete_check
    CHECK (status <> 'arbitrated' OR (
           (baseline_number_key IS NOT DISTINCT FROM review_number_key OR 'number'   = ANY(resolved_fields))
       AND (baseline_issued_on  IS NOT DISTINCT FROM review_issued_on  OR 'issuedOn' = ANY(resolved_fields))
       AND (baseline_volume_m3  IS NOT DISTINCT FROM review_volume_m3  OR 'volumeM3' = ANY(resolved_fields)))),
  CONSTRAINT waste_ticket_blind_checks_fingerprint_check
    CHECK (baseline_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE waste_ticket_blind_checks IS
  'Слепая перепроверка талона и арбитраж (docs/waste-ticket-ocr-plan.md Р31): второе независимое '
  'чтение против снимка машинного; кто прав — считается по полям, а не одним вердиктом.';

-- Реестр заданий: «что ждёт проверяющего» и «что ждёт арбитра» — два вопроса к одной колонке.
CREATE INDEX waste_ticket_blind_checks_status_idx ON waste_ticket_blind_checks (status, created_at);

-- ── 7. Принятое расхождение (Р21) ──
--
-- Материализуется РЕШЕНИЕ, а не замечание. Само замечание остаётся вычисляемым — иначе разойдётся
-- с талонами на первой же правке. А «принимаю расхождение» хранится с ОТПЕЧАТКОМ ВХОДА: код
-- проверки, набор подтверждённых талонов, фактический объём, `removed_on`, заявленный объём,
-- `delivery_at`, область оператора, действующие допуски и версия алгоритма проверок. Изменилась
-- любая из величин — принятие перестаёт действовать само, и замечание возвращается.
--
-- Без отпечатка «принято» означало бы «замолчать навсегда» — в том числе про расхождение, которого
-- в момент принятия не было и которое появилось потом.
CREATE TABLE waste_ticket_check_resolutions (
  request_id uuid NOT NULL REFERENCES waste_requests (id) ON DELETE CASCADE,
  -- duplicate_number | volume_mismatch | date_mismatch | address_mismatch | …
  -- Набор НЕ закрыт `CHECK` намеренно: проверки заводятся кодом (`services/waste-ticket-checks.ts`),
  -- и каждая новая стоила бы миграции — притом что закрытый набор здесь ничего не защищает:
  -- принятие с неизвестным кодом просто ни к чему не привяжется и ничего не погасит.
  check_code text NOT NULL,
  -- Id талона для построчных проверок, `''` — для заявочных. Пустая строка, а не `NULL`, потому
  -- что колонка входит в первичный ключ: `NULL` в нём означал бы, что заявочное принятие можно
  -- записать дважды.
  subject_key text NOT NULL DEFAULT '',
  input_fingerprint char(64) NOT NULL,
  -- `NO ACTION` умолчанием: «кто принял расхождение» обязано пережить увольнение — иначе принятие
  -- осталось бы решением без принявшего, а это и есть та самая тишина, от которой отпечаток
  -- защищает. Так же устроены заявки, история статусов и путевые листы (ADR 0063).
  accepted_by uuid NOT NULL REFERENCES users (id),
  comment text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  -- Одно принятие на «заявка + проверка + предмет»: повторное принятие того же расхождения
  -- переписывает строку вместе с отпечатком, а не копится историей молчания.
  CONSTRAINT waste_ticket_check_resolutions_pk PRIMARY KEY (request_id, check_code, subject_key),
  CONSTRAINT waste_ticket_check_resolutions_check_code_check CHECK (btrim(check_code) <> ''),
  -- Причина обязательна и непуста: принятие расхождения — это ответ человека на вопрос «почему
  -- цифры не сходятся», и пустая строка здесь означала бы, что вопрос закрыли, не ответив.
  CONSTRAINT waste_ticket_check_resolutions_comment_check CHECK (btrim(comment) <> ''),
  CONSTRAINT waste_ticket_check_resolutions_fingerprint_check
    CHECK (input_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE waste_ticket_check_resolutions IS
  'Принятое расхождение по заявке (docs/waste-ticket-ocr-plan.md Р21): решение человека с '
  'отпечатком входа — изменился вход, принятие перестаёт действовать само.';

-- ── 8. Дата фактического вывоза у факта закрытия (Р19) ──
--
-- Дня, КОГДА реально вывезли, у портала до сих пор нет: есть плановая `delivery_at` и момент
-- закрытия `completed_at`, а сверять дату талона надо с фактом. Плановая для этого не годится —
-- вывозят и раньше, и позже, а закрывают заявку вообще другим днём, задним числом.
--
-- BACKFILL НЕ ВЫПОЛНЯЕТСЯ, и это решение, а не экономия (Р19). Подставить историческим закрытиям
-- плановую дату значило бы выдать предположение за факт: при первой же прогонке архива портал
-- нарисовал бы расхождения дат там, где их никто не совершал, — и разбирать эти расхождения
-- пришлось бы людям, у которых нет способа проверить выдуманную цифру. Поэтому у истории честное
-- «неизвестно», и жёсткая сверка идёт только против введённой даты.
ALTER TABLE waste_request_completions
  ADD COLUMN removed_on date,
  -- entered | unknown. Значение `inferred` из ранних редакций плана убрано: у строки без даты оно
  -- означало бы «выведено», хотя не выведено ничего.
  ADD COLUMN removed_on_source text NOT NULL DEFAULT 'unknown';

-- Одно связано с другим намертво: дата без источника и источник без даты — это два способа
-- соврать о том, откуда взялся день вывоза. Проверка двусторонняя (`=` между предикатами, а не
-- `OR`), поэтому `entered` без даты она отбивает так же, как дату с `unknown`.
ALTER TABLE waste_request_completions
  ADD CONSTRAINT waste_request_completions_removed_on_source_check
    CHECK (removed_on_source IN ('entered', 'unknown')),
  ADD CONSTRAINT waste_request_completions_removed_on_check
    CHECK ((removed_on IS NULL) = (removed_on_source = 'unknown'));

COMMENT ON COLUMN waste_request_completions.removed_on IS
  'День фактического вывоза (docs/waste-ticket-ocr-plan.md Р19): вводится при закрытии, у '
  'исторических закрытий пусто — плановая дата сюда не подставляется.';
COMMENT ON COLUMN waste_request_completions.removed_on_source IS
  'Откуда взялся день вывоза: entered — ввёл человек, unknown — закрытие старше колонки.';
