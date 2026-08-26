-- Наблюдение как единица измерения качества распознавания (ADR 0137, план docs/waste-ticket-audit-plan.md).
--
-- Журнал 0206 отвечает на вопрос «что случилось с полем», но не отвечает на вопрос «сколько раз
-- модель ошиблась»: у доли исправлений нет знаменателя. Повторное распознавание нетронутого талона
-- пишет пять новых `recognized`; форма талона шлёт все пять полей всегда, и каждое сохранение
-- пишет пять `edited`, из которых настоящих обычно ноль или одна; правка после правки выглядит
-- второй ошибкой машины. Считать по такому журналу — значит показывать проценты, которые ничего
-- не измеряют, но выглядят измерением.
--
-- НАБЛЮДЕНИЕ — ОДНО МАШИННОЕ ЧТЕНИЕ ОДНОГО ПОЛЯ, то есть событие `recognized` или `disputed`.
-- Человеческое событие ссылается на него `observation_id`, и метрика считается по наблюдениям, а не
-- по событиям: три правки одного поля — одна ошибка машины, а не три.
--
-- АДРЕСАЦИЯ ДОМЕННАЯ, А НЕ «ПОСЛЕДНЕЕ ПО ВРЕМЕНИ». Правка и снятие относятся к текущему чтению
-- поля, но два процесса работают с чтением, которого в талоне уже нет: принятие и отклонение
-- предложения — к чтению, лежащему в `waste_ticket_proposals` со своими попытками; арбитраж слепой
-- перепроверки — к `baseline_*`, снятому в момент отбора. Между отбором и арбитражем талон мог
-- смениться дважды, и «последнее наблюдение» приписало бы ошибку не той модели.
--
-- СВЯЗЬ СТРОКАМИ, А НЕ КАРТОЙ В JSONB. Карта не проверяет ни существования наблюдения, ни имени
-- поля, ни принадлежности владельцу. Состав сверяемых полей уже разошёлся (слепая проверка знает
-- три, предложение пять) — это довод за строки, а не за JSON: шестое поле добавится само.
--
-- ИСХОД ПРЕДЛОЖЕНИЯ ЗАКРЕПЛЯЕТСЯ СОБЫТИЕМ ДО УДАЛЕНИЯ СТРОКИ. Предложение удаляется физически при
-- любом исходе, поэтому хранить исход в связи нельзя — его унесёт то самое удаление, ради которого
-- решение и принималось. Связь несёт `differs` (отличалось ли поле от талона в момент чтения), а
-- принятие и отклонение копируют признак в событие: `proposal`/`proposal_dismissed` плюс `differs`
-- дают исход и после того, как связи не стало.
--
-- ВЕРСИЯ СБОРА. Прежние события собраны без исхода, без признака прочтения и с правками по
-- неизменённым значениям. Они остаются с `collection_version = 1` и в метрики не идут; новые
-- инварианты проверяются только для второй версии — иначе миграция упала бы на собственной истории.

ALTER TABLE waste_ticket_field_events
  -- Чем адресовано человеческое событие. `RESTRICT`: удаление основания метрики — отдельное
  -- осознанное решение, а не побочное следствие чужой уборки. Отсюда требование к будущей уборке по
  -- сроку: наблюдение удаляется вместе с адресованными ему событиями, одной транзакцией.
  ADD COLUMN observation_id uuid REFERENCES waste_ticket_field_events (id) ON DELETE RESTRICT,

  -- Прочитано, не прочитано или неприменимо. Считается ПОСЛЕ слияния проходов: пустой кандидат
  -- уступает непустому молча, и спор возможен только между двумя непустыми различными значениями.
  -- Без этой колонки «не прочитано» пришлось бы угадывать по пустому значению — а пустой объём у
  -- простоя законен, и поле, заполненное второй ступенью, попало бы разом в «эскалация заполнила»
  -- и в «не прочитано».
  ADD COLUMN read_state text,
  -- Откуда взято итоговое значение. `merged` — оба прохода прочитали одинаково; у спора ступени нет.
  ADD COLUMN source_stage text,

  -- Три ссылки вместо одной: у спора и слияния участвуют две попытки, и модель с версиями надо
  -- знать у обеих. `selected_attempt_id` пуст, когда ступень не одна.
  --
  -- Все три `SET NULL`, и рядом снимки моделей. Попытки убираются по сроку, и уборка защищает лишь
  -- те, на которые ссылается живой талон: `RESTRICT` её просто сломает, а `SET NULL` без снимков
  -- потеряет модель старой когорты — то есть ровно то, ради чего журнал ведётся.
  ADD COLUMN primary_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  ADD COLUMN escalation_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  ADD COLUMN selected_attempt_id uuid REFERENCES waste_ticket_recognition_attempts (id) ON DELETE SET NULL,
  ADD COLUMN primary_model_reported text NOT NULL DEFAULT '',
  ADD COLUMN escalation_model_reported text NOT NULL DEFAULT '',

  -- Оба кандидата: без них нельзя сказать, какая ступень была права, а спор читается как «поле
  -- пустое» без объяснения.
  ADD COLUMN primary_value text,
  ADD COLUMN escalation_value text,

  -- Куда смотреть человеку. Ссылка на файл переживает обнуление `ticket_id`: разбор ошибки без
  -- картинки бессмыслен, а талон могли удалить откатом. `page_no` открывает нужную страницу
  -- многостраничного скана, а не первую.
  ADD COLUMN file_id uuid REFERENCES files (id) ON DELETE SET NULL,
  ADD COLUMN page_no smallint,

  -- Разбор как единица работы и признак, что вызова к прокси не было: при попадании в кэш новой
  -- строки попытки не создаётся, и «сколько мы позвали модель» иначе считалось бы эвристикой по
  -- времени.
  ADD COLUMN recognition_run_id uuid,
  ADD COLUMN cache_hit boolean NOT NULL DEFAULT false,

  -- Отличалось ли поле предложения от талона в момент чтения (§1.2.2 плана). Хранится, а не
  -- выводится из значений события: между чтением и решением человек мог править талон, и
  -- «повторило ли чтение то, что стояло в талоне» — свойство момента чтения.
  ADD COLUMN proposal_differs boolean,

  -- Версия сбора. Шаг первый: все прежние строки получают единицу дефолтом.
  ADD COLUMN collection_version smallint NOT NULL DEFAULT 1;

-- Шаг второй: новые строки пишутся второй версией. Поставь мы `DEFAULT 2` сразу — вся прежняя
-- история молча стала бы второй версией, то есть попала бы в метрики без исхода и без признака
-- прочтения.
ALTER TABLE waste_ticket_field_events ALTER COLUMN collection_version SET DEFAULT 2;

-- Отклонение предложения начинает писать событие: сегодня маршрут пишет только `audit_log`, и
-- самый сильный отрицательный сигнал о новой модели — «человек посмотрел новое чтение и отказался
-- от него» — теряется целиком.
ALTER TABLE waste_ticket_field_events DROP CONSTRAINT waste_ticket_field_events_event_check;
ALTER TABLE waste_ticket_field_events ADD CONSTRAINT waste_ticket_field_events_event_check CHECK (
  event IN ('recognized', 'disputed', 'edited', 'proposal', 'proposal_dismissed', 'arbitrated', 'dismissed')
);

ALTER TABLE waste_ticket_field_events
  ADD CONSTRAINT waste_ticket_field_events_read_state_check CHECK (
    read_state IS NULL OR read_state IN ('read', 'unreadable', 'not_applicable')
  ),
  ADD CONSTRAINT waste_ticket_field_events_source_stage_check CHECK (
    source_stage IS NULL OR source_stage IN ('primary', 'escalation', 'merged')
  ),
  ADD CONSTRAINT waste_ticket_field_events_collection_version_check CHECK (collection_version >= 1),
  -- Инварианты второй версии. Условие по версии — не оговорка ради удобства: прежние события
  -- собраны другим кодом, и требуй мы от них признака прочтения, миграция упала бы на собственной
  -- истории, а починить её задним числом нечем.
  ADD CONSTRAINT waste_ticket_field_events_v2_read_state_check CHECK (
    collection_version < 2 OR event NOT IN ('recognized', 'disputed') OR read_state IS NOT NULL
  ),
  ADD CONSTRAINT waste_ticket_field_events_v2_proposal_check CHECK (
    collection_version < 2
    OR (event IN ('proposal', 'proposal_dismissed')) = (proposal_differs IS NOT NULL)
  ),
  -- Наблюдение — только машинное чтение. Человеческое событие, названное основанием метрики,
  -- означало бы «модель ошиблась там, где её не спрашивали».
  ADD CONSTRAINT waste_ticket_field_events_observation_self_check CHECK (
    observation_id IS NULL OR event NOT IN ('recognized', 'disputed')
  );

-- ОЧИСТКА ПОЛЯ — ТОЖЕ ПРАВКА. Ограничение 0206 требовало у `edited` непустого нового значения, и
-- законный ход разбора ронял запись целиком: талон простоя объёма не несёт, человек ставит вид
-- работ «простой» и очищает объём — а `INSERT` события падал, откатывая вместе с собой саму правку.
-- Дефект был и до наблюдений; фильтр «пишем только фактические изменения» лишь вывел его на
-- видное место, потому что раньше такой `PATCH` падал по той же причине молча реже.
--
-- Событию по-прежнему запрещено быть пустым с обеих сторон: правка, где и «было», и «стало»
-- пусты, — это не правка, а строка ни о чём.
ALTER TABLE waste_ticket_field_events DROP CONSTRAINT waste_ticket_field_events_edit_check;
ALTER TABLE waste_ticket_field_events ADD CONSTRAINT waste_ticket_field_events_edit_check CHECK (
  event <> 'edited' OR old_value IS NOT NULL OR new_value IS NOT NULL
);

-- Составной ключ для связей: он же доказывает, что связь указывает на наблюдение ТОГО ЖЕ поля.
-- Полной тройки с `ticket_id` здесь нет намеренно — колонка объявлена `ON DELETE SET NULL`, и ключ
-- через обнуляемого родителя означал бы, что журнал качества запрещает удалить заявку.
ALTER TABLE waste_ticket_field_events ADD CONSTRAINT waste_ticket_field_events_id_field_key UNIQUE (id, field);

-- Разбор наблюдения: «что человек с ним сделал» — главный запрос всех шести ручек.
CREATE INDEX waste_ticket_field_events_observation_idx
  ON waste_ticket_field_events (observation_id)
  WHERE observation_id IS NOT NULL;
-- Лента исправлений ходит по полю и времени.
CREATE INDEX waste_ticket_field_events_edited_idx
  ON waste_ticket_field_events (field, created_at DESC)
  WHERE event = 'edited';

-- ── Связи наблюдений ──
--
-- Обе таблицы временные по природе: они живут, пока живы предложение и слепая проверка. Исход к
-- моменту их удаления уже закреплён событием, поэтому `CASCADE` на владельце безопасен, а
-- `RESTRICT` на наблюдении — обязателен.

CREATE TABLE waste_ticket_proposal_observations (
  proposal_ticket_id uuid NOT NULL
    REFERENCES waste_ticket_proposals (ticket_id) ON DELETE CASCADE,
  field text NOT NULL,
  observation_id uuid NOT NULL,
  -- Отличалось ли поле от талона в момент чтения. Пять строк на предложение, а не только
  -- отличавшиеся: без строки на совпавшее поле его нечем будет назвать `uninformative`.
  differs boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_ticket_id, field),
  CONSTRAINT waste_ticket_proposal_observations_field_check CHECK (
    field IN ('number', 'issuedOn', 'volumeM3', 'workKind', 'addressRaw')
  ),
  CONSTRAINT waste_ticket_proposal_observations_observation_fk
    FOREIGN KEY (observation_id, field)
    REFERENCES waste_ticket_field_events (id, field) ON DELETE RESTRICT
);

CREATE TABLE waste_ticket_blind_check_observations (
  blind_check_id uuid NOT NULL
    REFERENCES waste_ticket_blind_checks (id) ON DELETE CASCADE,
  field text NOT NULL,
  observation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blind_check_id, field),
  -- Перепроверка меряет качество чтения рукописи, а не разметку бланка: вид работ и адрес в неё не
  -- входят, и в связи им делать нечего.
  CONSTRAINT waste_ticket_blind_check_observations_field_check CHECK (
    field IN ('number', 'issuedOn', 'volumeM3')
  ),
  CONSTRAINT waste_ticket_blind_check_observations_observation_fk
    FOREIGN KEY (observation_id, field)
    REFERENCES waste_ticket_field_events (id, field) ON DELETE RESTRICT
);

CREATE INDEX waste_ticket_proposal_observations_observation_idx
  ON waste_ticket_proposal_observations (observation_id);
CREATE INDEX waste_ticket_blind_check_observations_observation_idx
  ON waste_ticket_blind_check_observations (observation_id);
