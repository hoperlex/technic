-- Release note for the current place of office equipment in service requests (ADR 0215),
-- release 116.
--
-- File number: `ls apps/api/drizzle` immediately before creation (29.09.2026) ended at 0348;
-- no branch or worktree held 0349. seq 116 follows 115 (0348); the version keeps the 0.1 line
-- counter going (104 -> 105) with ADR 0215 as its tail.
--
-- What the entry promises: only visible request behaviour. The request keeps its filed site for
-- scope and history, while executors see where the unit stands now after a recorded move.
--
-- Schema is untouched: this file only writes the feed, so it survives the window when the old
-- application still runs.
--
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 116;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  116, '0.1.105.0215', '2026-09-29',
  'Оргтехника: заявка показывает, где аппарат стоит сейчас', '{215}',
  '[
    {"kind":"fix","text":"После перемещения аппарата открытая заявка, строка списка и письмо исполнителю показывают, где он стоит сейчас; заявленное место остаётся рядом и продолжает задавать область и отбор заявки"},
    {"kind":"fix","text":"Если заявитель указал другую площадку, заявка больше не подставляет к ней старый кабинет из карточки аппарата"}
  ]'::jsonb
);
