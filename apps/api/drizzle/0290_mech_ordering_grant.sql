-- Набор «Заказ механизации» и посев выдач: модуль аренды уходит из состава роли «Площадка» и
-- начинает выдаваться поимённо (план `docs/mechanization-approval-and-grants-plan.md`, Р7, Р9,
-- этап Э2; ADR 0175).
--
-- ОТКУДА НОМЕР. `ls apps/api/drizzle` перед созданием файла (08.09.2026): последней в дереве стоит
-- `0289_releases_orgtech_internal_repair.sql` соседнего потока, свободен 0290. Номер берётся в
-- момент создания и не резервируется заранее: за время работы над этим же этапом соседний поток
-- занял 0286 и 0289, а эта волна — 0288.
--
-- ПОЧЕМУ ЭТОТ ФАЙЛ ОБЯЗАН УЕХАТЬ ВМЕСТЕ С КОДОМ, А НЕ ПОСЛЕ НЕГО. Этим же релизом
-- `MECH_REQUEST_CUSTOMER_PERMISSIONS` снимаются с роли `site` (Р4, `packages/contracts/src/
-- permissions.ts`). Миграция накатывается ДО перезапуска приложения — и в этом весь расчёт: к
-- моменту, когда новый код перестанет давать модуль ролью, набор уже выдан, и доступ не меняется
-- ни у кого. Накати её после — площадки остались бы без «Механизации» на всё окно выката.
--
-- КОМУ И ЧТО ДОСТАЁТСЯ (Р9). Множества два, и механика у них разная:
--
--   1. все учётки с текущей ролью `site` — БЕЗ фильтра по `is_active` и `deleted_at` — получают
--      ДЕЙСТВУЮЩИЙ набор с новым происхождением `backfill`. Гейт совместимости им открыт (роль
--      набора — `site`), и модуль остаётся ровно тем, чем был, но уже отзывным. Фильтра нет
--      намеренно: выключенную учётку включают обратно, и вернуться она обязана с тем же доступом,
--      а не с молча отобранным модулем;
--   2. все снимки этапа 8 (`shtab`, `rukstroy`, `commandant`, миграция 0155) получают ВЗВЕДЁННЫЙ
--      набор с `origin = 'migration'` и ссылкой на снимок. До перевода он не действует и не
--      должен: модуль этим держателям по-прежнему даёт роль (Р7).
--
-- ТРЕТЬЕ ЗНАЧЕНИЕ `origin` — НЕ КОСМЕТИКА. Назвать посев `manual` значило бы соврать «выдал
-- администратор»; назвать `migration` нельзя — форма учётки намеренно запирает снятие таких
-- назначений галочкой (`lockedGrantIds`) как часть подготовленного перевода, и backfill повис бы
-- неснимаемым. `backfill` читается как «доступ сохранён при переводе модуля в назначаемый»,
-- показывается своей подписью и снимается теми же путями, что ручная выдача. CHECK
-- согласованности остаётся строгим: `migration_id IS NOT NULL` ровно у `origin = 'migration'`.
--
-- ПОЧЕМУ 0155 НЕ ПРАВИТСЯ ЗАДНИМ ЧИСЛОМ. Она применена на проде; forward-only миграция дополняет
-- её снимки и отдельно сеет backfill. Тем же транзакционным файлом идут два предохранителя
-- полноты и preflight предела назначений — все три ниже.
--
-- ОБРАТИМОСТЬ. Откат — снятие посеянного и заведённого, в этом порядке (ключ `user_grants.grant_id`
-- объявлен RESTRICT):
--   DELETE FROM user_grants WHERE grant_id = (SELECT id FROM grants WHERE code = 'mech_ordering');
--   DELETE FROM grant_roles       WHERE grant_id = (SELECT id FROM grants WHERE code = 'mech_ordering');
--   DELETE FROM grant_permissions WHERE grant_id = (SELECT id FROM grants WHERE code = 'mech_ordering');
--   DELETE FROM grants WHERE code = 'mech_ordering';
-- CHECK происхождения после этого можно вернуть к паре значений, но и оставленным он ничего не
-- ломает: строк с `backfill` после удаления посева не остаётся.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 0. Preflight: предел назначений (Р9).
--
-- `MAX_ASSIGNED_GRANTS = 32` (`packages/contracts/src/grants.ts`) — сколько наборов форма учётки
-- соглашается сохранить. Посев добавляет по одному обоим множествам, и учётка, у которой их уже
-- 32, оказалась бы в состоянии, которое форма потом не сохранит: администратор открыл бы её,
-- поправил телефон и получил отказ про полномочия, которых не трогал.
--
-- Поэтому счёт идёт ДО вставок и валит выкат со списком учёток. Лечение — снять действительно
-- лишний набор до повторного выката либо отдельно пересмотреть предел. Число связано с константой
-- db-тестом (`grants-preflight.db.test.ts`): разъехавшись, они дали бы молчаливое расхождение.
--
-- Считается будущий максимум: нынешние назначения плюс один, и только у тех, кому набор реально
-- достанется (учётка на роли `site` либо снимок этапа 8, у которых его ещё нет).
DO $$
DECLARE
  overflow text;
BEGIN
  SELECT string_agg(u.email, ', ' ORDER BY u.email) INTO overflow
  FROM users u
  WHERE (
      u.role = 'site'
      OR EXISTS (SELECT 1 FROM user_role_migration m WHERE m.user_id = u.id AND m.stage = 8)
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_grants ug
      JOIN grants g ON g.id = ug.grant_id
      WHERE ug.user_id = u.id AND g.code = 'mech_ordering'
    )
    AND (SELECT count(*) FROM user_grants ug WHERE ug.user_id = u.id) + 1 > 32;

  IF overflow IS NOT NULL THEN
    RAISE EXCEPTION 'Предел назначений (MAX_ASSIGNED_GRANTS = 32) будет превышен у учёток: %', overflow;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Третье значение происхождения — до посева, иначе его же строки не пройдут CHECK.
ALTER TABLE user_grants DROP CONSTRAINT IF EXISTS user_grants_origin_check;
ALTER TABLE user_grants
  ADD CONSTRAINT user_grants_origin_check CHECK (origin IN ('manual', 'migration', 'backfill'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Сам набор. Описание — абзац для администратора: оно объясняет работу, а не перечисляет права
--    (перечень он видит рядом на экране каталога).
--
-- `ON CONFLICT (code) DO UPDATE` — не «на всякий случай»: повторный накат на базу, восстановленную
-- из копии, обычное дело, и миграция обязана довести каталог до объявленного состояния.
INSERT INTO grants (code, name, description, is_system) VALUES
  (
    'mech_ordering',
    'Заказ механизации',
    'Аренда малой механизации глазами площадки: завести заявку на виброплиту, компрессор или '
    'тепловую пушку, поправить её и снять, пока аренда не началась. Ход аренды — выдачу, возврат и '
    'продление — набор не открывает: их решает офис. Подписи в наборе тоже нет: визирует аренду '
    'тот, кто отвечает за площадку, и его подпись живёт в наборе «Виза объекта». Набор нужен '
    'должностям площадки: у роли «Площадка» модуля больше нет, и каждому человеку он выдаётся '
    'поимённо.',
    true
  )
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Состав — четыре права заказчика (Р7). Хода аренды (`.status`) и продления (`.extend`) здесь
--    нет: набор, раздавший бы их площадке, отвечал бы за заказчика на вопрос, которого он не
--    задавал. Визы (`mechRequests.approve`) нет тем более — она в «Визе объекта» и «Визе отдела».
INSERT INTO grant_permissions (grant_id, permission)
SELECT g.id, s.permission
FROM grants g
JOIN (VALUES
  ('mech_ordering', 'mechRequests.read'),
  ('mech_ordering', 'mechRequests.create'),
  ('mech_ordering', 'mechRequests.update'),
  ('mech_ordering', 'mechRequests.delete')
) AS s (code, permission) ON s.code = g.code
ON CONFLICT (grant_id, permission) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Совместимая роль одна — `site`, целевая роль реформы.
--
-- Упраздняемых трёх здесь нет, и это не осторожность, а действующее правило: ролевой набор не
-- объявляется совместимым с упраздняемой ролью (страж `role-migration-contracts.test.ts`), иначе
-- релиз, который никого не переводит, расширил бы множество того, что вообще можно выдать. Отсюда
-- прямое следствие, названное планом: до перевода учёток модуль остаётся по роли у `shtab`,
-- `rukstroy` и `commandant`, а набор приезжает им взведённым (шаг 6).
INSERT INTO grant_roles (grant_id, role)
SELECT g.id, 'site'::role
FROM grants g
WHERE g.code = 'mech_ordering' AND g.deleted_at IS NULL
ON CONFLICT (grant_id, role) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Backfill действующим `site` — множество 1 (Р9).
--
-- `granted_by` остаётся NULL: выдачи не было — не было и того, кто её сделал. `granted_at` —
-- момент наката, и это правда о том, когда назначение появилось.
INSERT INTO user_grants (user_id, grant_id, granted_by, origin, migration_id)
SELECT u.id, g.id, NULL, 'backfill', NULL
FROM users u
CROSS JOIN grants g
WHERE u.role = 'site' AND g.code = 'mech_ordering' AND g.deleted_at IS NULL
ON CONFLICT (user_id, grant_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Взведённые назначения снимкам этапа 8 — множество 2 (Р8, Р9).
--
-- Все три площадочные роли, а не две: `commandant` до плана визы получал по переводу пустой список
-- (миграция 0155), а теперь получает ровно этот набор — аренду он ведёт наравне с прочей
-- площадкой, и у роли `site` её больше нет. Соответствие «прежняя роль → наборы» объявлено в
-- контрактах (`ROLE_MIGRATIONS`) и переписано сюда строкой: миграция не умеет спрашивать
-- TypeScript, а что копии не разъедутся, следит `role-migration-prepare.db.test.ts`.
INSERT INTO user_grants (user_id, grant_id, granted_by, origin, migration_id)
SELECT m.user_id, g.id, NULL, 'migration', m.id
FROM user_role_migration m
CROSS JOIN grants g
WHERE m.stage = 8
  AND m.role_before IN ('shtab', 'rukstroy', 'commandant')
  AND g.code = 'mech_ordering'
  AND g.deleted_at IS NULL
ON CONFLICT (user_id, grant_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Два предохранителя полноты — в самом накате, а не в тестах.
--
-- Тесты живут в репозитории, а этот блок идёт вместе с базой: несовпадение роняет миграцию ДО
-- перезапуска приложения, которое снимет модуль из матрицы. После перезапуска ту же проверку
-- повторяет рабочим кодом `pnpm --filter @technic/api check:role-migration`.
DO $$
DECLARE
  missing_site integer;
  missing_armed integer;
BEGIN
  SELECT count(*) INTO missing_site
  FROM users u
  WHERE u.role = 'site'
    AND NOT EXISTS (
      SELECT 1 FROM user_grants ug
      JOIN grants g ON g.id = ug.grant_id
      WHERE ug.user_id = u.id AND g.code = 'mech_ordering' AND ug.origin <> 'migration'
    );
  IF missing_site > 0 THEN
    RAISE EXCEPTION 'У % учёток роли «Площадка» нет действующего набора «Заказ механизации»', missing_site;
  END IF;

  SELECT count(*) INTO missing_armed
  FROM user_role_migration m
  WHERE m.stage = 8
    AND NOT EXISTS (
      SELECT 1 FROM user_grants ug
      JOIN grants g ON g.id = ug.grant_id
      WHERE ug.user_id = m.user_id AND g.code = 'mech_ordering' AND ug.origin = 'migration'
    );
  IF missing_armed > 0 THEN
    RAISE EXCEPTION 'У % снимков этапа 8 нет взведённого набора «Заказ механизации»', missing_armed;
  END IF;
END $$;
