-- The pending estimate and its origin become one pair: the second half of release B of the on-site
-- invoice estimate wave (ADR 0183, section «Release B»; plan
-- `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, §5). A request waits for a signature
-- exactly when it is known what opened the wait — a submission (`submit`) or the dispute outcome
-- "signature required" (`dispute`). The first half, the signature and its source, is the migration
-- `…_service_estimate_approval_source_strict.sql`; this file repeats its shape.
--
-- WHY THE PAIR WAS NOT IN RELEASE A (0306). Release A ran while code that knew nothing about the
-- origin was still serving: that code opened a wait without an origin and cleared a wait leaving the
-- origin behind, so an equality would have failed its first submission. Release A therefore read an
-- empty origin as `submit` and left the pair for later.
--
-- WHY IT SURVIVES THIS MIGRATION'S WINDOW (migrations run while the portal is up and before the
-- restart — AGENTS.md, `docs/runbook.md`). The code serving during the window is the previous
-- release, and every release since ADR 0183 writes `estimate_pending_revision` and
-- `estimate_pending_source` together (audited in `apps/api/src/routes/service-requests.ts`,
-- identical in the release serving prod at the time of writing):
--   · the three opening paths name the origin — the submission writes `submit` (or neither column
--     when the exemption applies and no signature is collected), the re-issue of a breakdown writes
--     `submit`, the dispute outcome "signature required" writes `dispute`;
--   · all six clearing paths clear the origin with the wait — the transition reset matrix
--     (`applyTransition`, flag `estimate`), the handover to another contractor (`assignStep`), the
--     approval and the rejection (`/:id/estimate/approval`), the return for editing
--     (`/:id/estimate/reopen`) and the internal close (`/:id/complete`);
--   · the reset matrix and a handler's patch are merged key by key, and no patch sets or clears one
--     column without the other, so a merge cannot split the pair either;
--   · no trigger, SQL function, worker job or script writes these columns.
-- So neither the old nor the new server can produce a row this constraint rejects.
--
-- THE BACKFILL — two kinds of leftovers, both unambiguous and both invisible to every reader:
--   1. a wait without an origin: opened by code older than release A — every wait still open when
--      release A restarted (0306 did not backfill the origin), the waits 0224 made from the former
--      status «Смета на согласовании», the historical waits of internal requests. All of them are
--      submissions: `dispute` exists only since release A, and its single writer always names it →
--      `submit`, the very value every reader already assumes for an empty origin;
--   2. an origin without a wait: a wait cleared by code older than release A after release A code
--      had named it, reachable only through a rollback below release A. Nobody reads it — the
--      approval in «Решена» asks for a wait on the current revision, auto-close asks for the origin
--      only under a wait, and the approval route is closed without a wait → `NULL`.
-- Neither update bumps `version`: the row's meaning does not change, and a bump would turn the
-- forms open on these requests into a version conflict.
--
-- THE GUARD BEFORE THE CONSTRAINT IS UNREACHABLE, and it is kept so that a future edit breaking
-- the reasoning fails with request numbers instead of a bare constraint name:
--   · the equivalence: after the two updates every row has both halves or neither — the updates
--     cover exactly the two mixed combinations;
--   · the value list: the release A constraint still enforces it on every row until it is replaced
--     below, and the backfill writes `submit` or `NULL`;
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
-- Code older than ADR 0183 opens a wait without an origin: besides the review of active document
-- revisions the runbook already requires for it, such a rollback first weakens this constraint back
-- to the release A text of 0306, together with the signature pair (the command is in the runbook,
-- section on ADR 0208). That weakening is safe at any time.
--
-- PostgreSQL 17 on prod, 16 on dev: nothing version-specific here. The runner applies the file in
-- one transaction (`apps/api/src/db/migration-journal.ts`); the lock is held for the backfill and
-- one validation scan of a table of thousands of rows.

-- ── 1. Lock ──
--
-- ACCESS EXCLUSIVE first, as in the signature pair: `ADD CONSTRAINT` would take it anyway, but only
-- after the backfill, and a row written in between by any session would reach the validation
-- unfixed. Taking the strongest lock up front also avoids a lock upgrade, which could deadlock with
-- a request that read the row `FOR UPDATE` and is about to write it.
LOCK TABLE service_requests IN ACCESS EXCLUSIVE MODE;

-- ── 2. Backfill ──

UPDATE service_requests SET estimate_pending_source = 'submit'
 WHERE estimate_pending_revision IS NOT NULL AND estimate_pending_source IS NULL;

UPDATE service_requests SET estimate_pending_source = NULL
 WHERE estimate_pending_revision IS NULL AND estimate_pending_source IS NOT NULL;

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
   WHERE ((estimate_pending_revision IS NULL) = (estimate_pending_source IS NULL)
          AND (estimate_pending_source IS NULL
               OR estimate_pending_source IN ('submit','dispute'))) IS FALSE;

  IF broken_total > 0 THEN
    SELECT string_agg(format('СО-%s (%s)', r.num, r.id), ', ' ORDER BY r.num)
      INTO broken_sample
      FROM (SELECT num, id
              FROM service_requests
             WHERE ((estimate_pending_revision IS NULL) = (estimate_pending_source IS NULL)
                    AND (estimate_pending_source IS NULL
                         OR estimate_pending_source IN ('submit','dispute'))) IS FALSE
             ORDER BY num
             LIMIT 20) r;
    RAISE EXCEPTION
      'service_estimate_pending_source_strict: после добивки ожидание подписи и его происхождение всё ещё не пара (ожидание без происхождения, происхождение без ожидания или незнакомое значение), заявок: % (первые 20: %)',
      broken_total, broken_sample;
  END IF;
END $$;

-- ── 4. The strict pair ──

ALTER TABLE service_requests DROP CONSTRAINT service_requests_estimate_pending_source_check;

ALTER TABLE service_requests ADD CONSTRAINT service_requests_estimate_pending_source_check CHECK (
  -- Waiting exactly when the origin is known; neither half exists without the other.
  (estimate_pending_revision IS NULL) = (estimate_pending_source IS NULL)
  AND (estimate_pending_source IS NULL
       OR estimate_pending_source IN ('submit','dispute'))
);

COMMENT ON CONSTRAINT service_requests_estimate_pending_source_check ON service_requests IS
  'A pending estimate and its origin are one pair (ADR 0183, release B): a request waits for a '
  'signature exactly when it is known what opened the wait — a submission or a dispute outcome.';

COMMENT ON COLUMN service_requests.estimate_pending_source IS
  'Origin of the pending signature: submit — a submission or a re-issue, dispute — the dispute '
  'outcome "signature required". Present exactly when estimate_pending_revision is (ADR 0183, '
  'release B).';
