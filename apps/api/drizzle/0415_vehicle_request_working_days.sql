-- Working Sunday marks of vehicle requests (ADR 0246, plan docs/rest-days-plan.md stage 2, D2).
--
-- A new table and nothing else: an empty table is exactly the hotfix of ADR 0242 (every calendar
-- Sunday of a sheet or a site-day route is a rest day), so the code of the previous release keeps
-- serving against this schema unchanged and no old code writes here. A row makes that Sunday an
-- ordinary working day of the request.
--
-- The primary key (request_id, work_date) serves both the "is this Sunday marked" probe of the
-- expected-shift queries and the idempotence of a repeated set. `extract(isodow ...)` on a date is
-- immutable, so the check is allowed on PostgreSQL 16 and 17 alike.

CREATE TABLE vehicle_request_working_days (
  request_id uuid NOT NULL REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  work_date date NOT NULL,
  set_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  set_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_request_working_days_pkey PRIMARY KEY (request_id, work_date),
  CONSTRAINT vehicle_request_working_days_sunday_check CHECK (extract(isodow FROM work_date) = 7)
);
