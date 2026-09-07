-- Журнал массовых операций над заявками и почтовые намерения пачки (план
-- `docs/office-equipment-bulk-actions-plan.md`, §6.3, Р7 и Р10; §9, строка `N+1`; этап Э2).
--
-- ОТКУДА НОМЕР. `ls apps/api/drizzle | tail -3` перед созданием файла (04.09.2026): последней в
-- дереве стояла `0278_service_request_bulk_summary_mail_kind.sql` — парная миграция этой же волны,
-- взявшая номер минутой раньше. Проверялось перед КАЖДЫМ файлом: номер живёт часы, и соседние
-- потоки занимают его незакоммиченными файлами.
--
-- ПОРЯДОК В ВОЛНЕ. Эта миграция катится ПОСЛЕ 0278 (вид письма) — не по зависимости в SQL, а по
-- смыслу: сервер, который начнёт писать намерения, обязан иметь и вид письма, которым их доставят.
-- Обе — до выката сервера с пакетной ручкой.
--
-- ЧТО ЗАВОДИТСЯ И ПОЧЕМУ.
--
--   · `service_request_bulk_operations` — «что вернули ЧЕЛОВЕКУ». Аудит на этот вопрос не отвечает:
--     он отвечает «что было с ЗАЯВКОЙ», и повторный клик по кнопке в нём не находит НИЧЕГО, что
--     можно вернуть вместо повторного применения. Версии тут не спасают: повтор после успеха
--     получил бы `version` по всем строкам и выглядел бы как «ничего не вышло», хотя всё вышло;
--   · `service_request_bulk_mail_items` — почтовые намерения строк до их доставки одним digest'ом
--     (Р10). Существующий потолок частоты считается по тройке «заявка + адрес + час» и от пачки по
--     разным заявкам не спасает вовсе.
--
-- ПОЧЕМУ АРЕНДА, А НЕ «СЧИТАЕМ БРОШЕННОЙ ПО ВОЗРАСТУ `created_at`». Возраст отвечает на вопрос
-- «давно ли начали», а нужен ответ на «жив ли тот, кто держит». Пятьдесят строк с письмами идут
-- секунды, но могут идти и минуту; пачку, которая работает, отбирать нельзя, а брошенную — нужно, и
-- различает их только heartbeat: перед каждой строкой владелец продлевает `lease_expires_at`.
-- `owner_token` при этом обязателен ровно потому, что срок сам по себе ничего не запрещает: условие
-- checkpoint'а «id + owner_token + не завершено» и есть то, что не даёт СТАРОМУ процессу дописать
-- строку после того, как аренду забрал новый.
--
-- ПОЧЕМУ `row_results` ОТДЕЛЬНО ОТ `result`. Первое — построчные checkpoint'ы, растущие по одному в
-- транзакции САМОЙ строки: успех фиксируется вместе с мутацией, и падение процесса не может его
-- потерять, а takeover пропускает уже сделанные индексы. Второе — готовый отчёт, который
-- возвращается повтору слово в слово. Слей их в одно поле — либо отчёт переписывался бы на каждой
-- строке, либо восстановление после падения не имело бы точки опоры.
--
-- УНИКАЛЬНОСТЬ — ПАРОЙ «АВТОР + КЛЮЧ», а не одним ключом: ключ описывает попытку КОНКРЕТНОГО
-- человека, и совпадение UUID у двоих (пусть невероятное) не должно превращать чужую пачку в
-- «повтор». Имя ограничения задано руками — по нему маршрут узнаёт свой `23505` в гонке двух
-- одновременных нажатий (приём кандидата и закупки).
--
-- `actor_user_id` — `ON DELETE SET NULL`, политика `audit_log`: удаление уволенного не должно
-- упираться в его пачки. `actor_name` рядом — снимок подписи: имя теряется вместе с учёткой, а
-- вопрос «кто это сделал» через год остаётся.
--
-- CHECK ИТОГА. Отчёт, оба счётчика и время завершения появляются ОДНОЙ транзакцией финализации.
-- Половина итога означала бы «пачка закончена, но неизвестно чем» — состояние, которого не бывает,
-- и отвечать за него должна база, а не внимательность следующего автора.
--
-- ПОЧТОВЫЕ ЭЛЕМЕНТЫ. Ключ — пятёрка «операция + строка + адресат + аудитория + событие»: одна
-- строка пачки даёт одному адресату разные события и разные аудитории, а повтор строки после
-- takeover обязан не удвоить намерение. `projected_payload` хранит УЖЕ спроецированные поля:
-- восстановить проекцию на финализации из полной заявки нельзя — деньги и сроки пришлось бы
-- считать заново и не для того читателя. `ON DELETE CASCADE` — намерения не переживают свою пачку.
--
-- ОБРАТИМОСТЬ. Аддитивна целиком: существующих таблиц, колонок и ограничений миграция не трогает.
-- Откат — `DROP TABLE` обеих после остановки пакетной ручки; старый код о них не знает, а новый без
-- них не стартует лишь на самой ручке.

CREATE TABLE service_request_bulk_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name text NOT NULL,
  idempotency_key uuid NOT NULL,
  idempotency_fingerprint text NOT NULL,
  operation text NOT NULL,
  requested_count integer NOT NULL,
  row_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_token uuid,
  lease_expires_at timestamptz,
  done_count integer,
  failed_count integer,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT service_request_bulk_operations_key_unique UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT service_request_bulk_operations_finished_check
    CHECK ((finished_at IS NULL) = (result IS NULL)
           AND (finished_at IS NULL) = (done_count IS NULL)
           AND (finished_at IS NULL) = (failed_count IS NULL))
);

-- «Мои пачки, свежие сверху» — единственный отбор журнала: читающая ручка спрашивает свою запись,
-- уборка идёт по времени завершения, а разбор смотрит на последние пачки автора.
CREATE INDEX service_request_bulk_operations_actor_idx
  ON service_request_bulk_operations (actor_user_id, created_at DESC);

CREATE TABLE service_request_bulk_mail_items (
  operation_id uuid NOT NULL REFERENCES service_request_bulk_operations(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  recipient_hash text NOT NULL,
  recipient_email citext NOT NULL,
  audience text NOT NULL,
  event text NOT NULL,
  projected_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_request_bulk_mail_items_pkey
    PRIMARY KEY (operation_id, row_index, recipient_hash, audience, event)
);

-- Группировка digest'а: «все намерения этой пачки по паре адресат + аудитория» одним проходом.
CREATE INDEX service_request_bulk_mail_items_digest_idx
  ON service_request_bulk_mail_items (operation_id, recipient_hash, audience);

-- ── Караул: обе таблицы собраны так, как объявлено ──
--
-- Проверяется на накате, а не тестом после: оператор выката увидит расхождение сразу. Отдельными
-- строками — именованное уникальное ограничение (по имени маршрут узнаёт `23505`), CHECK итога и
-- каскад почтовых элементов: сам факт существования таблиц ничего из этого не доказывает.

DO $$
DECLARE trouble text;
BEGIN
  SELECT string_agg(msg, '; ')
    INTO trouble
    FROM (
      SELECT 'журнала пачек нет' AS msg
       WHERE to_regclass('service_request_bulk_operations') IS NULL
      UNION ALL
      SELECT 'таблицы почтовых намерений пачки нет'
       WHERE to_regclass('service_request_bulk_mail_items') IS NULL
      UNION ALL
      SELECT 'именованного уникального ограничения «автор + ключ» нет'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'service_request_bulk_operations'::regclass
            AND conname = 'service_request_bulk_operations_key_unique'
            AND contype = 'u')
      UNION ALL
      SELECT 'CHECK целостности итога не поставлен'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'service_request_bulk_operations'::regclass
            AND conname = 'service_request_bulk_operations_finished_check'
            AND contype = 'c'
            AND convalidated)
      UNION ALL
      SELECT 'почтовые намерения не каскадируются за своей пачкой'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'service_request_bulk_mail_items'::regclass
            AND contype = 'f'
            AND confdeltype = 'c')
      UNION ALL
      SELECT format('индексов волны на месте %s из 2', count(*))
        FROM pg_indexes
       WHERE indexname IN ('service_request_bulk_operations_actor_idx',
                           'service_request_bulk_mail_items_digest_idx')
      HAVING count(*) <> 2
    ) AS bad;
  IF trouble IS NOT NULL THEN
    RAISE EXCEPTION 'Журнал массовых операций собран не так, как объявлено — %', trouble;
  END IF;
END $$;
