-- ФИО учётной записи по частям (ADR 0034): фамилия, имя, отчество вместо одной строки.
--
-- До сих пор users.full_name был свободным текстом: «Иванов И.И.», «иван иванов», «Иванов Иван
-- Иванович» — всё это разные строки об одном человеке. Сортировка шла не по фамилии, короткой
-- формы «Иванов И. И.» неоткуда было взять, а сверить учётку с физлицом (persons, ADR 0008)
-- можно было только глазами.
--
-- Форма та же, что у persons (миграция 0018): три колонки плюс full_name как GENERATED STORED.
-- Колонка остаётся на месте и остаётся единственной точкой правды для чтения — поэтому все
-- существующие выборки (actor_name в истории заявок и аудите, created_by_name, поиск и
-- сортировка в списке пользователей) не меняются вовсе. Меняются только места записи.
--
-- Отличие от persons — в выражении: там простой btrim, потому что имя не может быть пустым по
-- CHECK. Здесь имя пустым быть может (см. п. 3), и btrim оставил бы двойной пробел внутри
-- строки: 'Иванов' || ' ' || '' || ' ' || 'Иванович'. Поэтому пробелы схлопываются regexp_replace
-- (IMMUTABLE, в generated-колонке допустим).

-- 1. Части ФИО. DEFAULT '' нужен только на время бэкфилла: существующие строки должны чем-то
--    заполниться до того, как на фамилию встанет CHECK.
ALTER TABLE users
  ADD COLUMN last_name text NOT NULL DEFAULT '',
  ADD COLUMN first_name text NOT NULL DEFAULT '',
  ADD COLUMN middle_name text NOT NULL DEFAULT '';

-- 2. Разбор накопленных ФИО: первое слово — фамилия, второе — имя, весь остаток — отчество.
--    Остаток берётся целиком, а не третьим словом: «Иванов Иван Иванович оглы» и двойные имена
--    иначе потеряли бы хвост, а терять введённое пользователем нельзя.
-- coalesce на фамилии обязателен: у ФИО из одних пробелов string_to_array даёт пустой массив,
-- и arr[1] — это NULL, а не пустая строка. Такую строку подхватит шаг 2a.
UPDATE users
SET
  last_name = coalesce(parts.arr[1], ''),
  first_name = coalesce(parts.arr[2], ''),
  middle_name = coalesce(array_to_string(parts.arr[3:], ' '), '')
FROM (
  SELECT
    id,
    string_to_array(btrim(regexp_replace(full_name, '\s+', ' ', 'g')), ' ') AS arr
  FROM users
) AS parts
WHERE users.id = parts.id;

-- 2a. Страховка от пустого ФИО. Через контракты такая запись пройти не могла (min 2 символа),
--     но CHECK на full_name никогда не стоял, и уронить миграцию на чужой базе из-за одной
--     битой строки нельзя. Локальная часть email — не выдумка, а единственное, что о таком
--     пользователе достоверно известно; администратор увидит её в списке и дозаполнит.
UPDATE users
SET last_name = split_part(email, '@', 1)
WHERE btrim(last_name) = '';

-- 3. Фамилия обязательна. Имя — нет: в базе есть учётки, заведённые одним словом (первый
--    администратор из seed:admin — «Администратор»), и CHECK на имя эту миграцию бы уронил.
--    Новые и редактируемые записи имя требуют — на уровне контракта (@technic/contracts).
--    Симметричный CHECK добавится отдельной миграцией, когда такие учётки будут дозаполнены.
ALTER TABLE users
  ADD CONSTRAINT users_last_name_not_blank CHECK (btrim(last_name) <> '');

-- 4. full_name становится вычисляемой. Индекс живёт на колонке и падает вместе с ней —
--    пересоздаётся ниже.
DROP INDEX users_full_name_trgm;
ALTER TABLE users DROP COLUMN full_name;
ALTER TABLE users
  ADD COLUMN full_name text
  GENERATED ALWAYS AS (btrim(regexp_replace(last_name || ' ' || first_name || ' ' || middle_name, '\s+', ' ', 'g'))) STORED NOT NULL;
CREATE INDEX users_full_name_trgm ON users USING gin (full_name gin_trgm_ops);

-- 5. Части ФИО больше не нуждаются в DEFAULT: фамилию и имя всегда пишет приложение, а
--    отчество опционально и пустая строка для него — законное значение, а не «не заполнено».
ALTER TABLE users
  ALTER COLUMN last_name DROP DEFAULT,
  ALTER COLUMN first_name DROP DEFAULT;
