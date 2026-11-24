-- ADR 0107, owner decision S-13: live-order linear-mode switching is permanent. The comments
-- installed by 0137 describe a cancelled removal sequence; replace metadata without changing data.
-- 0137 itself stays as applied: it is history, and editing it would not reach any live database.
--
-- WHERE THE NUMBER CAME FROM. Prepared on 15.10.2026 as `drizzle/pending/` SQL; promoted on
-- 24.11.2026 after `ls apps/api/drizzle`, `git ls-tree origin/main apps/api/drizzle/` and every
-- local branch and worktree showed `0425_releases_auto_defects.sql` as the last taken number. Only
-- this header was extended at promotion; the statements are the reviewed ones.
--
-- WHY NO LOCK TIMEOUT. COMMENT ON COLUMN takes SHARE UPDATE EXCLUSIVE on the table, which does not
-- conflict with the portal's reads, writes or row locks, so the old release keeps serving while it
-- runs and nothing queues behind it. Nothing changes for old code: it never reads column comments.
COMMENT ON COLUMN vehicle_requests.is_linear_frozen IS
  'Previous linear mode for a request caught in progress by a vehicle type mode switch. NULL means the request follows the live vehicle type. The value is cleared when the request leaves In progress. Switching under live requests remains available, so the column is permanent (ADR 0107, S-13).';

COMMENT ON COLUMN vehicle_requests.linear_frozen_at IS
  'Time of the switch that left this in-progress request on its previous linear mode. It is cleared together with is_linear_frozen. Switching under live requests remains available (ADR 0107, S-13).';
