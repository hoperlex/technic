-- New request type «Вывоз снега» (snow-removal plan, S1; ADR of the snow removal request).
--
-- Snow is ordered and closed like one-off garbage removal, but its waste type is a server-owned
-- service row and its cost is entered by hand at completion. The guards that refer to the value
-- live in the next feature migration: PostgreSQL does not let a transaction use an enum value it
-- added, and the runner applies each file in one transaction (the scrap pair 0090/0091 follows the
-- same rule).
--
-- WHY IT SURVIVES THE DEPLOY WINDOW. Migrations run while the previous release serves. Adding an
-- enum value changes nothing the old API reads or writes: no row carries it until the new API
-- creates one. `AFTER 'waste_removal'` keeps the enum order equal to the portal order (S1).
--
-- LOCKS. `ALTER TYPE … ADD VALUE` takes a short lock on the type only; `lock_timeout` keeps a stuck
-- reader from queueing portal traffic behind it (runbook, «A migration fails with canceling statement
-- due to lock timeout»).
SET LOCAL lock_timeout = '10s';

ALTER TYPE request_type ADD VALUE IF NOT EXISTS 'snow_removal' AFTER 'waste_removal';
