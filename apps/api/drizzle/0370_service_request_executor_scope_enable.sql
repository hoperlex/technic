-- The executor scope switch goes ON: `service_request_executor_scope` (ADR 0179, decision 3;
-- plan `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р4 and §8). Owner
-- decision S-12 of 12.10.2026: switch it on in the nearest release, take release B (dropping
-- `serviceRequests` from both module-wide scope maps) one release later if nobody complains,
-- release C (removing the key) after that. This file is the switch only.
--
-- WHAT CHANGES FOR PEOPLE. A holder of the IT grant or the executor grant who holds no other grant
-- of the module and is not an administrator (`actsAsServiceExecutorOnly`) stops seeing the whole
-- company's requests and sees the ones assigned to them, created by them, or taken off them since
-- 10.09.2026 (the trace of 0299). Everyone else — administrators, the operator grant
-- («Ведение»), customer roles, contractors — is untouched by every branch behind the key.
--
-- WHY A MIGRATION AND NOT A MANUAL `UPDATE` (the reasons of 0297, the precedent): a manual switch
-- leaves no trace — a database restored from an older backup would come back closed with nothing
-- telling that apart from "closed on purpose", and dev would silently differ from prod. Here the
-- journal says when and this file says why; any database brought to this number arrives ON.
--
-- WHY THE ORDER OF ADR 0179 HOLDS ALTHOUGH THIS RUNS BEFORE THE RESTART. ADR 0179 requires
-- "migrations → the whole API switched → the portal → the key". All three of the first steps were
-- deployed with release A on 10.09.2026, and the code serving during this migration's window
-- (the previous release) is release A code: it reads the key on every request inside
-- `loadPrincipal` with no cache, writes the removal trace on all four removal paths and its portal
-- asks `hasFeature(user, 'service_request_executor_scope')` before showing actions. Nothing in the
-- scope branch changed since. So the switch takes effect on the old server the moment this commits,
-- exactly as the documented manual `UPDATE` would.
--
-- SESSION REFRESH. The server is safe immediately: the principal reads the key per request. An open
-- portal tab, though, keeps the `features` list of its last session answer and would keep showing
-- actions the server now refuses with 403 until its access token expires. So the accounts whose
-- answer changes get `auth_version + 1` — the mechanism grant changes use (0304,
-- `bumpAuthVersions`): the tab's next request gets 401, the transport refreshes silently, and the
-- refreshed `AuthUser` (with the key in `features`) replaces the old one and drops the query cache.
-- The set is the holders of the two executor-profile grants — a superset of
-- `actsAsServiceExecutorOnly`: computing that predicate in SQL would be a second copy of a contract
-- rule, and an extra holder (an administrator or an operator who also holds one of them) pays
-- one silent refresh. Bumping every account instead is rejected: `POST /auth/refresh` is limited to
-- 10 per minute per address, and an office behind one NAT refreshing all its tabs at once would
-- turn the 429 into a sign-out. Bumped only when the key actually flips here, so a rerun on an
-- already-open database costs nobody a refresh.
--
-- WHAT IT DOES NOT DO: grant or revoke any permission, touch the module-wide scope maps (release B),
-- write a release record (the release this ships with writes it), or change any other key — the
-- guard compares all keys with a snapshot taken before.
--
-- EMERGENCY OFF. `UPDATE feature_flags SET is_enabled = false, updated_at = now() WHERE key =
-- 'service_request_executor_scope'` on the live database: no deploy, no rollback of this file, no
-- restart. The previous release reads the same key, so it needs nothing either while it keeps
-- serving.
-- The previous server REFUSES to start on a schema with migrations its image does not know
-- (`assertMigrationsApplied`, "База новее кода"), so a code-only `--previous` after this release
-- cannot boot; schema rollback needs PITR to the pre-migration state and the matching code image.
-- The pre-migration dump is rejected by `restore_gate` after this file commits (runbook, «Откат»).

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Preconditions: the row to switch and the trace that makes the narrowing complete.
--
-- The state of the database is checked, not the journal: a restored copy has the same numbers and
-- may still differ in content. Without the row the `UPDATE` below would change nothing and report
-- success; without the trace table the third term of the scope ("taken off them") would not exist.

DO $$
DECLARE trouble text;
BEGIN
  SELECT string_agg(msg, '; ')
    INTO trouble
    FROM (
      SELECT 'the key row is missing (0300 is not applied) — there is nothing to switch' AS msg
       WHERE NOT EXISTS (
         SELECT 1 FROM feature_flags WHERE key = 'service_request_executor_scope')
      UNION ALL
      SELECT 'table service_request_past_executors is missing (0299 is not applied)'
       WHERE to_regclass('public.service_request_past_executors') IS NULL
    ) AS bad;
  IF trouble IS NOT NULL THEN
    RAISE EXCEPTION 'service_request_executor_scope_enable: too early to switch on — %', trouble;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Snapshot of every key before the switch, for the guard "no other key changed". A snapshot,
--    not constants: the values differ between prod, dev and restored copies (0300's technique).

CREATE TEMP TABLE feature_flags_before_executor_scope ON COMMIT DROP AS
SELECT key, is_enabled FROM feature_flags;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. The switch and the session refresh, in one statement so the refresh happens exactly when the
--    key flips. `is_enabled = false` in the condition keeps `updated_at` as the answer to "when was
--    it opened": a rerun on an open database neither rewrites it nor bumps anyone.

WITH flipped AS (
  UPDATE feature_flags
     SET is_enabled = true,
         updated_at = now()
   WHERE key = 'service_request_executor_scope'
     AND is_enabled = false
  RETURNING key
)
UPDATE users u
   SET auth_version = u.auth_version + 1
 WHERE EXISTS (SELECT 1 FROM flipped)
   AND EXISTS (
     SELECT 1
       FROM user_grants ug
       JOIN grants g ON g.id = ug.grant_id
      WHERE ug.user_id = u.id
        AND g.deleted_at IS NULL
        AND g.code IN ('office_equipment_it_approver', 'office_equipment_executor'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Result guard: the key is on, and no other key moved.

DO $$
DECLARE trouble text;
BEGIN
  SELECT string_agg(msg, '; ')
    INTO trouble
    FROM (
      SELECT 'the executor scope key stayed off' AS msg
       WHERE NOT EXISTS (
         SELECT 1 FROM feature_flags
          WHERE key = 'service_request_executor_scope' AND is_enabled)
      UNION ALL
      SELECT format('key «%s» changed: was %s, now %s', s.key, s.is_enabled, f.is_enabled)
        FROM feature_flags_before_executor_scope s
        JOIN feature_flags f ON f.key = s.key
       WHERE s.key <> 'service_request_executor_scope'
         AND f.is_enabled IS DISTINCT FROM s.is_enabled
      UNION ALL
      SELECT format('key «%s» disappeared', s.key)
        FROM feature_flags_before_executor_scope s
       WHERE NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.key = s.key)
    ) AS bad;
  IF trouble IS NOT NULL THEN
    RAISE EXCEPTION 'service_request_executor_scope_enable: the switch did not go as declared — %',
      trouble;
  END IF;
END $$;
