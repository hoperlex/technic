-- Rental extension approval in mechanization (ADR 0171, stage 3; plan
-- `docs/mechanization-approval-and-grants-plan.md`, R10 and section 5).
--
-- WHAT HAPPENS HERE. One new enum and one new table: the request to extend a running rental, which
-- the office files and the site's visa holder decides. The term itself stays in
-- `mech_requests.planned_to` and moves only when the extension is approved, in the same transaction
-- as the decision. The file changes no existing table and no data.
--
-- WHERE THE NUMBER CAME FROM. `ls apps/api/drizzle` and `git ls-tree origin/main apps/api/drizzle`
-- on 12.10.2026: the last migration is `0367_releases_r1_orgtech_trailers.sql`. Parallel streams
-- take numbers too, so the integrator may renumber this file; nothing in code or tests refers to
-- the number.
--
-- WHY IT SURVIVES THE DEPLOY WINDOW (migrations run while the old release serves — AGENTS.md,
-- `docs/runbook.md`). The release serving production at the time of writing (`dc647215`) knows
-- neither the type nor the table and reads and writes neither. The table only references
-- `mech_requests` and `users`, and both references are harmless to that code:
--   · `request_id ... ON DELETE CASCADE` — the old code's hard delete and purge of a request remove
--     its extension row with it; during the window there are no rows to remove;
--   · `requested_by` / `decided_by ... ON DELETE RESTRICT` — no row exists until the new code files
--     an extension, so no account deletion can hit them during the window.
-- There is no guard, no backfill and no constraint on existing rows, so nothing here can fail on
-- production data. Proven by running the `dc647215` mechanization db suite against this schema.
--
-- ONE ROW PER REQUEST. A repeated request overwrites the row; the chain of requests and decisions
-- lives in the card history (`mech_request.extend_request`, `.extend`, `.extend_reject`,
-- `.extend_drop`), the same choice as `vehicle_request_early_endings` (migration 0071). A pending
-- row is deleted when it is withdrawn or when the rental ends (completion, revoked issue mark); a
-- decided row stays until the next request overwrites it.
--
-- WHAT IS NOT HERE. No index on `status = 'pending'`: nothing in this release lists pending
-- extensions across requests, and the row is read by its primary key next to its request. No
-- invariant tying the row to the rental state: the rental can end while a request waits, and the
-- server drops the request in the same transaction as the ending — a CHECK cannot see the parent.
--
-- REVERSIBILITY (drops the requests in flight; their history stays in the audit log):
--
--   DROP TABLE IF EXISTS mech_request_extensions;
--   DROP TYPE IF EXISTS mech_extension_status;

CREATE TYPE mech_extension_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE mech_request_extensions (
  -- Part of the request, not a document of its own: the request is the rental (ADR 0152, R1).
  request_id uuid PRIMARY KEY REFERENCES mech_requests (id) ON DELETE CASCADE,
  status mech_extension_status NOT NULL,
  -- The return date asked for, and the planned return the request had when it was filed. The
  -- snapshot is what catches "the term changed while the request waited": approval is refused
  -- unless the request still has exactly this date.
  new_planned_to date NOT NULL,
  previous_planned_to date NOT NULL,
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- The decision: who approved or rejected it and when. Empty exactly while it waits.
  decided_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_comment text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- "Who" without "when" is not a decision (same check as the request visa, migration 0284).
  CONSTRAINT mech_request_extensions_decision_check
    CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT mech_request_extensions_pending_check
    CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- An extension only moves the return forward: an earlier return is a completion with the actual
  -- date, which has its own path.
  CONSTRAINT mech_request_extensions_later_check
    CHECK (new_planned_to > previous_planned_to),
  CONSTRAINT mech_request_extensions_reason_check
    CHECK (btrim(reason) <> ''),
  -- A refusal is explained; an approval explains itself by the moved term.
  CONSTRAINT mech_request_extensions_rejection_reason_check
    CHECK (status <> 'rejected' OR btrim(decision_comment) <> '')
);
