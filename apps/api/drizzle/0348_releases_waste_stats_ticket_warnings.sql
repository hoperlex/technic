-- Release note for the waste statistics warnings and the ticket figure (ADR 0213), release 115.
--
-- File number: `ls apps/api/drizzle` right before creation (29.09.2026) ended at 0347 in main, and no
-- branch or worktree holds 0348. seq 115 follows 114 (0346, now in main); the version keeps the 0.1
-- line counter going (103 -> 104) with ADR 0213 as its tail.
--
-- What the entry promises: only what a user sees in the "Statistics" tab. The repricing of 2026
-- requests (0347) is a data correction and is not announced here.
--
-- Schema is untouched: this file only writes the feed, so it survives the window when the old
-- application still runs.
--
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 115;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  115, '0.1.104.0213', '2026-09-29', 'Статистика вывоза: значки вместо оговорок, талоны целиком', '{213}',
  '[
    {"kind":"improvement","text":"Во вкладке «Статистика» вывоза мусора оговорки «без цены …» больше не стоят под суммами: неполная сумма отмечена значком, а в подсказке сказано, какой объём остался без цены и откуда берётся цена"},
    {"kind":"improvement","text":"«По талонам» считает и распознанные, но ещё не подтверждённые талоны; значок рядом подсказывает, сколько талонов не подтверждено и сколько файлов не удалось распознать"}
  ]'::jsonb
);
