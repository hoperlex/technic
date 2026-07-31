-- Пожелание «Комендант» требует объекта — как и остальные пожелания об объектных ролях.
--
-- Продолжение миграции 0067: значение enum там, ссылка на него — здесь. CHECK сравнивает
-- `requested_role` с литералом, а добавленное значение enum нельзя использовать в той же
-- транзакции, которая его добавила.
--
-- Смысл проверки прежний (0057): комендант работает в пределах своего объекта, и заявку на
-- регистрацию без объекта всё равно не рассмотреть — активировать такую учётку API не даст.
ALTER TABLE users
  DROP CONSTRAINT users_requested_object_check,
  ADD CONSTRAINT users_requested_object_check CHECK (
    requested_role IS NULL
    OR requested_role NOT IN ('rukstroy', 'site_staff', 'commandant')
    OR btrim(requested_object) <> ''
  );
