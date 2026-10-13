-- The right `serviceRequests.cancel` in the permission catalog: the IT service cancels a request
-- with its own right, and the right goes to the system set "Оргтехника: ИТ-служба"
-- (`office_equipment_it_approver`) and to no other (workflow-fixes plan
-- `docs/office-equipment-workflow-fixes-plan.md`, Р2, stage Э5; ADR 0174, wave 2).
--
-- WHERE THE NUMBER CAME FROM. `ls apps/api/drizzle` and `git ls-tree origin/main` right before the
-- file was created (13.10.2026): the last file was `0378_releases_service_request_estimate_author.sql`.
-- A parallel stream may take 0379 before this lands; the integrator renumbers, and neither the code
-- nor the tests name the number (the test finds the file by its suffix).
--
-- WHY A RIGHT OF ITS OWN. The owner's walkthrough of 08.09.2026: the IT service cannot cancel a
-- request with a comment. The cancel arcs belong to the operator corridor and are opened by
-- `serviceRequests.status`, which the IT service does not have and must not have: together with the
-- cancel it opens the acceptance of the work, the return for rework and, paired with
-- `requests.rollbackStatus`, the administrative rollbacks — exactly what the same walkthrough
-- (item 6) asked to take away from it. The new right opens ONLY the three cancelling arcs
-- (`SERVICE_CANCEL_TRANSITIONS`: «Новая», «В работе», «Отложена» → «Отменена»); the reason, and for
-- a repair the decision "what we do instead", are asked by the cancel window as for everyone.
--
-- WHAT THE MIGRATION DOES.
--
--   · appends the right to ONE system set by code — `office_equipment_it_approver`. The code is
--     stable forever, migrations of the catalog, the journal of actions and the register of grants
--     find a set by it;
--   · changes nothing else: not the roles (the matrix lives in the code and arrives with the
--     release of the server; the administrator gets the right with the full dictionary), not
--     `grant_roles`, not one row of `user_grants`. Who holds the set is the administrator's decision,
--     taken by name (ADR 0106); this file edits the composition, not the grants — and the guard
--     below checks it by comparing numbers against a snapshot, not by promising;
--   · does not touch "Ведение" (`office_equipment_operator`): it holds `serviceRequests.status`
--     and cancels with it. One person with the same arc from two sources would read as two sources
--     of one decision.
--
-- WINDOW OF THE ROLL-OUT. The migration runs while the portal is up and BEFORE the application
-- restarts, so for a while only the OLD server reads the catalog with the new row. It is safe, and
-- that is checked, not assumed: the old server filters a permission code it does not know at the
-- "database to code" boundary (`isPermission` in `loadPrincipal` and in the session builder), so a
-- holder's session is built from the codes it knows and nothing breaks — the same mechanism that
-- has always carried the rows of a right removed from the dictionary
-- (`apps/api/test/auth-permissions.db.test.ts`, "RETIRED_PERMISSION"). The right does nothing for
-- the old server, and the holders get the door when the new one starts. The sessions of the holders
-- are NOT invalidated (`auth_version` stays): a right is added, not taken away, the server computes
-- the permissions on every request, and the portal learns the new list with the next session
-- response — the cancel item appears after a reload, the server accepts the move earlier. The
-- migrations that REMOVE a right from a set do bump `auth_version` (0304) — that is the other
-- direction.
--
-- THE GUARD CANNOT FIRE ON ANY DATA, BY CONSTRUCTION. It is relative: it compares the state after the
-- insert with the snapshot taken before it, and with the migration's own intent — never with a
-- hard-coded size of a set. A fixed "the set has N rights" would fire on a database where the
-- previous catalog migrations were applied differently, and a guard that can plausibly fire ships in
-- a release of its own. This one can fire only if the INSERT itself did something other than it
-- says (the set is missing, the right landed in a second system set, a grant row appeared or
-- vanished) — and then the right answer is to stop before the restart.
--
-- REVERSIBILITY. The schema does not change; one row of one catalog table. Rollback — `DELETE` of
-- the row with `permission = 'serviceRequests.cancel'` for this set, together with the rollback of
-- the contracts (an orphan row is filtered by the reader, but the catalog guard test would go red).
-- The right without a door and the door without a right are equally safe: `can()` answers a refusal
-- to an unknown right.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 0. Snapshot BEFORE the edit: how many rights the set has, and how many holders every system set
-- of the module has — for the statement "the composition is edited, the grants are not".
--
-- `ON COMMIT DROP`: the table lives until the end of the migration's transaction and does not stay
-- in the database. A snapshot and not a constant: the sets are issued to live accounts, and the
-- numbers "before" differ between production, a developer's database and one restored from a copy.

CREATE TEMP TABLE grant_snapshot_0379 ON COMMIT DROP AS
SELECT g.code,
       (SELECT count(*) FROM grant_permissions gp WHERE gp.grant_id = g.id)::bigint AS rights,
       (SELECT count(*) FROM user_grants ug WHERE ug.grant_id = g.id)::bigint AS holders,
       EXISTS (SELECT 1 FROM grant_permissions gp
                WHERE gp.grant_id = g.id
                  AND gp.permission = 'serviceRequests.cancel') AS had_cancel
  FROM grants g
 WHERE g.is_system;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The cancel — to the IT service, and only to it.
--
-- The right is stored as text: there is no directory of rights in the database on purpose
-- (`grant_permissions`, migration 0145), the dictionary `PERMISSIONS` is closed and lives in the
-- contracts. `ON CONFLICT DO NOTHING` makes the step idempotent: a second run on a database
-- restored from a copy is routine, and the migration must bring the catalog to the declared state,
-- not fail.

INSERT INTO grant_permissions (grant_id, permission)
SELECT g.id, 'serviceRequests.cancel'
  FROM grants g
 WHERE g.code = 'office_equipment_it_approver'
   AND g.is_system
ON CONFLICT (grant_id, permission) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The guard: the state after the insert against the snapshot and against the intent.
--
-- The catalog guard test compares the catalog with the contracts, but it lives in the repository,
-- and this block lives in the roll-out: the operator of the release sees a divergence at once, not
-- after the next test run. It is counted AFTER the insert, so a second run passes it as the first.

DO $$
DECLARE trouble text;
BEGIN
  SELECT string_agg(msg, '; ')
    INTO trouble
    FROM (
      SELECT 'the system set office_equipment_it_approver is missing — nothing to hand the right to'
              AS msg
       WHERE NOT EXISTS (SELECT 1 FROM grants WHERE code = 'office_equipment_it_approver' AND is_system)
      UNION ALL
      -- The right is in the IT set after the step.
      SELECT 'the right serviceRequests.cancel is not in office_equipment_it_approver — the insert did not take'
       WHERE EXISTS (SELECT 1 FROM grants WHERE code = 'office_equipment_it_approver' AND is_system)
         AND NOT EXISTS (
           SELECT 1
             FROM grants g
             JOIN grant_permissions gp ON gp.grant_id = g.id
            WHERE g.code = 'office_equipment_it_approver'
              AND gp.permission = 'serviceRequests.cancel')
      UNION ALL
      -- "And to no other": the lock of the decision. User-built sets are not covered by the ban:
      -- the model of ADR 0106 lets an administrator put any right into his own set, and the barrier
      -- of requirements accepts it together with the module read in the account's total.
      SELECT format('the right serviceRequests.cancel is in the system set "%s" — the lock of the wave is broken',
                    g.code)
        FROM grants g
        JOIN grant_permissions gp ON gp.grant_id = g.id
       WHERE gp.permission = 'serviceRequests.cancel'
         AND g.is_system
         AND g.code <> 'office_equipment_it_approver'
      UNION ALL
      -- The composition grew by one right, or by none if it was there already — never by more.
      SELECT format('the set "%s" had %s rights and has %s: the migration adds one right, not %s',
                    s.code, s.rights, now_rights.n, now_rights.n - s.rights)
        FROM grant_snapshot_0379 s
        CROSS JOIN LATERAL (
          SELECT count(*)::bigint AS n
            FROM grant_permissions gp
            JOIN grants g ON g.id = gp.grant_id
           WHERE g.code = s.code
        ) now_rights
       WHERE now_rights.n <> s.rights
         AND NOT (s.code = 'office_equipment_it_approver'
                  AND NOT s.had_cancel
                  AND now_rights.n = s.rights + 1)
      UNION ALL
      -- The grants are untouched: the number of holders of every system set is the snapshot's.
      SELECT format('the set "%s" had %s holders and has %s: the composition is edited, not the grants',
                    s.code, s.holders, now_holders.n)
        FROM grant_snapshot_0379 s
        CROSS JOIN LATERAL (
          SELECT count(*)::bigint AS n
            FROM user_grants ug
            JOIN grants g ON g.id = ug.grant_id
           WHERE g.code = s.code
        ) now_holders
       WHERE now_holders.n <> s.holders
    ) AS bad;
  IF trouble IS NOT NULL THEN
    RAISE EXCEPTION 'The cancel right is placed in the sets not as declared — %', trouble;
  END IF;
END $$;
