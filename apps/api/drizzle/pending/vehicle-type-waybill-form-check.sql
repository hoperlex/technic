-- Vehicle type waybill form: the CHECK narrowed to the two forms a type may carry (ADR 0065,
-- ADR 0128 "known debt"). PREPARED, NOT RELEASED (see `pending/README.md`): promoted by `git mv`
-- to the next free number in release R2, never together with R1.
--
-- Why its own release: R1 narrowed the code projections to `TypeWaybillFormCode` and closed the
-- directory import, which accepted "ЭСМ-2" and wrote it straight into `vehicle_types`. Releases
-- up to `dc647215` (prod on 2026-10-12) still had that option and prod could not be queried, so
-- the guard may fire on real data; inside R1 it would have blocked the whole release.
--
-- Precondition: R1 deployed and restarted, so no code writes 'esm2' any more and this file's own
-- window is served by code that writes only '4p' | 'leg3'.
--
-- If the guard fires, the file rolls back and R1 keeps serving. The owner picks 4p or leg3 for each
-- named type (survey), a separate migration rewrites them, then this file is promoted. Mapping
-- 'esm2' silently here is what ADR 0128 rules out: the form sets the paper of the type's routes.
--
-- Same commit as the promotion: the CHECK text in `schema.ts` becomes `IN ('4p', 'leg3')` and the
-- `waybillFormCode` comment loses its "until the pending CHECK" part; `waybillFormCell`
-- (`directory-transfer/defs/vehicles.ts`) loses its raw-code fallback; `docs/database-schema.md`
-- says CHECK `4p|leg3`; `vehicle-type-waybill-form-pending.db.test.ts` follows the file name.
-- `waybills.form_code` (migration 0061) stays three-valued: ESM-2 sheets carry it legitimately.

DO $type_form_guard$
DECLARE
  total integer;
  named text;
BEGIN
  SELECT count(*),
         string_agg(format('%s "%s" [%s] (id %s)', code, name, waybill_form_code, id), '; '
                    ORDER BY code)
    INTO total, named
    FROM vehicle_types
   WHERE waybill_form_code NOT IN ('4p', 'leg3');

  IF total > 0 THEN
    RAISE EXCEPTION
      'vehicle_types.waybill_form_code cannot be narrowed to 4p|leg3: % type(s) carry another form: %. Ask the owner which form (4p or leg3) each of them gets, rewrite them in a separate migration, then promote this file.',
      total, named;
  END IF;
END $type_form_guard$;

ALTER TABLE vehicle_types DROP CONSTRAINT vehicle_types_waybill_form_check;
ALTER TABLE vehicle_types
  ADD CONSTRAINT vehicle_types_waybill_form_check
    CHECK (waybill_form_code IN ('4p', 'leg3'));
