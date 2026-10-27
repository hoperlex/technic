-- Driver shift and stop times (ADR 0234, plan `docs/readings-shifts-merge-plan.md` §7, owner
-- decisions D5, D8, D11 and Q2 of 27.10.2026).
--
-- WHAT IS ADDED. Additive only: two nullable columns on `vehicle_readings`, one defaulted column on
-- `driver_daily_reports` and two new tables. Old code running during the migration/restart window
-- never reads them and keeps writing valid rows: a reading without times is the legacy shape, and a
-- report opened by old code gets the default `v2` format.
--
-- NO BACKFILL. Readings submitted before this release were never asked for times; NULL here means
-- "not asked", not "unknown". Inventing a time for a person who is no longer by the vehicle would
-- fabricate an accounting fact.
--
-- ROLLBACK. Nothing here is needed by old code, so an application rollback keeps the schema. One
-- edge is named: old code switching a reading that already carries times to `no_data` violates
-- `vehicle_readings_times_check` and fails instead of silently keeping a time on a closed-without-
-- values shift. That refusal is preferred over a no_data row with a shift time.

-- Strong locks on live tables: ACCESS EXCLUSIVE on `vehicle_readings` and `driver_daily_reports`,
-- SHARE ROW EXCLUSIVE on `vehicle_requests` and `vehicle_route_points` for the new foreign keys. The
-- runner wraps the file in one transaction; a blocked deploy gives up after 10 s while the old API
-- keeps serving, instead of queueing every portal query on these tables behind it (S-27, runbook).
SET LOCAL lock_timeout = '10s';

-- Scalar shift times (Q2: kept on every reading). `time`, not `timestamptz`: the day is the reading's
-- `report_date`, and a second copy of the date would diverge from it on a rebase. For an ESM-2 item
-- the driver types the pair; for a route item the service derives it from the stop times in the
-- same transaction (start = arrival at stop 1, end = departure from the last stop once every stop
-- has one). An end earlier than the start is the next day (`shiftSpanHours`, ADR 0184).
ALTER TABLE vehicle_readings
  ADD COLUMN started_at time,
  ADD COLUMN ended_at time,
  ADD CONSTRAINT vehicle_readings_times_check CHECK (
    (ended_at IS NULL OR started_at IS NOT NULL)
    AND (kind = 'values' OR (started_at IS NULL AND ended_at IS NULL))
  );

-- Compatibility gate (plan §7.3, kept by D11). Every row that exists now and every row old code opens
-- during the window is `v2` and finishes under the rules it was opened with; new code opens `v3`,
-- and only a `v3` report requires the driver's times. A text with CHECK, not an enum: the set is a
-- protocol version that is expected to grow, and an enum value cannot be dropped later.
ALTER TABLE driver_daily_reports
  ADD COLUMN draft_format text NOT NULL DEFAULT 'v2',
  ADD CONSTRAINT driver_daily_reports_draft_format_check CHECK (draft_format IN ('v2', 'v3'));

-- The stops the driver recorded, as a snapshot. Route points are rebuilt when a waybill is cancelled
-- and the route reassembled (`vehicle_route_points` cascade), and the reading must keep what was
-- recorded, as `driver_daily_report_items` keeps its snapshot of the source.
--
-- `position` is the stop's place among the stops of this reading, 1..N without gaps, not the route
-- point's own position: the task leaves out a point whose every role belongs to a cancelled or
-- archived request, so route positions can have gaps. Only stop 1 has an arrival (the start of the
-- shift); every stop has a departure.
--
-- `route_point_id` is `ON DELETE SET NULL`: the live point is the capture-time reference, and a
-- rebuild must not take the recorded times with it. `location` keeps the address the driver saw.
CREATE TABLE vehicle_reading_points (
  reading_id     uuid     NOT NULL REFERENCES vehicle_readings (id) ON DELETE CASCADE,
  position       smallint NOT NULL,
  route_point_id uuid     REFERENCES vehicle_route_points (id) ON DELETE SET NULL,
  location       text     NOT NULL,
  arrived_at     time,
  departed_at    time,
  PRIMARY KEY (reading_id, position),
  CONSTRAINT vehicle_reading_points_position_check CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT vehicle_reading_points_arrival_check CHECK (position = 1 OR arrived_at IS NULL),
  CONSTRAINT vehicle_reading_points_location_check CHECK (btrim(location) <> '')
);
-- Serves the SET NULL of a rebuild: without it deleting a route's points scans every recorded stop.
CREATE INDEX vehicle_reading_points_route_point_idx
  ON vehicle_reading_points (route_point_id)
  WHERE route_point_id IS NOT NULL;

COMMENT ON TABLE vehicle_reading_points IS
  'Route stops as the driver recorded them: an address snapshot and the actual times. Survives a rebuild of the route points.';

-- Whose work each recorded stop was: the DISTINCT request ids served at the stop when its point set
-- was first captured, under the route lock. Two trips of one request at one stop are one share
-- (D6). Later time edits keep these rows; only clearing the stops and capturing them again makes a
-- new set. Stage 3 allocates route time from here, never from live roles, which a rebuild or a
-- detached request changes after the fact.
--
-- The request reference is `ON DELETE CASCADE`. A purge of an archived request
-- (`registerPurgeRoute`, `services/directory-purge.ts`) deletes the request with its dependants; a
-- RESTRICT here would make that purge fail on a historical reading, and the share of a request that
-- no longer exists has no reader. The recorded times stay in `vehicle_reading_points`; a stop left
-- without any request is reported as unresolved by the allocation (`routeTimeByRequest`).
CREATE TABLE vehicle_reading_point_requests (
  reading_id uuid     NOT NULL,
  position   smallint NOT NULL,
  request_id uuid     NOT NULL REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  PRIMARY KEY (reading_id, position, request_id),
  -- A mirror (ADR 0061): the snapshot belongs to its stop and follows it, never blocks it.
  CONSTRAINT vehicle_reading_point_requests_point_fk FOREIGN KEY (reading_id, position)
    REFERENCES vehicle_reading_points (reading_id, position) ON UPDATE CASCADE ON DELETE CASCADE
);
-- Stage 3 reads "the stops of this request", and the request cascade needs it too.
CREATE INDEX vehicle_reading_point_requests_request_idx
  ON vehicle_reading_point_requests (request_id);

COMMENT ON TABLE vehicle_reading_point_requests IS
  'Whose work a recorded stop was: the distinct requests of the point when its times were first captured.';
