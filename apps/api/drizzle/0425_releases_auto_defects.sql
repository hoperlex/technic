-- Fix wave AUTO: the Moscow start day for drivers entered after midnight (ADR 0008, migration
-- `0424_person_period_moscow_start_default.sql`), the lessor's search by rental number (ADR 0248),
-- the mechanization journal's «Виза» filter and the hint of the receipt deletion-mark window. No
-- schema change in this file.
-- The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 156;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  156, '0.1.145.0249', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Исправления: водители, механизация, чеки автозапчастей', '{8,248}',
  '[
    {"kind":"fix","text":"Водитель, заведённый после полуночи, числится работающим с текущего дня. Раньше датой начала работы вставал предыдущий день"},
    {"kind":"fix","text":"Арендодатель механизации находит аренду по номеру — «МХ-42», «мх42» или «42». Раньше поиск смотрел только модель, площадку, адрес и ответственного"},
    {"kind":"fix","text":"В журнале механизации работает отбор «Виза»: его учитывают таблица, итог и выгрузка. Раньше отбор выбирался, но список не менялся"},
    {"kind":"fix","text":"В окне «Пометить к удалению» исправлена подсказка: снять пометку можно в карточке чека, а удаляет чек только администратор. Раньше подсказка говорила, что и пометку снимает только администратор"}
  ]'::jsonb
);
