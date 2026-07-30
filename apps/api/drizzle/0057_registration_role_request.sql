-- Пожелание по роли в заявке на регистрацию (ADR 0034).
--
-- Администратор рассматривал заявку, зная только ФИО и email: кто этот человек и зачем ему
-- доступ — не сказано нигде, и роль приходилось выяснять звонком. Теперь при регистрации
-- человек выбирает, кем работает, а объект или компанию пишет строкой.
--
-- Это ПОЖЕЛАНИЕ, а не роль: роль назначает администратор при активации и только он
-- (`users.role` остаётся NULL до этого). Иначе саморегистрация выдавала бы права, и признак
-- «заявка = не активна и без роли» перестал бы работать.
--
-- Объект и компания — свободный текст, а не FK: чтобы выбрать объект из справочника, список
-- объектов пришлось бы отдавать неаутентифицированному, то есть любому, кто откроет страницу
-- регистрации. Перечень строек компании этого не стоит; сопоставить написанное со справочником
-- администратор может и глазами — он всё равно рассматривает заявку вручную.

-- 1. Варианты пожелания. Это не `role`: два значения соответствий в портале не имеют
--    (`vehicle_lessor` — арендодатель техники, роли для него нет; `other` — «не из списка»),
--    а `site_staff` называется на языке заявителя, а не таблицы прав («Штаб»).
CREATE TYPE registration_role_request AS ENUM (
  'dispatcher',
  'rukstroy',
  'site_staff',
  'waste_operator',
  'vehicle_lessor',
  'other'
);

-- 2. Поля заявки. NULL в `requested_role` — учётка, заведённая администратором вручную:
--    пожелания у неё нет и быть не может.
ALTER TABLE users
  ADD COLUMN requested_role registration_role_request,
  ADD COLUMN requested_object text NOT NULL DEFAULT '',
  ADD COLUMN requested_company text NOT NULL DEFAULT '';

-- 3. Уточнение обязательно там, где без него пожелание бессмысленно: объектные роли работают в
--    пределах объекта (ADR 0025), а оператор — от лица контрагента (ADR 0010), и активировать
--    такую учётку, не зная объекта или компании, всё равно нельзя. Проверка сформулирована от
--    `requested_role IS NOT NULL`, поэтому учёток без пожелания не касается.
ALTER TABLE users
  ADD CONSTRAINT users_requested_object_check CHECK (
    requested_role IS NULL
    OR requested_role NOT IN ('rukstroy', 'site_staff')
    OR btrim(requested_object) <> ''
  ),
  ADD CONSTRAINT users_requested_company_check CHECK (
    requested_role IS NULL
    OR requested_role NOT IN ('waste_operator', 'vehicle_lessor')
    OR btrim(requested_company) <> ''
  );

-- 4. Под вкладку «Ожидают активации»: заявок в списке единицы, но частичный индекс здесь
--    бесплатен и снимает полный проход по users при каждом открытии вкладки и подсчёте бейджа.
CREATE INDEX users_pending_registration_idx ON users (created_at DESC)
  WHERE deleted_at IS NULL AND is_active = false AND role IS NULL;
