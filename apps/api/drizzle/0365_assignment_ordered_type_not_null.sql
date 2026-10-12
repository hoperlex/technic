-- Contract step of ADR 0059 §14: `vehicle_request_assignments.ordered_vehicle_type_id` becomes
-- NOT NULL.
--
-- Migration `0083` added the column nullable on purpose: the code released before it wrote
-- assignments without the ordered type, and a composite FK with NULL is not checked (MATCH SIMPLE),
-- so a rollback to that code stayed safe. The NOT NULL half was planned as "the next release" and
-- never shipped; until now the invariant "the order cannot change under an assigned vehicle" was
-- held for such rows by the server alone.
--
-- WHY THE BACKFILL COVERS EVERY ROW. `request_id` is the primary key and references
-- `vehicle_requests (id)` (`vehicle_request_assignments_request_fk`, migration `0083`), and
-- `vehicle_requests.vehicle_type_id` has been NOT NULL since `0012`. So every row with a NULL
-- ordered type has exactly one request and that request has a type: the UPDATE below leaves no
-- NULL behind, and the value it writes satisfies `vehicle_request_assignments_ordered_type_fk`
-- `(request_id, ordered_vehicle_type_id) -> vehicle_requests (id, vehicle_type_id)` by
-- construction. The current request type is the right value even for rows written by pre-0083
-- code: for a NULL row the FK was never checked, so the request type could have been changed under
-- it, and the assignment must lock the order as it stands now, not as it stood then.
--
-- WHY THE GUARD STILL EXISTS. It can fire only if the request FK is missing or was bypassed on the
-- database (a manual `DROP CONSTRAINT`, a restore that skipped it). Then `SET NOT NULL` would fail
-- with "column contains null values" and no row named; the guard names them instead, and the whole
-- file rolls back with the old code still serving.
--
-- MIGRATION WINDOW. Migrations run while the previous release still serves. Its only writer of
-- this table that inserts rows is `saveAssignment` (`routes/vehicle-requests.ts`), and it always
-- writes `ordered_vehicle_type_id` (typed `string`, taken from the request's NOT NULL type) on both
-- the insert and the upsert branch; the three UPDATE writers (`vehicle-routes.ts`,
-- `vehicle-route-correction.ts`, `vehicle-request-assignment-repair.ts`) never touch the column.
-- So the previous release keeps working on the new schema, and a rollback to it stays safe.

UPDATE vehicle_request_assignments a
   SET ordered_vehicle_type_id = r.vehicle_type_id
  FROM vehicle_requests r
 WHERE r.id = a.request_id
   AND a.ordered_vehicle_type_id IS NULL;

DO $ordered_type_guard$
DECLARE
  missing integer;
  sample text;
BEGIN
  SELECT count(*),
         string_agg(request_id::text, ', ' ORDER BY request_id) FILTER (WHERE rn <= 20)
    INTO missing, sample
    FROM (
      SELECT a.request_id, row_number() OVER (ORDER BY a.request_id) AS rn
        FROM vehicle_request_assignments a
       WHERE a.ordered_vehicle_type_id IS NULL
    ) left_over;

  IF missing > 0 THEN
    RAISE EXCEPTION
      'vehicle_request_assignments.ordered_vehicle_type_id cannot become NOT NULL: % row(s) have no vehicle request to take the ordered type from (request_id, first 20: %). The request foreign key was bypassed; restore the requests or delete these assignments, then rerun.',
      missing, sample;
  END IF;
END $ordered_type_guard$;

ALTER TABLE vehicle_request_assignments
  ALTER COLUMN ordered_vehicle_type_id SET NOT NULL;

COMMENT ON COLUMN vehicle_request_assignments.ordered_vehicle_type_id IS
  'Copy of the ORDERED request type (target of the composite FK to vehicle_requests): it keeps the order unchangeable under an assigned vehicle. NOT NULL since the ADR 0059 contract step.';
