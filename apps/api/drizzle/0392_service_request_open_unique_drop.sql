-- Several open service requests per office-equipment unit (ADR 0236, owner survey of 28.10.2026).
--
-- WHAT IS REMOVED. The pair of partial unique indexes that held "one open request of a kind per
-- unit" (ADR 0085 item 13, split per kind by migration 0177). The owner lifted the rule for both
-- kinds: two faults of one printer, or two people asking cartridges for one MFP, are now two
-- requests. Lookups by unit stay covered by `service_requests_equipment_idx`, and the repeat marker
-- reads its own `service_requests_repeat_idx`; neither query needed uniqueness.
--
-- MIGRATION WINDOW. Old code still runs its own route check (`assertNoOpenRequest`) and keeps
-- refusing a second open request until the restart, so nothing new is allowed early; it only stops
-- being backed by the index for that short window.
--
-- ROLLBACK. An application rollback keeps the schema: old code never needed the indexes to read,
-- and it refuses new duplicates by its route check. Recreating the indexes is possible only while
-- no unit has two open requests of one kind; once the portal has accepted such a pair, a
-- `CREATE UNIQUE INDEX` fails, and the rule can only come back after those requests are closed.

-- DROP INDEX takes ACCESS EXCLUSIVE on `service_requests` for an instant. A blocked deploy gives up
-- after 10 s while the old API keeps serving, instead of queueing the module behind it (runbook).
SET LOCAL lock_timeout = '10s';

DROP INDEX service_requests_open_repair_unique;
DROP INDEX service_requests_open_consumable_unique;
