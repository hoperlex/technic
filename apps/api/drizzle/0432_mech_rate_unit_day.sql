-- Mechanization rate per day (ADR 0251): the third value of `mech_rate_unit` beside `hour` and
-- `shift`. A lessor bills a machine that stays on site round the clock by the day.
--
-- Safe while the old code still serves: no row holds `day` until the new code offers it, so the old
-- code never reads a value it does not know. `ADD VALUE` cannot be used by the same transaction
-- that adds it, and nothing here uses it. `IF NOT EXISTS` makes a repeated run a no-op.
-- Rollback: an enum value cannot be dropped in place; a row with `day` must be changed first, and
-- the type rebuilt — keep the value, the old code never offers it.

ALTER TYPE mech_rate_unit ADD VALUE IF NOT EXISTS 'day';
