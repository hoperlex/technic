-- Release note for the three-volume waste statistics (ADR 0209), release 111.
--
-- File number: `ls apps/api/drizzle` right before creation (25.09.2026) ended at 0342, 0343 was free.
-- seq 111 is the first unused sequence in the repository (0342 holds 110); the version keeps the
-- 0.1 line counter going (99 -> 100) with the number of the last included decision as its tail.
--
-- What the entry promises: only what a user sees in the "Statistics" tab (decision Z12). The book
-- change of the same release — a request returned from "done" to work no longer counts as removed —
-- is described in ADR 0209 and in the caveats of the export form, not here.
--
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 111;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  111, '0.1.100.0209', '2026-09-25', 'Статистика вывоза: заказано, вывезено и подтверждено талонами', '{209}',
  '[
    {"kind":"feature","text":"Во вкладке «Статистика» вывоза мусора вместо одного объёма — три: «Заказано» (все действующие заявки месяца, включая новые), «Вывезено» (выполненные и завершённые) и «По талонам» (объём принятых талонов)"},
    {"kind":"feature","text":"«Стоимость» показывает сумму вывезенного, а под ней — плановую стоимость и стоимость подтверждённого талонами"},
    {"kind":"improvement","text":"Итог по всем площадкам стоит строкой «Итого» внизу таблицы, а сведения о качестве данных — над ней"}
  ]'::jsonb
);
