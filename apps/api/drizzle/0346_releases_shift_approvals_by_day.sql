-- Release note for object sign-offs by day under an assignment change (ADR 0210), release 114.
--
-- Numbers (user's decision of 28.09.2026, recorded in 0345): the waybill site filter took 0345,
-- seq 113 and 0.1.102.0209 while this release still lived on its branch, so this one goes after
-- it — 0346 is the first free file after 0345, seq 114 follows 113, and 0.1.103.0210 continues the
-- line counter (102 -> 103) with this release's own decision as the tail. The file was drafted as
-- 0344 on the branch and never reached any database under that name; 0344 stays unused.
--
-- What the entry promises: only what a dispatcher and an object see — which sign-offs a backdated
-- vehicle correction clears and which ones still lock an ordinary change of vehicle (one entry for
-- both: they are one rule). The rule's single carrier on the server (shift-approval-scope.ts) is
-- described in ADR 0210, not here.
--
-- Schema is untouched: this file only writes the feed, so it survives the window when the old
-- application still runs.
--
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 114;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  114, '0.1.103.0210', '2026-09-28', 'Подписи объекта и смена техники — по дням', '{210}',
  '[
    {"kind":"improvement","text":"Исправление задним числом «работала другая машина» больше не снимает подписи объекта с дней, которые шли отдельным рейсом: машину такого дня правят в самом рейсе"},
    {"kind":"improvement","text":"Подписи с дней без рейса снимаются как и прежде — теперь и у линейной техники: такой день отработала машина заявки, и принять его объекту нужно заново"},
    {"kind":"improvement","text":"Обычную смену техники больше не запирают подписанные дни, которые шли отдельным рейсом: запирают только дни, отработанные машиной заявки. При смене на арендную машину по-прежнему запирает любой подписанный день"},
    {"kind":"improvement","text":"Окно смены техники и исправление отрезка истории называют одни и те же дни, с которых слетит подпись"}
  ]'::jsonb
);
