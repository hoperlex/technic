-- The moment a request entered «Решена» (`done`) — the anchor of the auto-close window, kept apart
-- from the date of completion (ADR 0174, section "Workflow-fixes wave 1"; plan
-- `docs/office-equipment-workflow-fixes-plan.md`, Н14).
--
-- WHY A COLUMN. The auto-close counted its 24 hours from `completed_at`, and `completed_at` stores
-- the CHOSEN date of completion at midnight, not a moment: a request closed with yesterday's date
-- was mature the second it entered «Решена», and the customer's objection window never opened.
-- The two notions part: `completed_at` is the date of the work (the card, the warranties),
-- `done_at` is the moment of the transition (the objection window). The code writes `done_at` on
-- every real entry into `done` and clears it on leaving; a later change of the completion date
-- never touches it, so the window cannot be moved by editing the date of the work.
--
-- BACKFILL — ONLY THE ROWS IN «РЕШЕНА». Nothing reads the column outside that status, and the new
-- code keeps it empty there. The anchor is the LAST REAL entry into `done` from the status
-- history: `from_status IS DISTINCT FROM 'done'` skips the `done → done` rows the module writes for
-- moves that keep the status, which would otherwise shift the anchor to an unrelated moment.
-- Without history the fallback is `GREATEST(status_changed_at, completed_at)` and NOT
-- `completed_at`: the original defect lives in `completed_at`, and an extra day of waiting is
-- cheaper than an acceptance nobody saw.
--
-- DEPLOY WINDOW. Migrations run while the previous server (`dc647215`) still serves. It neither
-- reads nor writes the column (drizzle names its columns), so a request it moves into «Решена»
-- between this file and the restart keeps `done_at` empty. The new reader takes
-- `COALESCE(done_at, status_changed_at)`, and `status_changed_at` is written by every transition of
-- the old code too — such a row matures 24 hours after its real transition, it neither hangs nor
-- closes at once (`service-request-auto-close.db.test.ts`, the old writer case). No constraint ties
-- the column to the status for the same reason: the old code leaves `done` without clearing it.
--
-- KNOWN RESIDUAL. The paragraph above holds for a request the old server moves into «Решена» from
-- another status. A request that is ALREADY in «Решена» at the backfill gets a non-empty `done_at`,
-- and if the old server re-enters `done` with it inside the window (rework and close again, hold and
-- resume, accepted → done), it writes `status_changed_at` but not the column — the stale backfilled
-- value wins and that one request can mature at the next five-minute tick: it may close early. The
-- window is minutes long; the backfill is kept on purpose (docs/runbook.md, section on the
-- auto-close, names the manual repair).
--
-- REVERSIBILITY: additive. A code rollback ignores the column; `DROP COLUMN` is never needed for it.

-- ── Lock timeout ──
--
-- `ADD COLUMN` takes ACCESS EXCLUSIVE on `service_requests`, held through the backfill. Migrations
-- run while the previous release serves (`docs/runbook.md`), so a long transaction on that table
-- makes this request wait, and every later query that conflicts with it queues behind the waiting
-- request: the portal hangs with no error. With the timeout the wait ends after 10 s with SQLSTATE
-- 55P03 "canceling statement due to lock timeout": the file rolls back whole, `deploy-auto` stops
-- before the restart, the old release keeps serving, and the same deploy is rerun (runbook, "A
-- migration fails with canceling statement due to lock timeout"). `SET LOCAL` ends with this file
-- only because the runner wraps each file in its own transaction (`applyMigrations`,
-- `apps/api/src/db/migration-journal.ts`); outside a transaction it would do nothing.
SET LOCAL lock_timeout = '10s';

ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS done_at timestamptz;

COMMENT ON COLUMN service_requests.done_at IS
  'Moment of the last real entry into «Решена» (done); NULL outside done. The auto-close anchor, '
  'read as COALESCE(done_at, status_changed_at). Never moved by a change of the completion date (ADR 0174).';

UPDATE service_requests r
   SET done_at = COALESCE(
         (SELECT max(h.changed_at)
            FROM service_request_status_history h
           WHERE h.request_id = r.id
             AND h.to_status = 'done'
             AND h.from_status IS DISTINCT FROM 'done'),
         GREATEST(r.status_changed_at, r.completed_at))
 WHERE r.status = 'done'
   AND r.done_at IS NULL;

-- Fail-fast guard (owner decision S-10): every request in «Решена» has its anchor now. It cannot
-- plausibly fire — `status_changed_at` is NOT NULL, so the fallback is never NULL — and exists to
-- stop the migration with the request numbers if that reasoning is ever broken.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg('СО-' || num, ', ' ORDER BY num)
    INTO missing
    FROM (SELECT num FROM service_requests
           WHERE status = 'done' AND done_at IS NULL
           ORDER BY num LIMIT 20) m;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'service_requests.done_at is empty for requests in «Решена»: %', missing;
  END IF;
END $$;
