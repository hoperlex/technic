-- Rental month cut of a weekly extension (ADR 0238).
--
-- WHAT IS ADDED. One nullable column on `weekly_vehicle_request_items`: the order a visa opened for
-- the part of a rental extension that lies past the last day of the month. An `extend` row of a
-- rental order is cut by the month border: the existing order is moved to the border, and a new order
-- of the same rented vehicle starts on the first of the next month. The row keeps one decision
-- ("stays until D") and points to the order it opened; `created_request_id` stays what it was — the
-- order of a `new` row — so every reader that takes `coalesce(source_request_id, created_request_id)`
-- as "the order of this row" keeps its meaning.
--
-- ADDITIVE ONLY. Old code running during the migration/restart window never reads the column and
-- never writes it: a visa applied by old code cuts nothing, as before. The rule starts to apply with
-- the new code, and a draft saved earlier is cut at the visa — the cut is computed there, under the
-- order lock, not stored.
--
-- ROLLBACK. An old image refuses to start on a newer schema, so a rollback after this migration is
-- `--previous --restore-db`.

SET LOCAL lock_timeout = '10s';

-- RESTRICT like the other order links of the table: an applied week must not lose its consequences,
-- and the opened order cannot be purged while the row explains where it came from.
ALTER TABLE weekly_vehicle_request_items
  ADD COLUMN continuation_request_id uuid REFERENCES vehicle_requests (id) ON DELETE RESTRICT,
  -- Only an applied `extend` row can have opened an order: a pending, skipped or foreign-kind row
  -- pointing at an order would read as "this week created it".
  ADD CONSTRAINT weekly_items_continuation_check CHECK (
    continuation_request_id IS NULL OR (kind = 'extend' AND result = 'extended')
  );

-- One opened order has exactly one basis, as with `weekly_items_created_uniq`. The two indexes do not
-- see each other on purpose: a continuation order is never the `created_request_id` of a row.
CREATE UNIQUE INDEX weekly_items_continuation_uniq
  ON weekly_vehicle_request_items (continuation_request_id)
  WHERE continuation_request_id IS NOT NULL;
