-- The reason of a «Не работал» reading and the checks of its shape (ADR 0244, stage 1A).
--
-- `idle_reason` is nullable and set exactly on an `idle` reading; «Другое» carries its word in the
-- existing `comment`. The values check gains the `idle` branch: no counter, no fuel and no
-- `no_data_reason`. The times check needs no change: it already allows times only on `values`.
--
-- THE REPLACEMENT PASSES BY CONSTRUCTION. No row is `idle` yet (0412 added the value, no writer
-- exists until release 1B), so every stored row has `idle_reason` NULL and satisfies both new
-- conditions; the values check only gains a branch. The subcommands share one ALTER TABLE: one
-- lock and one validation pass. The ACCESS EXCLUSIVE lock is bounded by the runbook's timeout
-- (owner decision S-27): a long transaction on the table fails the migration instead of queueing
-- every cabinet and garage query behind it.
--
-- THE OLD-CODE WINDOW. Code of the previous release writes `values` and `no_data` without naming
-- the new column; NULL is exactly what both checks demand of those kinds.
--
-- ROLLBACK. No reverse migration: after release 1B a DROP COLUMN would destroy recorded reasons.
-- Recovery is roll-forward or the runbook's PITR with the matching image.

SET LOCAL lock_timeout = '10s';

CREATE TYPE reading_idle_reason AS ENUM ('day_off', 'site_idle', 'repair', 'other');

ALTER TABLE vehicle_readings
  ADD COLUMN idle_reason reading_idle_reason,
  DROP CONSTRAINT vehicle_readings_values_check,
  ADD CONSTRAINT vehicle_readings_values_check CHECK (
    (
      kind = 'values'
      AND no_data_reason = ''
      AND (
        odometer_km IS NOT NULL
        OR engine_hours IS NOT NULL
        OR fuel_filled_liters IS NOT NULL
        OR fuel_start_liters IS NOT NULL
        OR fuel_end_liters IS NOT NULL
      )
    )
    OR (
      kind = 'no_data'
      AND odometer_km IS NULL
      AND engine_hours IS NULL
      AND fuel_filled_liters IS NULL
      AND fuel_start_liters IS NULL
      AND fuel_end_liters IS NULL
      AND btrim(no_data_reason) <> ''
    )
    OR (
      kind = 'idle'
      AND odometer_km IS NULL
      AND engine_hours IS NULL
      AND fuel_filled_liters IS NULL
      AND fuel_start_liters IS NULL
      AND fuel_end_liters IS NULL
      AND no_data_reason = ''
    )
  ),
  ADD CONSTRAINT vehicle_readings_idle_check CHECK (
    (kind = 'idle') = (idle_reason IS NOT NULL)
    AND (idle_reason IS DISTINCT FROM 'other' OR btrim(comment) <> '')
  );
