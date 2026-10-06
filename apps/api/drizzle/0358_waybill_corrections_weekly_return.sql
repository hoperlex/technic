-- Ninth operation kind of the correction journal — `weekly_return` (ADR 0219): an applied weekly
-- request returned for re-approval.
--
-- Its own kind rather than `weekly_annul`, although the paper work is the same reversal: the
-- journal answers "what was done to this form in the past", and the two commands leave the week in
-- opposite states. After annulment the burnt numbers are final; after a return the same week is
-- approved again and its sheets are issued anew, so the gap in numbering is followed by a second
-- operation on the same document. One word for both would hide exactly that.
--
-- `CHECK` instead of `ALTER TYPE` by the decision taken where the column was created (migration
-- 0129): the list of backdated entries grows by stages, the registry of values lives in the
-- `$type` of the drizzle schema, and the price is an additive migration per new kind.
--
-- No authorization snapshot (`authorization_scope`) is required, as for `weekly` and
-- `weekly_annul`: the command is authorized by `authorize` inside `runCorrection`, which asks the
-- right on every attempt, including a repeat by key. That CHECK lists only `crew` and
-- `assignment_tail` and is not touched.
--
-- ROLLOUT WINDOW. The migration runs while the old code is serving and before the restart: the old
-- code never writes the new value, so widening the CHECK is invisible to it. Additive, no teardown.

ALTER TABLE waybill_corrections
  DROP CONSTRAINT waybill_corrections_kind_check,
  ADD CONSTRAINT waybill_corrections_kind_check CHECK (
    kind IN (
      'route', 'transfer', 'esm2', 'cancel', 'issue', 'request_date', 'weekly',
      'crew', 'assignment_tail', 'day_batch', 'weekly_annul', 'weekly_return'
    )
  );
