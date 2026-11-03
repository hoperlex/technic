-- The reading kind «Не работал» (ADR 0244, plan docs/rest-days-plan.md §4.1, stage 1A).
--
-- THIS FILE DOES ONE THING: it adds the enum value. The split from 0413 is forced, not stylistic:
-- the runner applies each file in its own transaction, and PostgreSQL forbids USING an enum value
-- in the transaction that added it ("unsafe use of new value"). The checks that name 'idle' live in
-- the next file.
--
-- Appended at the end: nothing orders by `kind`, and the contracts list (`READING_KINDS`) and the
-- drizzle enum carry the same order.
--
-- No row can carry the value until release 1B opens idle writes; code of the previous release keeps
-- serving against the expanded type and never meets it.

ALTER TYPE reading_kind ADD VALUE IF NOT EXISTS 'idle';
