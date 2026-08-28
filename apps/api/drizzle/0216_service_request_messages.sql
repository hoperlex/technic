-- Обсуждение заявки на обслуживание оргтехники: лента реплик, адресаты и курсор прочтения
-- (план `docs/office-equipment-chat-plan.md`, §3.3 «Данные», §3.4 «Протокол чтения», §3.9 «Перенос
-- примечания»; выпуск A — expand, §3.10).
--
-- ЗАЧЕМ. Переписки в модуле нет вовсе. Есть два текстовых поля заявки: `comment` — что написал
-- заявитель при заведении, и `service_comment` — «Примечание исполнителя». Второе поле одно на всю
-- заявку, поэтому следующая запись ЗАТИРАЕТ предыдущую: «ждём запчасть до пятницы» исчезает в тот
-- момент, когда сервис пишет «запчасть пришла», и в споре о сроках предъявить нечего. Кому
-- написано, поле не говорит вовсе — «нужна виза» и «ждём вас на объекте» читаются одинаково, — а
-- узнать о написанном нельзя: механики «прочитано/не прочитано» в портале не существует ни в одном
-- модуле. Эта миграция заводит её впервые, и потому решения ниже задают образец, а не повторяют его.
--
-- ЧТО ЗАВОДИТСЯ: три таблицы (реплика, адресаты реплики, курсор прочтения), словарные `CHECK`'и,
-- частичные уникальные индексы, ШЕСТЬ триггеров — пять на неизменяемость ленты и один отложенный на
-- полноту адресата, — и разовый перенос непустых `service_comment` в ленту.
--
-- ЧЕГО ЗДЕСЬ НЕТ. Колонка `service_comment` НЕ СНИМАЕТСЯ. Штатный деплой накатывает миграции ДО
-- перезапуска контейнеров (`deploy/deploy-auto.sh`), а `requestQuery` выбирает строку заявки
-- целиком — drizzle перечисляет в `SELECT` все колонки схемы. `DROP COLUMN` встретился бы с ещё
-- работающим кодом предыдущего выпуска, и у него перестал бы отвечать ВЕСЬ модуль, а не одна
-- снятая ручка. Поэтому выпусков три (§3.10): A — эта миграция, B — снятие кода и колонки из
-- `schema.ts`, C — повторный перенос, проверка «текущее значение перенесено» и только потом
-- `DROP COLUMN`.
--
-- ПОЧЕМУ ЧАТ ТОЛЬКО У ОРГТЕХНИКИ. Ни «Заказ ТС», ни «Вывоз мусора» переписки не просили. Общие
-- таблицы «на будущее» здесь дороже пользы: их пришлось бы делать полиморфными по владельцу, то
-- есть без единого внешнего ключа на заявку — а именно внешний ключ и каскад дают этой ленте
-- половину её гарантий.
--
-- ОБРАТИМОСТЬ. Миграция аддитивная: три новые таблицы, функции и триггеры на них же, плюс перенос,
-- который читает `service_comment` и не меняет его. Существующие строки не правятся, поэтому откат
-- кода к предыдущему выпуску безопасен: лишние таблицы ему не мешают. Протокол необратимых
-- миграций (`docs/schema-cutover-protocol.md`) здесь не применяется намеренно (§3.10): он проходит
-- точку невозврата, после которой откат кода запрещён, а отказываться от отката тут не за чем.

-- ── 1. Реплика ──
--
-- НОМЕР РЕПЛИКИ — СВОЙ У КАЖДОЙ ЗАЯВКИ (`seq`), А НЕ ГЛОБАЛЬНАЯ IDENTITY. На номере держится
-- протокол прочтения (§3.4): «я дочитал до N» осмысленно ровно тогда, когда всё, что придёт позже,
-- получит номер больше N. Глобальная последовательность этого не обещает: значение из неё выдаётся
-- ДО коммита и вне транзакции, поэтому реплика с меньшим номером может стать видимой ПОЗЖЕ большего
-- — и навсегда останется прочитанной, никем не прочитанной. Номер здесь выдаётся под блокировкой
-- строки заявки (`SELECT … FROM service_requests WHERE id = $1 FOR UPDATE` — той же, что берут
-- остальные мутации заявки) как `MAX(seq)+1`, а уникальный индекс `(request_id, seq)` — страховка
-- от гонки, а не основной механизм.
--
-- ВРЕМЯ ДЛЯ ПОРЯДКА НЕ ГОДИТСЯ ПО ТОЙ ЖЕ ПРИЧИНЕ И ЕЩЁ ПО ОДНОЙ: `created_at` у перенесённых реплик
-- приблизительное (§3.9), а у двух реплик оно совпадает до микросекунды чаще, чем кажется. Лента
-- сортируется по `seq`, история заявки — по времени (§3.8), и под каждый вопрос стоит свой индекс.
--
-- ОТПРАВКА НЕ ТРОГАЕТ ЗАЯВКУ: ни `version`, ни `updated_at`, ни `updated_by`. Реплика — не правка
-- заявки; поднимай она `version`, каждое чужое сообщение давало бы конфликт оптимистической
-- блокировки в открытой у кого-то форме.
CREATE TABLE service_request_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `CASCADE`, как у вложений и исполнителей: переписка — часть самой заявки, а не отдельный
  -- документ, и «удалить насовсем» из архива обязано уносить её целиком. Единственная законная
  -- дверь к удалению строк этой таблицы — именно этот каскад (см. триггеры в §4).
  request_id uuid NOT NULL REFERENCES service_requests (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  -- `RESTRICT`, как `created_by` у самой заявки: «кто это написал» — часть переписки, на которую
  -- ссылаются в споре с подрядчиком, и удаление учётки портал обязан отклонить словами, а не
  -- обезличить реплику молча. Пусто — ТОЛЬКО у перенесённых (`origin = 'import'`, §3.9), где автора
  -- действительно не восстановить.
  author_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  origin text NOT NULL DEFAULT 'chat',
  -- `md5` перенесённого текста: на нём, а не на «уже переносили эту заявку», держится
  -- идемпотентность переноса (§3.9). Изменившееся в окне выката примечание даёт другой хеш и
  -- поэтому новую реплику — повторный прогон выпуска C не обязан знать, что именно изменилось.
  imported_hash text,
  body text NOT NULL,
  -- Без `DEFAULT now()`: у перенесённых время берётся от заявки, и умолчание превратило бы
  -- пропущенное поле в «перенесено сегодня».
  created_at timestamptz NOT NULL,
  -- Словарь закрыт схемой, а не соглашением между маршрутом и порталом: третье значение,
  -- придуманное через год, обязано начинаться с миграции, где о нём напишут почему.
  CONSTRAINT service_request_messages_origin_check CHECK (origin IN ('chat', 'import')),
  -- Нумерация начинается с единицы: `read_through_seq = 0` означает «не читал ничего», и реплика с
  -- нулевым номером родилась бы прочитанной у всех.
  CONSTRAINT service_request_messages_seq_check CHECK (seq > 0),
  -- Равенство, а не «одно из двух»: хеш у написанной в портале реплики означал бы ложную
  -- идемпотентность (её нельзя переносить повторно), а перенесённая без хеша выпала бы из защиты от
  -- дублей — то есть при повторном прогоне удвоилась бы.
  CONSTRAINT service_request_messages_import_check CHECK (
    (origin = 'import') = (imported_hash IS NOT NULL)
  ),
  -- Анонимность — привилегия только переноса. У реплики, написанной в портале, автор под рукой
  -- всегда: пустой `author_id` там означал бы выдуманную анонимность, а не незнание.
  CONSTRAINT service_request_messages_author_check CHECK (
    origin <> 'chat' OR author_id IS NOT NULL
  ),
  -- Пустая реплика — не реплика; предел длины тот же, что проверит схема ручки. Держать его в БД
  -- нужно затем же, зачем словарь: маршрут не единственный путь к таблице.
  CONSTRAINT service_request_messages_body_check CHECK (
    btrim(body) <> '' AND length(body) <= 2000
  )
);

-- Лента заявки и счёт непрочитанного («что после моего курсора»). Он же — страховка от гонки при
-- выдаче номера, поэтому индекс уникальный: два вопроса, один объект.
CREATE UNIQUE INDEX service_request_messages_request_seq_unique
  ON service_request_messages (request_id, seq);
-- История заявки сшивает три источника и сортирует их по времени (§3.8), а не по номеру: у
-- перенесённых реплик номер с временем не согласован.
CREATE INDEX service_request_messages_request_created_idx
  ON service_request_messages (request_id, created_at);
-- Идемпотентность переноса. Индекс ЧАСТИЧНЫЙ, и потому `ON CONFLICT` обязан повторять его предикат
-- дословно: без предиката PostgreSQL частичный индекс не выводит и падает с «no unique or exclusion
-- constraint matching the ON CONFLICT specification».
CREATE UNIQUE INDEX service_request_messages_import_unique
  ON service_request_messages (request_id, imported_hash)
  WHERE origin = 'import';

-- ── 2. Адресаты реплики ──
--
-- СТРОКАМИ, А НЕ МАССИВОМ В `jsonb` — по доводу миграции `0210`: карта не проверяет ни имени
-- стороны, ни существования учётки, ни принадлежности реплике. Здесь у неё нашлась бы и третья
-- беда: «кому уходит письмо по этой реплике» (§3.12) отвечается обычным соединением, пока адресаты
-- — строки, и разбором текста, как только они станут документом внутри документа. Счётчик
-- непрочитанного спрашивают каждую минуту все открытые клиенты (§3.5), и он ходит по этим строкам
-- индексом, а не разворачивает массив у каждой реплики.
--
-- АДРЕСАТ — ПОМЕТКА, А НЕ ОГРАНИЧЕНИЕ ВИДИМОСТИ (решение опроса §2). Текст видит каждый, кому видна
-- заявка; строка адресата управляет подсветкой и будущим письмом. Портал не должен делать вид, что
-- что-то прячет: приватных реплик в этой модели нет.
CREATE TABLE service_request_message_addressees (
  message_id uuid NOT NULL REFERENCES service_request_messages (id) ON DELETE CASCADE,
  -- Сторона цикла ИЛИ поимённый исполнитель — ровно одно из двух в строке. Две колонки вместо
  -- одной «кому» с разбором по префиксу: сторона проверяется словарём, учётка — внешним ключом, и
  -- ни то, ни другое из строки вида «user:<uuid>» не проверить.
  side text,
  -- `RESTRICT`, как у автора и у назначения исполнителя: адресованная человеку реплика без имени
  -- адресата перестаёт отвечать на вопрос, ради которого её адресовали.
  user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Ни пустой строки («адресовано никому» — это отсутствие строки), ни обеих сразу («стороне
  -- `service` и вот этому человеку» — две строки, и считаются они по-разному).
  CONSTRAINT service_request_message_addressees_target_check CHECK (
    (side IS NULL) <> (user_id IS NULL)
  ),
  -- Словарь сторон закрыт схемой, а не доверием к клиенту: `all` — всем участникам, остальные
  -- четыре — стороны цикла (§3.1). Опечатка в стороне иначе стала бы репликой, которую не видит
  -- яркой никто, и заметили бы её через месяц.
  CONSTRAINT service_request_message_addressees_side_check CHECK (
    side IS NULL OR side IN ('all', 'customer', 'operator', 'it', 'service')
  )
);

-- Частичные, а не обычные `UNIQUE`: в обычном NULL'ы считаются различными, и дублей «сторона
-- `it` дважды» такой ключ не поймал бы вовсе — их отличал бы друг от друга пустой `user_id`.
CREATE UNIQUE INDEX service_request_message_addressees_side_unique
  ON service_request_message_addressees (message_id, side)
  WHERE side IS NOT NULL;
CREATE UNIQUE INDEX service_request_message_addressees_user_unique
  ON service_request_message_addressees (message_id, user_id)
  WHERE user_id IS NOT NULL;
-- Под счётчик непрочитанного (§3.5): он спрашивает «есть ли у этой реплики адресат из моих сторон»
-- и «есть ли адресат — я лично». Оба вопроса идут от адресата к реплике, а не наоборот, поэтому
-- ведущая колонка здесь `side` / `user_id`, а не `message_id`: от реплики читает уникальный индекс
-- выше.
CREATE INDEX service_request_message_addressees_side_idx
  ON service_request_message_addressees (side, message_id);
CREATE INDEX service_request_message_addressees_user_idx
  ON service_request_message_addressees (user_id, message_id)
  WHERE user_id IS NOT NULL;

-- ── 3. Курсор прочтения ──
--
-- КУРСОР, А НЕ ОТМЕТКА ВРЕМЕНИ (§3.4). `read_at = now()` теряет реплику двумя способами, и оба
-- воспроизводимы. Первый: отправка началась раньше открытия окна, а закоммитилась позже отметки —
-- её `created_at` меньше `read_at`, и она рождается прочитанной, хотя её никто не видел. Второй:
-- окно ставит отметку при открытии, а загрузка ленты падает — человек не увидел ничего, портал
-- считает прочитанным всё. Номер от обеих бед свободен: он выдаётся под блокировкой заявки и растёт
-- строго монотонно, поэтому «дочитал до N» остаётся верным утверждением и через год.
--
-- Строка на пару «заявка + человек», без суррогатного ключа: второго курсора у того же человека в
-- той же заявке не бывает, а с `id` их стало бы два и «докуда дочитано» перестало бы иметь ответ.
CREATE TABLE service_request_message_reads (
  -- Обе ссылки `CASCADE`, в отличие от автора и адресата. Курсор — не история и не свидетельство:
  -- он говорит только «докуда дочитал живой человек в живой заявке». Ушла заявка — читать нечего;
  -- ушла учётка — некому. `RESTRICT` здесь означал бы, что удаление уволенного упирается в его же
  -- закладку, и разбирать её пришлось бы руками.
  request_id uuid NOT NULL REFERENCES service_requests (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Двигается только вперёд: сервер пишет `GREATEST(текущий, throughSeq)`, чтобы вторая вкладка не
  -- откатила курсор назад, и требует `0 ≤ throughSeq ≤ lastSeq`, чтобы клиент не загнал его в
  -- будущее и не погасил разговор, которого ещё нет.
  read_through_seq integer NOT NULL,
  -- Когда курсор двигали в последний раз — для разбора жалоб «я это не читал», и только для него:
  -- подсветка считается по номеру.
  read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_request_message_reads_pkey PRIMARY KEY (request_id, user_id),
  -- Ноль законен и означает «открывал, но не дочитал ни до чего»; отрицательного курсора нет.
  CONSTRAINT service_request_message_reads_seq_check CHECK (read_through_seq >= 0)
);

-- ── 4. Неизменяемость ленты держит БД, а не отсутствие колонок ──
--
-- Соблазн сказать «править нечем: нет ни `updated_at`, ни `deleted_at`» — неправда: `UPDATE body` и
-- `DELETE` доступны любому, кто дошёл до psql. Для переписки, на которую ссылаются в споре с
-- подрядчиком, этого мало, поэтому защита тройная и каждая часть закрывает свою дверь:
--
--   правка ..... `BEFORE UPDATE` на репликах и на адресатах, безусловный отказ. Ни текст, ни
--                адресат задним числом не меняются; ошибку исправляют следующей репликой;
--   удаление ... `BEFORE DELETE` УСЛОВНЫЙ: проходит, только если родительской строки уже нет. Так
--                каскад от `DELETE FROM service_requests` (ручка «удалить насовсем») уносит
--                переписку, а самостоятельное `DELETE FROM service_request_messages WHERE id = …`
--                отбивается;
--   дописывание. `BEFORE INSERT` на адресатах: адресата можно добавить только в транзакции,
--                создавшей реплику. Без него подсветку задним числом переписали бы, не тронув ни
--                текста, ни строк ленты, — то есть обошли бы первые две проверки целиком.
--
-- ЧТО ИМЕННО ГАРАНТИРУЕТСЯ. Реплику нельзя изменить, нельзя удалить отдельно от заявки и нельзя
-- переадресовать; удаляется переписка только вместе с заявкой и только той ручкой, которая удаляет
-- заявку насовсем. Гарантия действует против портала, скриптов и прямого SQL, но НЕ против
-- суперпользователя базы: тот отключит триггер. Это граница любого DB-инварианта, и обещать больше
-- было бы нечестно. `TRUNCATE` строковых триггеров не вызывает вовсе — от него защищают права.

CREATE FUNCTION service_request_messages_immutable() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION
    'Реплика обсуждения неизменяема: текст и адресат правке не подлежат, ошибку исправляют следующей репликой'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER service_request_messages_immutable
  BEFORE UPDATE ON service_request_messages
  FOR EACH ROW EXECUTE FUNCTION service_request_messages_immutable();
-- `ENABLE ALWAYS` — отдельной командой: в `CREATE TRIGGER` такого слова нет, а без него на
-- реплике-приёмнике проверка не сработает вовсе. Приём тот же, что у `0167`, `0172` и `0187`.
ALTER TABLE service_request_messages
  ENABLE ALWAYS TRIGGER service_request_messages_immutable;

CREATE TRIGGER service_request_message_addressees_immutable
  BEFORE UPDATE ON service_request_message_addressees
  FOR EACH ROW EXECUTE FUNCTION service_request_messages_immutable();
ALTER TABLE service_request_message_addressees
  ENABLE ALWAYS TRIGGER service_request_message_addressees_immutable;

COMMENT ON FUNCTION service_request_messages_immutable() IS
  'Безусловный отказ: лента обсуждения заявки только растёт. Тела у проверки нет и быть не должно — '
  'законного пути, который правил бы реплику или её адресата, в схеме не существует. Одна функция '
  'на обе таблицы: сообщение об отказе у них общее.';

-- Удаление отличает каскад от самодеятельности по единственному надёжному признаку — жив ли
-- родитель. Каскад в PostgreSQL исполняется ПОСЛЕ удаления родительской строки, поэтому к моменту
-- срабатывания этого триггера заявки в снимке транзакции уже нет, и `NOT EXISTS` истинно. Прямой
-- `DELETE` по ленте видит заявку живой и получает отказ. Признака «я внутри каскада» у триггерной
-- функции нет вовсе (`TG_OP` одинаков в обоих случаях), и заменить эту проверку правами нельзя:
-- у портала одна учётка и на удаление заявки, и на всё остальное.
CREATE FUNCTION service_request_messages_delete_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_requests WHERE id = OLD.request_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Реплику обсуждения нельзя удалить отдельно от заявки (реплика %, заявка %)', OLD.id, OLD.request_id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER service_request_messages_delete_guard
  BEFORE DELETE ON service_request_messages
  FOR EACH ROW EXECUTE FUNCTION service_request_messages_delete_guard();
ALTER TABLE service_request_messages
  ENABLE ALWAYS TRIGGER service_request_messages_delete_guard;

COMMENT ON FUNCTION service_request_messages_delete_guard() IS
  'Условный отказ на DELETE реплики: пропускает удаление, только если заявки-родителя в транзакции '
  'уже нет (то есть работает каскад от DELETE FROM service_requests). Самостоятельное удаление '
  'строки ленты отбивается.';

-- То же правило на ярус ниже, и оно не лишнее: `DELETE FROM service_request_message_addressees
-- WHERE message_id = …` не трогает ни одной реплики и первым триггером не ловится, а переписка без
-- адресатов — это переписка, у которой стёрли «кому».
CREATE FUNCTION service_request_message_addressees_delete_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_request_messages WHERE id = OLD.message_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Адресата реплики нельзя удалить отдельно от самой реплики (реплика %)', OLD.message_id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER service_request_message_addressees_delete_guard
  BEFORE DELETE ON service_request_message_addressees
  FOR EACH ROW EXECUTE FUNCTION service_request_message_addressees_delete_guard();
ALTER TABLE service_request_message_addressees
  ENABLE ALWAYS TRIGGER service_request_message_addressees_delete_guard;

COMMENT ON FUNCTION service_request_message_addressees_delete_guard() IS
  'Условный отказ на DELETE адресата: пропускает удаление, только если самой реплики в транзакции '
  'уже нет (каскад от удаления реплики, а та удаляется лишь каскадом от заявки).';

-- Дописать адресата к чужой, ранее созданной реплике нельзя. Признак «строку создала эта же
-- транзакция» берётся у самой строки — `xmin`: у только что вставленной он равен идентификатору
-- текущей транзакции, у существовавшей раньше — чужой и меньший. Сравнение идёт в типе `xid`
-- (`pg_current_xact_id()::xid`), а не через `bigint`: приведение `xmin::text::bigint::xid8`
-- PostgreSQL отвергает, а между 32-битным `xid` строки и 64-битным `xid8` счётчика прямого
-- сравнения нет.
--
-- ГРАНИЦА ПРИЁМА, о которой обязан знать серверный код, — она строже, чем кажется, и проверена на
-- dev-базе: реплика обязана вставляться на ВЕРХНЕМ уровне транзакции, без единого savepoint'а
-- вокруг. `pg_current_xact_id()` возвращает идентификатор ВЕРХНЕЙ транзакции, а строка, вставленная
-- внутри подтранзакции, получает в `xmin` идентификатор ЭТОЙ ПОДТРАНЗАКЦИИ — и они не совпадают
-- даже тогда, когда обе вставки сделаны внутри одного savepoint'а. Для драйвера это означает:
-- обычная транзакция (`db.transaction`) годится, вложенная (`tx.transaction`, а она разворачивается
-- в savepoint) — нет; PL/pgSQL-блок с `EXCEPTION` вокруг вставки — тоже нет, обработчик исключения
-- открывает подтранзакцию. Отсюда же требование к процедуре переноса (§3.9): адресат вставляется
-- только по `RETURNING` собственной вставки, а не «к найденной по хешу реплике» — иначе перенос
-- уронил бы себя об этот триггер.
CREATE FUNCTION service_request_message_addressees_same_xact() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_same boolean;
BEGIN
  SELECT m.xmin = pg_current_xact_id()::xid INTO v_same
  FROM service_request_messages m
  WHERE m.id = NEW.message_id;

  -- Реплики нет вовсе: внешний ключ скажет об этом точнее, но он проверяется позже, и без явного
  -- отказа сюда пришёл бы NULL, который `IF NOT v_same` пропустил бы молча.
  IF v_same IS NULL THEN
    RAISE EXCEPTION
      'Адресат ссылается на несуществующую реплику %', NEW.message_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_same THEN
    RAISE EXCEPTION
      'Адресата можно добавить только вместе с самой репликой: переадресация задним числом запрещена (реплика %)',
      NEW.message_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER service_request_message_addressees_same_xact
  BEFORE INSERT ON service_request_message_addressees
  FOR EACH ROW EXECUTE FUNCTION service_request_message_addressees_same_xact();
ALTER TABLE service_request_message_addressees
  ENABLE ALWAYS TRIGGER service_request_message_addressees_same_xact;

COMMENT ON FUNCTION service_request_message_addressees_same_xact() IS
  'BEFORE INSERT на адресатах: разрешает вставку только в транзакции, создавшей реплику (xmin '
  'строки против pg_current_xact_id()). Закрывает переадресацию задним числом, которую правка и '
  'удаление не ловят.';

-- ── 5. У реплики есть хотя бы один адресат ──
--
-- `CHECK` этого не выразит: проверка межтабличная. Триггер ОТЛОЖЕННЫЙ (приём миграции `0035`):
-- реплика и её адресаты пишутся одной транзакцией, и вставка идёт в единственно возможном порядке
-- — сначала реплика, потом строки «кому». Немедленная проверка отбивала бы саму реплику на первом
-- же шаге, то есть запрещала бы единственный правильный путь.
--
-- Функция ПЕРЕЧИТЫВАЕТ состояние по идентификатору и молча выходит, если реплики в этой же
-- транзакции не стало: удаление заявки целиком (каскад) — законный ход, и требовать от снесённой
-- реплики адресата значило бы запретить очистку архива.
CREATE FUNCTION service_request_message_addressee_present_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_request_messages WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM service_request_message_addressees a WHERE a.message_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'У реплики обсуждения % нет ни одного адресата', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER service_request_message_addressee_present
  AFTER INSERT ON service_request_messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION service_request_message_addressee_present_trg();
ALTER TABLE service_request_messages
  ENABLE ALWAYS TRIGGER service_request_message_addressee_present;

COMMENT ON FUNCTION service_request_message_addressee_present_trg() IS
  'Отложенная проверка на COMMIT: у каждой реплики есть хотя бы один адресат. Перечитывает реплику '
  'по идентификатору и молчит, если её в этой же транзакции унёс каскад удаления заявки.';

COMMENT ON TRIGGER service_request_message_addressee_present ON service_request_messages IS
  'AFTER INSERT, DEFERRABLE INITIALLY DEFERRED: исполняет service_request_message_addressee_present_trg(). '
  'ENABLE ALWAYS.';

-- ── 6. Перенос «Примечания исполнителя» в ленту (§3.9) ──
--
-- ЭТОТ БЛОК БУДЕТ ВЫПОЛНЕН ПОВТОРНО — дословно тем же кодом, миграцией выпуска C, прямо перед
-- `DROP COLUMN service_comment` (§3.10). Копируется он целиком, от `DO $migrate$` до конца, и
-- потому обязан быть идемпотентным сам по себе, а не «при первом запуске на пустой ленте».
--
-- ПОЧЕМУ ПОВТОРНЫЙ ПРОГОН ВООБЩЕ НУЖЕН. Миграции накатываются ДО перезапуска контейнеров, поэтому в
-- окне выката B ручка-адаптер `PATCH /:id/service-comment` из кода выпуска A ещё жива и ещё пишет в
-- колонку. Перенос, выполненный миграцией B, этой записи не увидел бы, и она осталась бы только в
-- колонке, которую C собирается снести.
--
-- ЧТО ПЕРЕНОС ЧЕСТНО ГОВОРИТ О ТОМ, ЧЕГО НЕ ЗНАЕТ. Автора у примечания взять неоткуда: `updated_by`
-- и `updated_at` — ОБЩИЕ поля заявки, и любая последующая операция их перезаписывает, так что
-- «автор примечания» через месяц — это тот, кто последним двигал статус. Аудит не помогает: запись
-- `serviceRequest.service_comment` идёт ПОСЛЕ транзакции, с проглатыванием ошибки, и текста не
-- несёт. Поэтому `author_id = NULL` и `origin = 'import'`, а портал рисует такую реплику как
-- «Перенесено из примечания исполнителя», без имени. Время берётся приблизительное
-- (`COALESCE(updated_at, created_at)` заявки) и помечается таким же в интерфейсе: приблизительная
-- дата под пометкой честнее точной даты под чужим именем.
--
-- ПОЧЕМУ КАЖДЫЙ ШАГ ПОД БЛОКИРОВКОЙ, А НЕ ОДНИМ `INSERT … SELECT`. Одним запросом не выдать `seq`:
-- у заявки, где лента уже есть (повторный прогон в C), единица занята, а `MAX(seq)+1`, посчитанный
-- вне блокировки, гонится с обычной отправкой и с адаптером. Порядок шагов внутри цикла — из §3.9,
-- и переставлять их нельзя:
--
--   1) `FOR UPDATE` на заявке — та же блокировка, под которой номер выдаёт обычная отправка;
--   2) ПЕРЕПРОВЕРКА хеша уже под блокировкой. Отбирай мы заявки без хеша заранее, между выборкой и
--      блокировкой ту же строку успел бы вставить адаптер;
--   3) `MAX(seq)+1` по этой заявке;
--   4) `INSERT … ON CONFLICT (request_id, imported_hash) WHERE origin = 'import' DO NOTHING
--      RETURNING id` — предикат обязателен, иначе частичный индекс не выводится;
--   5) адресат `all` — ТОЛЬКО если `RETURNING` вернул идентификатор. Иначе следующая вставка либо
--      сослалась бы на несуществующий `message_id`, либо дописала адресата к ЧУЖОЙ реплике — и
--      справедливо упала бы об `xmin`-триггер, уронив миграцию на ровном месте.
--
-- Мягко удалённые заявки (`deleted_at IS NOT NULL`) переносятся наравне с живыми: их читают в
-- архиве, и примечание — часть того, что там читают. Пустое примечание не переносится вовсе:
-- переносить нечего, а реплика с пустым телом запрещена `CHECK`'ом.
DO $migrate$
DECLARE
  r record;
  v_body text;
  v_created timestamptz;
  v_hash text;
  v_seq integer;
  v_message_id uuid;
  v_moved integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR r IN
    SELECT sr.id FROM service_requests sr WHERE btrim(sr.service_comment) <> '' ORDER BY sr.id
  LOOP
    -- Шаг 1. Текст перечитывается ПОД блокировкой, а не берётся из внешней выборки: между ней и
    -- блокировкой адаптер мог и переписать примечание, и стереть его.
    SELECT sr.service_comment, COALESCE(sr.updated_at, sr.created_at)
      INTO v_body, v_created
      FROM service_requests sr
     WHERE sr.id = r.id
     FOR UPDATE;

    IF NOT FOUND OR btrim(v_body) = '' THEN
      CONTINUE;
    END IF;

    v_hash := md5(v_body);

    -- Шаг 2. Перепроверка под блокировкой.
    IF EXISTS (
      SELECT 1 FROM service_request_messages m
       WHERE m.request_id = r.id AND m.origin = 'import' AND m.imported_hash = v_hash
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Шаг 3.
    SELECT COALESCE(MAX(m.seq), 0) + 1 INTO v_seq
      FROM service_request_messages m WHERE m.request_id = r.id;

    -- Шаг 4. `v_message_id` обнуляется самим `INTO`, когда `DO NOTHING` не вернул строки.
    INSERT INTO service_request_messages
      (request_id, seq, author_id, origin, imported_hash, body, created_at)
    VALUES (r.id, v_seq, NULL, 'import', v_hash, v_body, v_created)
    ON CONFLICT (request_id, imported_hash) WHERE origin = 'import' DO NOTHING
    RETURNING id INTO v_message_id;

    IF v_message_id IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Шаг 5. Адресат `all`: у перенесённого примечания получателя не знает никто, а «всем
    -- участникам» — ровно то, чем оно было в карточке.
    INSERT INTO service_request_message_addressees (message_id, side)
    VALUES (v_message_id, 'all');

    v_moved := v_moved + 1;
  END LOOP;

  RAISE NOTICE 'Перенос примечаний исполнителя: перенесено %, пропущено как уже перенесённые %',
    v_moved, v_skipped;
END
$migrate$;
