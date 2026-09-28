-- Release note for the waybill journal site filter, release 113.
--
-- File number: `ls apps/api/drizzle` right before creation (28.09.2026) ended at 0343 in main, and a
-- parallel branch already holds 0344 (`0344_releases_shift_approvals_by_day.sql`, ADR 0210), so 0345
-- is the next free one across all trees. The same branch holds seq 112 and version 0.1.101.0210;
-- seq 113 and release 102 in the line are therefore the first unused ones.
--
-- THE TAIL REPEATS THE LAST DECISION IN MAIN (0209): the filter brings no decision of its own, and
-- ADR 0191 allows a release without one. The user chose this over 0210 on 28.09.2026 so that
-- `check:version` stays green in main without waiting for the ADR 0210 branch; that branch has to
-- move its release after this one (0.1.103.0210, seq 114, next free file) when it lands, otherwise
-- the tail would go backwards and VERSION in its commit would lag behind the latest release.
--
-- `adrs` names ADR 0192, not the tail: `app_releases_adrs_not_empty` requires a decision, and the
-- filter is built on that decision's derived waybill-to-order link (precedent: seq 99 lists 159).
--
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 113;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  113, '0.1.102.0209', '2026-09-28', 'Путевые листы: отбор по площадке', '{192}',
  '[
    {"kind":"feature","text":"В журнале путевых листов появился отбор «Площадка»: лист находится по объекту заказа любой из своих заявок, в том числе недельный лист ЭСМ-2"},
    {"kind":"improvement","text":"Лист, в котором стоят заявки нескольких площадок, находится по любой из них, а площадке и отделу в отборе предлагаются только их площадки"}
  ]'::jsonb
);
