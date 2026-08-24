-- Управляющий контур периодов назначения: режимы, поколения сверки, аттестации, журнал переходов
-- (план `docs/assignment-periods-plan.md`, §6; этап 2, волна 2.1, управляющая миграция).
--
-- ЧТО ЗАВОДИТСЯ. Четыре таблицы и одна управляющая строка, которыми модуль истории будет
-- переключаться и доказывать своё право переключиться:
--
--   `assignment_periods_control`          — режим записи и режим чтения, ровно одна строка;
--   `assignment_shadow_runs` / `_checks`  — поколения теневого сравнения: manifest целей и их итог;
--   `assignment_deploy_attestations`      — что именно раскатано на момент cutover, со стороны
--                                           деплоя, а не со слов нажимающего кнопку;
--   `assignment_periods_mode_transitions` — журнал переходов режима, физически append-only.
--
-- КТО ИМИ ПОЛЬЗУЕТСЯ. Сегодня — никто: автомат режимов приходит волной 2.2, теневое сравнение —
-- этапом 4, сам cutover — этапом 5. Схема уезжает раньше кода намеренно (см. `0166`).
--
-- ПОЧЕМУ ОТДЕЛЬНО ОТ ПРЕДМЕТНОЙ МИГРАЦИИ (П4). История назначения (`0166`) полезна сама по себе и
-- откатывается своим порядком; управляющий контур — это выкат режима работы модуля, и связать их
-- одной транзакцией значило бы лишить обе части самостоятельного окна.
--
-- ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Нет `set_module_mode()` с `SECURITY DEFINER`, нет `CREATE ROLE`, нет
-- `GRANT`/`REVOKE`/`OWNER TO`. Первое — потому что основной вариант плана (решение по Ф2) держит
-- дверь переключения в maintenance-сервисе, ходящем своими кредами, а `SECURITY DEFINER` описан как
-- усиление контура и отдельная инфраструктурная задача; тело функции планом не выписано, и
-- сочинять его в миграции нечем. Второе — потому что раннер выполняет файл целиком одним
-- `client.query` (`apps/api/src/db/migration-journal.ts:122`), psql-переменных вида `:'role'` не
-- знает, а зашивать имена ролей в DDL значит зашивать инфраструктуру в схему (Р1). Роли и права
-- выдаёт отдельный шаг CI: `technic_owner` (владелец объектов), `technic_maintenance`
-- (административный путь), `technic_app` (приложение, `GRANT SELECT, UPDATE (lock_tick)`).
--
-- ОБРАТИМОСТЬ. Миграция аддитивная: четыре новые таблицы, три функции, три триггера и одна строка
-- настройки. Существующие таблицы не трогаются вовсе. Протокол выката необратимых миграций
-- (`docs/schema-cutover-protocol.md`) к ней не применяется. Окно всё же планируется коротким:
-- объекты создаются одной транзакцией.

-- П7: миграция управляющего контура не должна исполняться прикладной ролью. Контейнер `migrate`
-- наследует общий env (`deploy/docker-compose.yml`), а `DATABASE_MIGRATION_URL` необязателен —
-- `buildMigrationClient` падает обратно на `DATABASE_URL`. Пройди накат прикладными кредами, и
-- владельцем управляющих таблиц станет само приложение: `REVOKE` владельцу не помеха, и
-- разделение ролей, ради которого контур и заводится, окажется декорацией.
--
-- Проверка по имени, а не по «не владелец»: сегодня контур не разделён вовсе — прод, dev и тесты
-- ходят одной ролью, — и любая более общая формулировка отказала бы в накате прямо сейчас.
-- Поэтому проверка ДРЕМЛЕТ до появления `technic_app` и срабатывает в тот день, когда ошибка
-- впервые становится возможной. Настоящая гарантия — обязательный `DATABASE_MIGRATION_URL` в
-- проде; эта строка ловит его отсутствие.
DO $$
BEGIN
  IF current_user = 'technic_app' THEN
    RAISE EXCEPTION 'Управляющий контур периодов назначения не накатывается прикладной ролью '
                    '(П7): задайте DATABASE_MIGRATION_URL миграционной роли'
      USING ERRCODE = '42501';
  END IF;
END
$$;

-- ── Управляющая строка модуля (Ж3, И1) ──

CREATE TABLE assignment_periods_control (
  -- Одиночка: строка ровно одна, вторую запрещает первичный ключ с CHECK. Приём тот же, что у
  -- `waybill_customer` (0164) и `organizations.is_primary`.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Режим ЗАПИСИ, а не булев freeze (И1): у отката и у cutover разные требования. `history_frozen`
  -- останавливает только двери, меняющие историю; `all_frozen` — всё, что вообще пишет, и только
  -- под ним разрешены cutover и возврат.
  write_mode text NOT NULL DEFAULT 'normal'
    CHECK (write_mode IN ('normal', 'history_frozen', 'all_frozen')),
  -- Режим ЧТЕНИЯ: откуда читатели берут «кто и на чём работал» — из назначения (`legacy`) или из
  -- истории. Переключается отдельно от записи и позже неё.
  read_mode text NOT NULL DEFAULT 'legacy' CHECK (read_mode IN ('legacy', 'history')),
  -- Каким поколением теневого сравнения разрешено переключение (М1): без ссылки его нечем
  -- обосновать постфактум. FK добавляется ниже, после создания таблицы прогонов (Н1).
  cutover_run_id uuid,
  -- Условие одностороннее: возврат в `legacy` не обязан стирать ссылку и уничтожать аудит того,
  -- чем история была включена.
  CONSTRAINT assignment_periods_control_cutover_check
    CHECK (read_mode <> 'history' OR cutover_run_id IS NOT NULL),
  -- Техническая колонка блокировки (Ц1, Ш1): единственное, на что приложение получает `UPDATE`.
  -- PostgreSQL требует для ЛЮБОЙ блокирующей формы SELECT (`FOR SHARE`, `FOR KEY SHARE`) права
  -- UPDATE хотя бы на одну колонку, а каждая пишущая транзакция модуля начинается с
  -- `SELECT ... FOR SHARE` по этой строке. С одним `GRANT SELECT` freeze-гейт упал бы не в углу, а
  -- на всех пишущих дверях сразу — проверено на dev-кластере (PostgreSQL 16.14).
  -- Значение не читается никем и не меняется никогда: запись запрещена триггером ниже.
  lock_tick smallint NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE assignment_periods_control IS
  'Режимы модуля периодов назначения (docs/assignment-periods-plan.md §6): строка ровно одна, '
  'правится только административной дверью. lock_tick существует ради права на SELECT ... FOR SHARE.';

-- Строка обязана существовать: по пустой таблице `FOR SHARE` не блокирует ничего, а `UPDATE`
-- обновляет ноль строк — и freeze считался бы пройденным (И3).
INSERT INTO assignment_periods_control (id, write_mode, read_mode)
VALUES (true, 'normal', 'legacy');

-- Строку не должен уметь удалить никто: без неё freeze «проходит» вхолостую. Защита триггером, а
-- не `REVOKE`: роли `technic_app` в репозитории нет, миграции ходят тем же `DATABASE_URL`, а
-- владельцу таблицы `REVOKE` не помеха (Л4). Триггер не ловит `TRUNCATE` и снимается владельцем —
-- поэтому разделение migration-owner и application-role остаётся требованием надёжности, а не
-- пожеланием. Ошибка при этом fail-closed: сервис читает строку как `exactlyOne` и без неё не
-- пишет вовсе.
CREATE FUNCTION assignment_periods_control_no_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Управляющая строка модуля не удаляется';
END
$$;

CREATE TRIGGER assignment_periods_control_no_delete
  BEFORE DELETE ON assignment_periods_control
  FOR EACH ROW EXECUTE FUNCTION assignment_periods_control_no_delete();

-- Запись в управляющую строку — только административным путём (Ц1). Триггер `BEFORE UPDATE`, и
-- только UPDATE: `DELETE` запрещён безусловным правилом выше, и неудаляемость строки не должна
-- зависеть от того, какая роль пришла (Ш1).
--
-- Пока контур не разделён (роли `technic_maintenance` в кластере нет — dev, тесты и сегодняшний
-- прод), триггер пропускает запись: иначе он запретил бы её всем, включая ту самую
-- административную дверь, ради которой заведён. Это осознанный fail-open: физической границей
-- средствами БД контур становится в тот момент, когда шаг CI заведёт роли и раздаст права, и
-- корректность до тех пор держится тем, что `UPDATE` прикладной роли попросту не выдан.
--
-- Следствие для будущих миграций: правка этой строки из миграции пойдёт под ролью-владельцем,
-- которую триггер (`ENABLE ALWAYS`) тоже не пропустит. Такой миграции придётся либо ходить ролью,
-- входящей в `technic_maintenance`, либо снимать триггер на время своей транзакции — и это
-- сознательная цена: управляющая строка правится дверью, а не побочно. Суперпользователь проходит
-- guard всегда: `pg_has_role` считает его членом любой роли. Это свойство кластера, а не дыра
-- триггера, — от суперпользователя средствами БД не защищаются вовсе.
CREATE FUNCTION assignment_periods_control_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF to_regrole('technic_maintenance') IS NULL THEN RETURN NEW; END IF;
  IF pg_has_role(current_user, 'technic_maintenance', 'usage') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'assignment_periods_control is read-only for this role' USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER assignment_periods_control_guard_trg
  BEFORE UPDATE ON assignment_periods_control
  FOR EACH ROW EXECUTE FUNCTION assignment_periods_control_guard();

-- `ENABLE ALWAYS`, чтобы триггер не обошла репликация: на реплике-приёмнике обычные триггеры не
-- срабатывают, а запрет на правку режима не должен зависеть от того, откуда пришла строка.
ALTER TABLE assignment_periods_control
  ENABLE ALWAYS TRIGGER assignment_periods_control_guard_trg;

-- ── Поколения теневого сравнения (З2, З6, К1, Л2) ──

CREATE TABLE assignment_shadow_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Жизненный цикл: `building` → seal → `running` → finalize → `completed` | `failed`. Печать
  -- (seal) существует ради того, чтобы поколение с наполовину построенным manifest'ом не объявило
  -- себя завершённым: 90 целей из ста, все сошлись, `pending` нет.
  status text NOT NULL CHECK (status IN ('building', 'running', 'completed', 'failed')),
  -- День, на который считалось сравнение. Прогон, переживший полночь, начинается заново (О3):
  -- календарь двигает валидность истории сам, без всякой двери (З1).
  as_of date NOT NULL,
  -- Версия алгоритма и сборка, которыми получен результат: доказательство cutover обязано называть,
  -- ЧТО именно сошлось, — иначе оно доказывает лишь то, что кто-то когда-то запускал сверку.
  algo_version text NOT NULL,
  build_version text NOT NULL,
  expected_checks integer NOT NULL CHECK (expected_checks >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Завершённое поколение обязано иметь время конца, работающее — не иметь.
  CONSTRAINT assignment_shadow_runs_finish_check
    CHECK ((status IN ('building', 'running')) = (finished_at IS NULL))
);

COMMENT ON TABLE assignment_shadow_runs IS
  'Поколение теневого сравнения истории с легаси (docs/assignment-periods-plan.md §6): только '
  'completed-поколение даёт право на cutover.';

-- Manifest, а не журнал (К1): строки заводятся ЗАРАНЕЕ, по одной на каждую ожидаемую цель, и worker
-- только переводит их в `match`/`mismatch`. Лишнюю область записать некуда — строки нет, а
-- пропущенная останется `pending` и не даст завершить поколение.
CREATE TABLE assignment_shadow_checks (
  run_id uuid NOT NULL REFERENCES assignment_shadow_runs(run_id) ON DELETE CASCADE,
  -- Значение, а не внешний ключ (Н3-узкое): удаление заявки не вправе менять завершённое поколение
  -- — доказательство cutover обязано быть неизменяемым.
  request_id uuid NOT NULL,
  scope_fingerprint text NOT NULL,
  -- Результат одной строкой (К2): раздельные «факт проверки» и «расхождение» расходились, если
  -- worker падал между двумя вставками, — поколение выглядело зелёным.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'match', 'mismatch')),
  evaluation_fingerprint text,
  details jsonb,
  checked_at timestamptz,
  PRIMARY KEY (run_id, request_id, scope_fingerprint),
  CONSTRAINT assignment_shadow_checks_result_check CHECK (
    CASE status
      WHEN 'pending'  THEN checked_at IS NULL AND evaluation_fingerprint IS NULL AND details IS NULL
      WHEN 'match'    THEN checked_at IS NOT NULL AND evaluation_fingerprint IS NOT NULL
      WHEN 'mismatch' THEN checked_at IS NOT NULL AND evaluation_fingerprint IS NOT NULL
                           AND details IS NOT NULL
    END
  )
);

COMMENT ON TABLE assignment_shadow_checks IS
  'Manifest целей поколения сверки (docs/assignment-periods-plan.md §6): строки заводятся заранее, '
  'worker переводит их из pending в match/mismatch.';

-- Связка управляющей строки с поколением (Н1): FK создаётся здесь, потому что при создании
-- `assignment_periods_control` таблицы прогонов ещё не существовало. RESTRICT: поколение, которым
-- включена история, не удаляется, пока на него ссылается режим.
ALTER TABLE assignment_periods_control
  ADD CONSTRAINT assignment_periods_control_cutover_run_fk
  FOREIGN KEY (cutover_run_id) REFERENCES assignment_shadow_runs(run_id) ON DELETE RESTRICT;

-- ── Аттестация деплоя (О4, Р3) ──
--
-- SQL-функция не знает ни `BUILD_SHA` вызывающего процесса, ни инвентаря деплоя, ни метрики старых
-- клиентов — а именно они решают, можно ли переключаться. Их приносит отдельная доверенная роль:
-- строку пишет job ДЕПЛОЯ (после раската, своими правами), а потребляет job cutover, у которого
-- прав на запись аттестации нет. Одна кнопка, которая и подтверждает, и использует, вернула бы
-- круговую проверку, ради устранения которой аттестация заведена (Н3).
CREATE TABLE assignment_deploy_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attested_at timestamptz NOT NULL DEFAULT now(),
  -- Что раскатано прямо сейчас. Массив, а не одна сборка: во время раската их законно две, и
  -- переключаться можно только когда обе умеют читать историю.
  active_build_shas text[] NOT NULL CHECK (array_length(active_build_shas, 1) >= 1),
  algo_version text NOT NULL,
  -- Сколько вызовов старого широкого маршрута с датами насчитала метрика (И5). Ноль — условие
  -- перехода; ненулевое значение означает, что где-то живёт клиент, который разреза не знает.
  legacy_client_calls integer NOT NULL CHECK (legacy_client_calls >= 0),
  -- Связь односторонняя (П3): «каким переходом потреблена» читается из журнала ниже. Обоюдные FK
  -- нельзя вставить в одной транзакции.
  consumed_at timestamptz
);

COMMENT ON TABLE assignment_deploy_attestations IS
  'Аттестация деплоя для cutover (docs/assignment-periods-plan.md §6): пишет job деплоя, '
  'потребляет job cutover — разделение обязанностей внутри CI.';

-- ── Журнал переходов режима (Н2, О5) ──

CREATE TABLE assignment_periods_mode_transitions (
  -- `GENERATED ALWAYS AS IDENTITY`, а не `bigserial`: тем же приёмом заведены номера заявок и
  -- рейсов, и явный идентификатор в append-only журнал вписать нельзя даже случайно.
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  -- RESTRICT: учётку того, кто переключил режим модуля, не удалить. Это и есть ответ на «кто
  -- разрешил», и он обязан пережить увольнение.
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Обе стороны обоих режимов: журнал восстанавливает автомат целиком, а не «чем кончилось».
  from_read_mode text NOT NULL,
  to_read_mode text NOT NULL,
  from_write_mode text NOT NULL,
  to_write_mode text NOT NULL,
  run_id uuid REFERENCES assignment_shadow_runs(run_id) ON DELETE RESTRICT,
  attestation_id uuid REFERENCES assignment_deploy_attestations(id) ON DELETE RESTRICT,
  -- Сборка и версия алгоритма на момент перехода: те же значения, что в аттестации, но записанные
  -- переходом — аттестацию можно потребить один раз, а журнал читают годами.
  build_sha text NOT NULL,
  algo_version text NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  -- Активация истории обязана опираться на поколение и аттестацию (О4). Обратный переход в
  -- `legacy` — нет: возврат бывает аварийным, и требовать от него поколения значило бы запирать
  -- откат ровно тогда, когда он нужен.
  CONSTRAINT assignment_periods_mode_transitions_history_check
    CHECK (to_read_mode <> 'history' OR (run_id IS NOT NULL AND attestation_id IS NOT NULL))
);

COMMENT ON TABLE assignment_periods_mode_transitions IS
  'Журнал переходов режима модуля (docs/assignment-periods-plan.md §6): append-only физически, '
  'доказательство «чем и когда разрешён переход», переживающее любые последующие смены режима.';

-- Журнал append-only физически (О5): правка и удаление отклоняются. Соглашения тут мало — журнал и
-- есть доказательство перехода, а доказательство, которое можно поправить, ничего не доказывает.
CREATE FUNCTION assignment_periods_transitions_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Журнал переходов режима неизменяем';
END
$$;

CREATE TRIGGER assignment_periods_transitions_immutable
  BEFORE UPDATE OR DELETE ON assignment_periods_mode_transitions
  FOR EACH ROW EXECUTE FUNCTION assignment_periods_transitions_immutable();

ALTER TABLE assignment_periods_mode_transitions
  ENABLE ALWAYS TRIGGER assignment_periods_transitions_immutable;

-- Аттестацию нельзя потребить дважды — физически, а не по договорённости с сервисом.
-- Однократность держали `consumed_at` и `FOR UPDATE` в двери; но дверь — код, который меняют, а
-- смысл аттестации в том, что переключение чтения разрешено ОДНИМ проверенным раскатом. Второй
-- переход по той же бумаге означал бы, что вторую проверку заменили ссылкой на первую.
CREATE UNIQUE INDEX assignment_periods_mode_transitions_attestation_unique
  ON assignment_periods_mode_transitions (attestation_id)
  WHERE attestation_id IS NOT NULL;
