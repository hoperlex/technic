-- Omitted period starts default to the Moscow calendar day (ADR 0008).
--
-- WHY. The driver route and the staff import omit `started_on` when the source has no employment
-- date, so the column default decides the day. Sessions run in UTC, and between 00:00 and 03:00
-- Moscow time CURRENT_DATE is still the previous day: a driver entered at night started
-- "yesterday", was counted as employed one day early in dated selection, and the staff export
-- printed that day. The explicit Moscow conversion fixes both employment and specialization
-- periods. Existing rows are not changed (owner's decision, 24.11.2026: no backfill).
--
-- WHERE THE NUMBER CAME FROM. Prepared on 15.10.2026 as `drizzle/pending/` SQL; promoted on
-- 24.11.2026 after `ls apps/api/drizzle` and `git ls-tree origin/main apps/api/drizzle/` showed
-- `0423_releases_candidate_place.sql` as the last taken number. Only this header was rewritten at
-- promotion; the statements are the reviewed ones. Tests find this file by its suffix, so a
-- renumbering at push time breaks nothing.
--
-- WHY IT SURVIVES THE DEPLOY WINDOW (migrations run while the old release serves — AGENTS.md,
-- `docs/runbook.md`):
--   · the column type and nullability do not change; old code that omits the date simply gets the
--     Moscow default, and old code that sends a date is unaffected;
--   · the one residual case: a driver created after Moscow midnight and removed by the OLD removal
--     code (which ends periods with the UTC day) in the minutes between this migration and the
--     restart. The UTC end day precedes the Moscow start day, CHECK `ended_on >= started_on` fails
--     inside the removal transaction, it rolls back completely, and the same removal succeeds
--     after the restart (the new code ends periods with the Moscow day).
--
-- REVERSIBILITY. The old image refuses a schema newer than itself, so after this migration
-- `--previous` cannot boot: forward fix or PITR (runbook, «Limit of code-only `--previous`»).
--
-- LOCKS. ALTER COLUMN SET DEFAULT takes ACCESS EXCLUSIVE briefly on each table. A long reader must
-- not queue portal traffic behind it: after 10 s this file gives up with 55P03 and rolls back while
-- the old API keeps serving; the deploy can be retried once the blocking transaction has ended.
-- Specializations are locked first, then employments: both the driver route and the staff import
-- insert in that order inside their transactions, and the reverse DDL order could deadlock with an
-- insert crossing the two tables. The runner wraps each migration in one transaction, so `SET LOCAL`
-- holds to its end.
SET LOCAL lock_timeout = '10s';

ALTER TABLE person_specializations
  ALTER COLUMN started_on SET DEFAULT (now() AT TIME ZONE 'Europe/Moscow')::date;

ALTER TABLE person_employments
  ALTER COLUMN started_on SET DEFAULT (now() AT TIME ZONE 'Europe/Moscow')::date;
