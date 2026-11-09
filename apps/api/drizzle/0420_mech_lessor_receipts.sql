-- The lessor's receipt of a mechanization rental (plan `docs/mechanization-lessor-receipt-plan.md`,
-- §4; decisions P1, P3, P4, P13).
--
-- WHAT IS ADDED. A column on `mech_requests` (does completion wait for a receipt), a status enum, a
-- table with one row per receipt version, the permission `mechRequests.lessorReceipt` in every
-- permission set that holds `mechRequests.status`, and the eleventh branch of `file_is_linked`.
--
-- WHERE THE NUMBER CAME FROM. `ls apps/api/drizzle` and `git ls-tree origin/main apps/api/drizzle/`
-- on 09.11.2026: the last taken number is `0419_releases_create_attempt_unlock.sql` (origin). Parallel
-- streams take numbers too, so the integrator may renumber this file; nothing in code refers to it.
--
-- WHY IT SURVIVES THE DEPLOY WINDOW (migrations run while the old release serves — AGENTS.md,
-- `docs/runbook.md`; plan §5):
--   · old code never reads or writes the table, the enum or the column. It takes rentals into work
--     with `lessor_receipt_required = false` (the default) — such rentals are not gated at
--     completion, exactly like the rentals taken before the release (accepted by the owner);
--   · old hard delete and purge of a request cascade its receipt rows; there are none until the
--     new code attaches one;
--   · the old worker's orphan sweep asks `file_is_linked`, which this file replaces in the same
--     transaction, so a receipt file is never swept;
--   · the old API reads `mechRequests.lessorReceipt` as an unknown string and deletes it from a set
--     on any save of that set's contents (P4). That is not fixed here: the deploy checklist forbids
--     editing permission sets between this migration and the restart, and checks afterwards that no
--     set holds `.status` without `.lessorReceipt` (plan §5).
-- Nothing here depends on the PostgreSQL major: no function in an index, and the data-modifying
-- CTE, `num_nonnulls` and `IS DISTINCT FROM` behave the same on 16 (dev) and 17 (production).
--
-- REVERSIBILITY. Additive. The old image refuses a schema newer than itself, so a rollback after
-- this migration is `--previous --restore-db` (runbook); there is no teardown file.

-- Strong locks on live tables: `ADD COLUMN` takes ACCESS EXCLUSIVE on `mech_requests`, the foreign
-- keys of the new table take SHARE ROW EXCLUSIVE on `files` and `users`. The runner wraps the file in
-- one transaction (`applyMigrations`), so `SET LOCAL` holds to its end; a blocked deploy gives up
-- after 10 s with 55P03 while the old API keeps serving, instead of queueing every portal query on
-- these tables behind it (S-27, runbook).
SET LOCAL lock_timeout = '10s';

-- The `ALTER` of the live `mech_requests` comes FIRST: `CREATE TABLE … REFERENCES files, users`
-- takes its locks on those two tables, and waiting up to the timeout for `mech_requests` while
-- holding them would stall uploads and account writes for that long.
--
-- Set to true by the server at `new → confirmed` and by attaching a receipt; never cleared (P3). A
-- column rather than "taken into work after a date": a date cutoff outlives everyone who remembers
-- its meaning (ADR 0133 decision 3), and an old rental that later got a receipt must be gated,
-- which a date cannot say. `ADD COLUMN … DEFAULT false` is metadata-only since PostgreSQL 11.
ALTER TABLE mech_requests
  ADD COLUMN lessor_receipt_required boolean NOT NULL DEFAULT false;

-- `waived` is the «без чека» visa (O10): a row without a file, created by the visa holder in its
-- final state. Retiring a version never changes its status (P1).
CREATE TYPE mech_lessor_receipt_status AS ENUM ('pending', 'approved', 'rejected', 'waived');

-- One row per version (P1): O4 says one file, O8 says every version stays openable, and both hold
-- when the request has one CURRENT row (not retired) and a list of retired ones. The decision
-- columns answer "what was decided", the retire columns "why it is no longer current"; one status
-- column would lose one of the two facts.
CREATE TABLE mech_request_lessor_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Part of the request: a hard delete of a «Новая» without versions and purge cascade the rows.
  -- A «Новая» WITH versions is archived instead (`mechDeleteScope`), so O8 holds.
  request_id uuid NOT NULL REFERENCES mech_requests (id) ON DELETE CASCADE,
  -- Computed under the request's row lock; the unique pair below is the backstop.
  version_no integer NOT NULL,
  -- RESTRICT, unlike the attachment link table (CASCADE): this row carries a decision, and a future
  -- bug that tries to delete a linked file must fail loudly instead of silently removing an approved
  -- version. No current path deletes a linked file; purge removes these rows (cascade from the
  -- request) before it deletes the collected files. Several NULLs pass the UNIQUE: waivers.
  file_id uuid UNIQUE REFERENCES files (id) ON DELETE RESTRICT,
  status mech_lessor_receipt_status NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Who attached it, fixed at insert: the lessor's view shows this word instead of a name (P12),
  -- and deriving it later from the author's account would relabel old versions.
  created_as text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  decided_at timestamptz,
  -- The rejection or waiver reason, or the approval's remark.
  decision_comment text NOT NULL DEFAULT '',
  retired_at timestamptz,
  retired_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  retired_reason text,
  CONSTRAINT mech_lessor_receipts_version_unique UNIQUE (request_id, version_no),
  CONSTRAINT mech_lessor_receipts_version_check CHECK (version_no > 0),
  CONSTRAINT mech_lessor_receipts_created_as_check CHECK (created_as IN ('lessor', 'office')),
  -- A file version has a file, a waiver has none.
  CONSTRAINT mech_lessor_receipts_file_check CHECK ((status = 'waived') = (file_id IS NULL)),
  -- P6 written into the base: only the office waives, and the waiver is born decided by its author.
  CONSTRAINT mech_lessor_receipts_waiver_check
    CHECK (status <> 'waived' OR (created_as = 'office' AND decided_by = created_by)),
  CONSTRAINT mech_lessor_receipts_decision_check CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT mech_lessor_receipts_pending_check CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT mech_lessor_receipts_reason_check
    CHECK (status NOT IN ('rejected', 'waived') OR btrim(decision_comment) <> ''),
  CONSTRAINT mech_lessor_receipts_retired_check
    CHECK (num_nonnulls(retired_at, retired_by, retired_reason) IN (0, 3)),
  CONSTRAINT mech_lessor_receipts_retired_reason_check
    CHECK (retired_reason IS NULL
      OR retired_reason IN ('replaced', 'deal_changed', 'rolled_back', 'revoked')),
  -- Only a waiver is retired by revocation; a revoked file version goes back to `pending` instead
  -- (P5), which the pending and reason checks allow once the decision columns are cleared.
  CONSTRAINT mech_lessor_receipts_revoked_check
    CHECK (retired_reason IS DISTINCT FROM 'revoked' OR status = 'waived')
);
-- No invariant "done ⇒ approved or waived" here: it would fail on the first existing `done` row
-- (the reason ADR 0171 decision 3 gives). The server holds it (`mechLessorReceiptCompletionBlocker`).

-- At most one current version per request. Inserts follow an explicit retire under the request's
-- lock, never `ON CONFLICT`: a later upsert must repeat the predicate in its `where`, or PostgreSQL
-- does not infer this partial index (the drizzle partial-index trap).
CREATE UNIQUE INDEX mech_lessor_receipts_current_unique
  ON mech_request_lessor_receipts (request_id) WHERE retired_at IS NULL;

COMMENT ON TABLE mech_request_lessor_receipts IS
  'Lessor receipt of a mechanization rental (docs/mechanization-lessor-receipt-plan.md, P1): one row '
  'per version; the current one is not retired (retired_at IS NULL, at most one per request). The '
  'decision columns say what the visa holder decided, the retire columns why the version stopped '
  'being current. The file is named in file_is_linked by the same migration.';

-- Every permission set that runs rentals also attaches receipts (P4); deleted sets too, so that a
-- restore stays consistent (they have no holders). The version moves so that an editor opened
-- before the migration saves into the editor's ordinary 409 instead of over the new permission.
--
-- No `grant.update` audit row is written: the precedents that added a permission to existing sets
-- by migration (`0275` for `officeEquipment.move`, `0285` for `mechRequests.approve`) wrote none and
-- did not move versions either; the ADR of this release records it (plan P4). The migration file
-- itself, kept in the repository and in `_migrations`, is the record of who added the row and why.
WITH touched AS (
  INSERT INTO grant_permissions (grant_id, permission)
  SELECT grant_id, 'mechRequests.lessorReceipt'
  FROM grant_permissions
  WHERE permission = 'mechRequests.status'
  ON CONFLICT (grant_id, permission) DO NOTHING
  RETURNING grant_id
)
UPDATE grants SET version = version + 1, updated_at = now()
WHERE id IN (SELECT grant_id FROM touched);

-- ── The eleventh branch of `file_is_linked(uuid)` ──
--
-- A module unknown to `file_is_linked(uuid)` hands its files to their uploader FOREVER
-- (`decideFileAccess` treats such a file as nobody's), and the orphan sweep removes them from
-- storage. Retired versions stay linked: that is O8.
--
-- `CREATE OR REPLACE` repeats the full list of `0243` — the latest definition of the function
-- (checked by `grep -l 'FUNCTION file_is_linked' apps/api/drizzle/*.sql`; later files only mention it)
-- — plus the new branch. The body is replaced WHOLE: a branch left out would silently drop the
-- protection of another module.
CREATE OR REPLACE FUNCTION file_is_linked(p_file_id uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT
    -- Attachments and tickets of waste removal requests (ADR 0024).
    EXISTS (SELECT 1 FROM request_files WHERE file_id = p_file_id)
    -- Attachments and documents of vehicle requests.
    OR EXISTS (SELECT 1 FROM vehicle_request_files WHERE file_id = p_file_id)
    -- Scans filed to a waybill (migration 0087).
    OR EXISTS (SELECT 1 FROM waybill_files WHERE file_id = p_file_id)
    -- Documents of office equipment service requests (ADR 0084, migration 0105).
    OR EXISTS (SELECT 1 FROM service_request_files WHERE file_id = p_file_id)
    -- Photos of vehicle readings (migration 0132).
    OR EXISTS (SELECT 1 FROM vehicle_reading_files WHERE file_id = p_file_id)
    -- Scans of a worker's documents (migration 0019).
    OR EXISTS (SELECT 1 FROM person_credential_files WHERE file_id = p_file_id)
    -- Scans of maintenance acts (migration 0147).
    OR EXISTS (SELECT 1 FROM vehicle_maintenance_files WHERE file_id = p_file_id)
    -- The source scan of a recognition quality observation (ADR 0137, migration 0210).
    OR EXISTS (SELECT 1 FROM waste_ticket_field_events WHERE file_id = p_file_id)
    -- Attachments of mechanization rental requests (migration 0238).
    OR EXISTS (SELECT 1 FROM mech_request_files WHERE file_id = p_file_id)
    -- Scans of auto part receipts (migration 0243).
    OR EXISTS (SELECT 1 FROM auto_part_receipt_files WHERE file_id = p_file_id)
    -- Versions of the lessor's receipt of a mechanization rental, retired ones included (this
    -- migration; O8: every version stays openable while the request lives).
    OR EXISTS (SELECT 1 FROM mech_request_lessor_receipts WHERE file_id = p_file_id)
$$;

COMMENT ON FUNCTION file_is_linked(uuid) IS
  'The file is linked to at least one portal entity or recognition audit event. The single source '
  'of truth for attachability, access, explicit deletion and the orphan sweep. An observation scan '
  'is released explicitly only when its request is deleted for good. Eleven branches; the last is a '
  'version of the mechanization lessor receipt (migration 0420).';
