-- "What we carry" on a freight trip (ADR 0239).
--
-- WHAT IS ADDED. One column on `vehicle_request_trips`: free text naming the cargo of this trip
-- ("sand", "PK 60-15 slabs"). Per trip, not per request: a request with trips A→B and A→C may carry
-- different things, exactly as it carries different quantities.
--
-- ADDITIVE ONLY. `NOT NULL DEFAULT ''` is a metadata-only change, no table rewrite. Old code running
-- during the migration/restart window inserts trips without the column and gets '' — the same state
-- every existing trip gets here, and the new code treats it as "older than the field": shown as
-- absent and kept on edit (R2a). There is no not-blank CHECK for that reason; a new value is
-- required by the contract and the request handler.
--
-- ROLLBACK. An old image refuses to start on a newer schema, so a rollback after this migration is
-- `--previous --restore-db`.

SET LOCAL lock_timeout = '10s';

ALTER TABLE vehicle_request_trips ADD COLUMN cargo_name text NOT NULL DEFAULT '';
