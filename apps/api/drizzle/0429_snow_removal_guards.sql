-- Snow removal: the reserved service waste type «Снег» and the SQL guards around it
-- (snow-removal plan, S2, S10, S11, §3.1).
--
-- WHAT THE GUARDS HOLD, WHATEVER CODE IS SERVING:
--   · the reserved row keeps its id, code «snow», canonical name «Снег» and the active flag together
--     (CHECK `waste_types_service_snow_check`), and cannot be deleted (trigger) — S10;
--   · no tariff, active or not, may target it (CHECK `waste_tariffs_not_service_type_check`) — S6;
--   · a request carries the reserved id exactly when its type is `snow_removal`, and a snow request
--     has an ordered volume of at least 8 m³, no container fields, a count of 1 and no tariff or
--     price (CHECK `waste_requests_snow_subject_check`) — S2, S5, S6.
--
-- WHY IT SURVIVES THE DEPLOY WINDOW. The previous API keeps serving while this file runs and until
-- the restart. Its tariff editor lists every waste type, so it will show «Снег»; its request form
-- offers every active type to garbage. The guards above refuse each of those writes at the database:
-- the old code can neither price the row, rename, recode or deactivate it, nor file a garbage request
-- with it. Legacy rows keep their shape — no existing request or tariff references a row created
-- here, which the VALIDATE in the next migration proves on production data.
--
-- COLLISIONS (S11). The owner reported that «Снег» was never created on production. The preflight
-- below stops with a readable message if the reserved id, the code or the normalized name is taken;
-- resolve it with the owner and rerun. The plain INSERT after it enforces the same result through
-- the primary key and the unique indexes even if a writer races the preflight.
--
-- LOCKS. One statement takes the three tables in a fixed order with ACCESS EXCLUSIVE, bounded by
-- `lock_timeout`: a long reader makes this file fail with 55P03 and roll back while the old API keeps
-- serving, and the deploy is retried later (runbook, «A migration fails with canceling statement due
-- to lock timeout»). The request check is added NOT VALID so it protects new writes at once without
-- scanning `waste_requests` under this lock; the next migration validates it under the weaker
-- SHARE UPDATE EXCLUSIVE lock. Both small directory tables are validated here.
SET LOCAL lock_timeout = '10s';

LOCK TABLE waste_requests, waste_types, waste_tariffs IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(format('id=%s code=%s name=%s', id, code, name), '; ')
    INTO clash
    FROM waste_types
   WHERE id = '29cd9e92-0d72-4666-8ff1-76e0d6aad553'::uuid
      OR code = 'snow'
      OR name_key = public.waste_type_name_key('Снег');
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'Reserved waste type «Снег» collides with existing rows: %', clash
      USING HINT = 'Resolve the collision with the owner (snow-removal plan, S11) and rerun the deploy.';
  END IF;
END
$$;

INSERT INTO waste_types (id, code, name, description, sort_order, is_active)
VALUES (
  '29cd9e92-0d72-4666-8ff1-76e0d6aad553',
  'snow',
  'Снег',
  'Служебный тип заявок «Вывоз снега»: ставится порталом, не тарифицируется',
  1000,
  true
);

-- The reserved identity: the code belongs to the reserved id and to nothing else, and the reserved
-- row keeps its canonical name and stays active. A second row spelled «снег» is already refused by
-- `waste_types_name_key_unique`, because the reserved row holds that key.
ALTER TABLE waste_types
  ADD CONSTRAINT waste_types_service_snow_check CHECK (
    (id = '29cd9e92-0d72-4666-8ff1-76e0d6aad553'::uuid) = (code = 'snow')
    AND (
      id <> '29cd9e92-0d72-4666-8ff1-76e0d6aad553'::uuid
      OR (name = 'Снег' AND is_active)
    )
  );

-- Requests reference the row with ON DELETE RESTRICT, but a row without requests yet would still be
-- deletable — by the old directory purge in the window, or by hand. The trigger is the backstop; the
-- API refuses the purge before it gets here.
CREATE FUNCTION waste_types_service_row_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.id = '29cd9e92-0d72-4666-8ff1-76e0d6aad553'::uuid THEN
    RAISE EXCEPTION 'The service waste type «Снег» cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER waste_types_service_row_no_delete
  BEFORE DELETE ON waste_types
  FOR EACH ROW EXECUTE FUNCTION waste_types_service_row_guard();

-- Snow has no price list (S6): a tariff for the service type, even an inactive one, would let the
-- old selector or a later fallback price a snow request.
ALTER TABLE waste_tariffs
  ADD CONSTRAINT waste_tariffs_not_service_type_check CHECK (
    waste_type_id <> '29cd9e92-0d72-4666-8ff1-76e0d6aad553'::uuid
  );

-- Two-way identity, NULL-safe: the left side is never NULL (`request_type` is NOT NULL and the
-- comparison with a NULL waste type is forced to false), so a snow row without a waste type or a
-- volume fails explicitly instead of passing a CHECK that evaluated to NULL.
ALTER TABLE waste_requests
  ADD CONSTRAINT waste_requests_snow_subject_check CHECK (
    (request_type = 'snow_removal')
      = (waste_type_id IS NOT NULL AND waste_type_id = '29cd9e92-0d72-4666-8ff1-76e0d6aad553'::uuid)
    AND (
      request_type <> 'snow_removal'
      OR (
        volume_m3 IS NOT NULL
        AND volume_m3 >= 8
        AND container_type_id IS NULL
        AND container_owner_counterparty_id IS NULL
        AND containers_count = 1
        AND waste_tariff_id IS NULL
        AND price_per_m3 IS NULL
      )
    )
  ) NOT VALID;
