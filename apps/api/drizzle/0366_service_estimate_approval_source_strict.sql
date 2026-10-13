-- The estimate signature and its source become one pair: release B of the on-site invoice estimate
-- wave (ADR 0183, ADR 0208; plan `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, §5).
-- A request is signed exactly when it is known what signed it — a person (`human`) or the
-- exemption declared by the service operator (`auto`). The pattern is 0198 (acceptance and its
-- source).
--
-- WHY THE PAIR WAS NOT IN RELEASE A (0306). Release A ran while code that knew nothing about the
-- source was still serving: that code signed without a source and cleared a signature leaving the
-- source behind, so an equality would have failed its first approval. Release A therefore read an
-- empty source as `human` and left the pair to this release.
--
-- WHY IT SURVIVES THIS MIGRATION'S WINDOW (migrations run while the portal is up and before the
-- restart — AGENTS.md, `docs/runbook.md`). The code serving during the window is the previous
-- release, and every release since ADR 0183 writes the four columns of the signature snapshot
-- together (audited in `apps/api/src/routes/service-requests.ts`, identical in the release serving
-- prod at the time of writing):
--   · both signing paths name the source — the approval route writes `human` with the author, the
--     exemption applied on submit writes `auto` without one;
--   · all five clearing paths clear it with the signature — the transition reset matrix
--     (`applyTransition`, flag `approval`), the handover to another contractor (`assignStep`,
--     behind `PUT /:id/executors` and `POST /bulk`), the re-issue of a breakdown
--     (`/:id/estimate/breakdown`), the return for editing (`/:id/estimate/reopen`) and the
--     dispute outcome "signature required" (`/:id/estimate/dispute/resolution`);
--   · the reset matrix and a handler's patch are merged key by key, and no patch sets or clears
--     the signature without the source, so a merge cannot split the pair either;
--   · no trigger, SQL function, worker job or script writes these columns.
-- So neither the old nor the new server can produce a row this constraint rejects.
--
-- THE BACKFILL — the two leftovers of release A's window, and both are unambiguous:
--   1. signed, no source: signed by pre-release-A code between 0306 and its restart. That code
--      could not auto-approve at all, so the signature is a person's → `human`. The date is the
--      test, not the author: the author is nulled by deleting a user account (`SET NULL`), and a
--      test by author would call a dismissed employee's signature automatic;
--   2. source, no signature: a signature cleared by pre-release-A code after 0306 had backfilled
--      its source. A source of nothing, and nobody reads it — the card builds `approval` only for a
--      signed request, and `exemptionApplied` asks for a signature on the current revision → `NULL`.
-- Neither update bumps `version`: the row's meaning does not change, and a bump would turn the
-- forms open on these requests into a version conflict.
--
-- THE GUARD BEFORE THE CONSTRAINT IS UNREACHABLE, and it is kept so that a future edit breaking
-- the reasoning fails with request numbers instead of a bare constraint name:
--   · the equivalence: after the two updates every row has both halves or neither — the updates
--     cover exactly the two mixed combinations;
--   · the value list and "no author for `auto`": the release A constraint still enforces them on
--     every row until it is replaced below, and the backfill writes `human` (valid with any author)
--     or `NULL`;
--   · no concurrent writer: the table is locked before the backfill and stays locked until commit.
-- A raise rolls the whole file back, and the previous release keeps serving on the old schema.
--
-- TRIGGERS. The backfill updates fire `service_requests_it_signature_guard` (0199) on the touched
-- rows: their IT signature is unchanged, and its last branch ("revision without signature") cannot
-- hold on a valid row — `service_requests_it_approval_check` pairs the IT author with the date, and
-- `service_requests_it_revision_check` requires the author for a revision.
-- `service_requests_executor_present` (0178) fires only on status and contractor columns.
--
-- ROLLBACK. Code: the previous release writes the pair consistently, so it is compatible with this
-- schema while it keeps serving.
-- The previous server REFUSES to start on a schema with migrations its image does not know
-- (`assertMigrationsApplied`, "База новее кода"), so a code-only `--previous` after this release
-- cannot boot; the consistent rollback is `--previous --restore-db` (runbook, section «Откат»).
-- Code older than ADR 0183 signs without a source: besides the review of
-- active document revisions the runbook already requires for it, such a rollback first weakens the
-- constraint back to the release A text of 0306 (the command is in the runbook, section on ADR
-- 0208). That weakening is safe at any time.
--
-- PostgreSQL 17 on prod, 16 on dev: nothing version-specific here. The runner applies the file in
-- one transaction (`apps/api/src/db/migration-journal.ts`); the lock is held for the backfill and
-- one validation scan of a table of thousands of rows.

-- ── 1. Lock ──
--
-- ACCESS EXCLUSIVE first, as in 0171: `ADD CONSTRAINT` would take it anyway, but only after the
-- backfill, and a row written in between by any session would reach the validation unfixed. Taking
-- the strongest lock up front also avoids a lock upgrade, which could deadlock with a request that
-- read the row `FOR UPDATE` and is about to write it.
LOCK TABLE service_requests IN ACCESS EXCLUSIVE MODE;

-- ── 2. Backfill ──

UPDATE service_requests SET estimate_approval_source = 'human'
 WHERE estimate_approved_at IS NOT NULL AND estimate_approval_source IS NULL;

UPDATE service_requests SET estimate_approval_source = NULL
 WHERE estimate_approved_at IS NULL AND estimate_approval_source IS NOT NULL;

-- ── 3. Guard ──
--
-- The predicate is the constraint below, word for word, tested with `IS FALSE`: a CHECK rejects a
-- row only when its expression is false, and so does this guard.
DO $$
DECLARE
  broken_total integer;
  broken_sample text;
BEGIN
  SELECT count(*) INTO broken_total
    FROM service_requests
   WHERE ((estimate_approved_at IS NULL) = (estimate_approval_source IS NULL)
          AND (estimate_approval_source IS NULL OR estimate_approval_source IN ('human','auto'))
          AND (estimate_approval_source <> 'auto' OR estimate_approved_by IS NULL)) IS FALSE;

  IF broken_total > 0 THEN
    SELECT string_agg(format('СО-%s (%s)', r.num, r.id), ', ' ORDER BY r.num)
      INTO broken_sample
      FROM (SELECT num, id
              FROM service_requests
             WHERE ((estimate_approved_at IS NULL) = (estimate_approval_source IS NULL)
                    AND (estimate_approval_source IS NULL
                         OR estimate_approval_source IN ('human','auto'))
                    AND (estimate_approval_source <> 'auto' OR estimate_approved_by IS NULL))
                   IS FALSE
             ORDER BY num
             LIMIT 20) r;
    RAISE EXCEPTION
      'service_estimate_approval_source_strict: % service request(s) still break "signed exactly when its source is known" after the backfill (first 20: %)',
      broken_total, broken_sample;
  END IF;
END $$;

-- ── 4. The strict pair ──

ALTER TABLE service_requests DROP CONSTRAINT service_requests_estimate_approval_source_check;

ALTER TABLE service_requests ADD CONSTRAINT service_requests_estimate_approval_source_check CHECK (
  -- Signed exactly when the source is known; neither half exists without the other.
  (estimate_approved_at IS NULL) = (estimate_approval_source IS NULL)
  AND (estimate_approval_source IS NULL OR estimate_approval_source IN ('human','auto'))
  -- No person answers for an automatic signature, so it has no author (0306, decision Р11).
  AND (estimate_approval_source <> 'auto' OR estimate_approved_by IS NULL)
);

-- "A human signature has an author" is deliberately not required, for the reason of 0198: the
-- author reference is `ON DELETE SET NULL`, and deleting a dismissed user nulls it on every
-- signature of theirs while the signature stays a person's.

COMMENT ON CONSTRAINT service_requests_estimate_approval_source_check ON service_requests IS
  'Estimate signature and its source are one pair (ADR 0183, release B): signed exactly when the '
  'source is known; auto has no author, human may lose it when the user is deleted (SET NULL).';

COMMENT ON CONSTRAINT service_requests_approval_check ON service_requests IS
  'Estimate signature snapshot: the date and the revision go together, the author is optional — '
  'an automatic signature (estimate_approval_source = auto) has none, a human one loses it when '
  'the user is deleted. The pair with the source is service_requests_estimate_approval_source_check.';

COMMENT ON COLUMN service_requests.estimate_approval_source IS
  'Source of the estimate signature: human — a person signed, auto — the exemption declared by the '
  'service operator. Present exactly when the request is signed (ADR 0183, release B).';
