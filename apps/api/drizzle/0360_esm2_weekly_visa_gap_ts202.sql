-- ESM-2 gap of order ТС-202 (ADR 0220): a new sheet replacing 00000734, which the visa of weekly
-- request НЗ-325 cancelled and could not reissue.
--
-- WHAT HAPPENED. On 02.10.2026 the vehicle of ТС-202 was changed from that day by the history
-- command, and the week 28.09–04.10 was cut at the change: 733 (01.10, previous vehicle) and 734
-- (02–04.10, new vehicle). The visa of НЗ-325 (05–11.10) then extended the order by the weekly
-- sweep, which wants one sheet «01–04.10» per order: it cancelled 734 and could not issue the
-- replacement, because worked-out 733 locked the period. No portal door closes that gap: history
-- commands refuse a no-op, manual ESM-2 issue is for linear orders only, and the weekly correction
-- scope counts the period as covered by 733. The cause is fixed in code by the same release.
--
-- WHY A NEW NUMBER AND ONLY THIS ORDER (survey of 07.10.2026). A cancelled form of strict
-- accountability does not come back into circulation, so 734 stays void and a new number of the
-- series replaces it — the pattern of migration 0236 (ADR 0151). Widening the repair to every order
-- the defect may have hit was rejected: the migration is bound to order 202 and sheet 734.
--
-- GUARDS. The block is a no-op with a NOTICE unless every one holds — the state was inferred from
-- code, not read from production, so the migration checks it itself:
--   1. the ESM-2 series exists;
--   2. order 202 is special equipment, not archived, in work or done;
--   3. sheet 734 of the series belongs to it, is cancelled with a weekly-request reason and covers
--      exactly 02.10–04.10;
--   4. nothing replaces it yet — the second run is a no-op;
--   5. no active ESM-2 sheet of the order overlaps 02.10–04.10;
--   6. those days lie inside the order's term;
--   7. the live history agrees with 734 on its days: no change of either dimension after 02.10
--      within them, the vehicle in force on 02.10 is 734's, the machinist in force is named and is
--      734's person;
--   8. the vehicle is own (a rented one gets no portal paper at all).
--
-- LOCK ORDER — the doors' and migration 0236's: the order row, then the sheet, then the series
-- counter. Migrations run while the portal is up (runbook), so an ESM-2 reconciliation may run in
-- parallel, and the opposite order would deadlock the deploy.
--
-- WHAT IS WRITTEN. One number from the counter row the portal spends (`takeNextNumber`); a
-- `waybill_corrections` row of kind `esm2` explaining it (author — whoever issued 734, as in 0236:
-- a migration has no person of its own); the new sheet — 734's columns and snapshot under the new
-- number, linked to 734 by `corrects_waybill_id`. The snapshot keys of the period and dates are
-- copied, not recomputed: the replacement covers the very days of 734, and a second formula for
-- them here could only diverge from the one that printed it. 734 itself is not touched: the visa
-- cancelled it, and the link new → old is `corrects_waybill_id`. Plus the customer's slot, the
-- history-dirty mark and the `waybill.esm2_sync` event marked with its source.

DO $weekly_visa_gap$
DECLARE
  c_number  constant integer := 734;
  c_from    constant date := DATE '2026-10-02';
  c_to      constant date := DATE '2026-10-04';
  c_reason  constant text :=
    'Лист 00000734 аннулирован визой НЗ-325 по дефекту сверки: неделя, разрезанная сменой техники, '
    || 'осталась без бумаги за 02–04.10 (ADR 0220)';
  v_series  record;
  v_order   record;
  v_old     record;
  v_vehicle uuid;
  v_driver  record;
  v_number  bigint;
  v_label   text;
  v_corr    uuid;
  v_new     uuid;
BEGIN
  SELECT s.id, s.prefix, s.number_width INTO v_series
    FROM waybill_series s WHERE s.code = 'esm2';
  IF NOT FOUND THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: серия не заведена — выписывать нечем';
    RETURN;
  END IF;

  -- The order row first, as every door takes it before paper.
  SELECT r.id, d.date_from, coalesce(d.date_to, d.date_from) AS last_day INTO v_order
    FROM vehicle_requests r
    JOIN special_equipment_request_details d ON d.request_id = r.id
   WHERE r.num = 202
     AND r.request_type = 'special_equipment'
     AND r.deleted_at IS NULL
     AND r.status IN ('confirmed', 'done')
     FOR UPDATE OF r;
  IF NOT FOUND THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: заказ не найден, в архиве или не в работе — лист не выписан';
    RETURN;
  END IF;

  -- Re-read under the lock with every condition: the running portal may have touched it.
  SELECT w.* INTO v_old
    FROM waybills w
   WHERE w.series_id = v_series.id
     AND w.number = c_number
     AND w.form_code = 'esm2'
     AND w.source_request_id = v_order.id
     AND w.status = 'cancelled'
     AND w.cancel_reason LIKE 'Недельная заявка %'
     AND w.period_from = c_from
     AND w.period_to = c_to
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: лист 00000734 не в ожидаемом состоянии (аннулирован визой недели за 02–04.10) — лист не выписан';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM waybills w WHERE w.corrects_waybill_id = v_old.id) THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: лист 00000734 уже заменён — повторять нечего';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM waybills w
     WHERE w.source_request_id = v_order.id
       AND w.form_code = 'esm2'
       AND w.status <> 'cancelled'
       AND w.period_from <= c_to
       AND w.period_to >= c_from
  ) THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: дни 02–04.10 уже закрывает действующий лист — лист не выписан';
    RETURN;
  END IF;

  IF NOT (v_order.date_from <= c_from AND v_order.last_day >= c_to) THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: дни 02–04.10 вне срока заказа (% — %) — лист не выписан',
      v_order.date_from, v_order.last_day;
    RETURN;
  END IF;

  -- The live history on 734's days: one composition, and it is 734's.
  IF EXISTS (
    SELECT 1 FROM vehicle_request_assignment_changes c
     WHERE c.request_id = v_order.id
       AND c.superseded_at IS NULL
       AND c.effective_date > c_from
       AND c.effective_date <= c_to
  ) THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: состав внутри 02–04.10 менялся после 02.10 — лист не выписан';
    RETURN;
  END IF;
  SELECT c.vehicle_id INTO v_vehicle
    FROM vehicle_request_assignment_changes c
   WHERE c.request_id = v_order.id
     AND c.superseded_at IS NULL
     AND c.dimension = 'vehicle'
     AND c.effective_date <= c_from
   ORDER BY c.effective_date DESC
   LIMIT 1;
  SELECT c.driver_state, c.driver_person_id INTO v_driver
    FROM vehicle_request_assignment_changes c
   WHERE c.request_id = v_order.id
     AND c.superseded_at IS NULL
     AND c.dimension = 'driver'
     AND c.effective_date <= c_from
   ORDER BY c.effective_date DESC
   LIMIT 1;
  IF v_vehicle IS DISTINCT FROM v_old.vehicle_id
     OR v_driver.driver_state IS DISTINCT FROM 'set'
     OR v_driver.driver_person_id IS DISTINCT FROM v_old.driver_person_id THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: история назначения на 02.10 расходится с листом 00000734 — лист не выписан';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = v_old.vehicle_id AND v.ownership = 'own') THEN
    RAISE NOTICE 'ЭСМ-2, ТС-202: техника листа 00000734 не собственная — бумагу ведёт арендодатель';
    RETURN;
  END IF;

  -- One number from the same counter row the portal spends, under its lock.
  UPDATE waybill_series SET next_number = next_number + 1, updated_at = now()
   WHERE id = v_series.id
   RETURNING next_number - 1 INTO v_number;
  v_label := v_series.prefix || lpad(v_number::text, v_series.number_width, '0');

  -- The journal operation before the paper: the replacement refers to it.
  INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id)
  VALUES (gen_random_uuid(), 'esm2:weekly-visa-gap:0360:' || v_old.id::text, 'esm2',
          c_reason, v_old.issued_by)
  RETURNING id INTO v_corr;

  INSERT INTO vehicle_request_corrections (correction_id, request_id)
  VALUES (v_corr, v_order.id)
  ON CONFLICT DO NOTHING;

  INSERT INTO waybills (
    series_id, number, form_code, status, organization_id, vehicle_id, driver_person_id,
    issued_for_date, route_id, source_request_id, period_from, period_to,
    with_trailer, trailer1_model, trailer1_reg_number, trailer2_model, trailer2_reg_number,
    garage_number, communication_kind, transportation_kind, data,
    issued_by, issued_at, issue_warnings, correction_id, correction_reason, corrects_waybill_id)
  VALUES (
    v_series.id, v_number, 'esm2', 'issued', v_old.organization_id, v_old.vehicle_id,
    v_old.driver_person_id, v_old.issued_for_date, NULL, v_order.id, v_old.period_from,
    v_old.period_to, v_old.with_trailer, v_old.trailer1_model, v_old.trailer1_reg_number,
    v_old.trailer2_model, v_old.trailer2_reg_number, v_old.garage_number,
    v_old.communication_kind, v_old.transportation_kind,
    v_old.data || jsonb_build_object('waybill_number', v_label),
    v_old.issued_by, now(), v_old.issue_warnings, v_corr, c_reason, v_old.id)
  RETURNING id INTO v_new;

  -- The customer's slot: the order card and the journal find their sheets by it.
  INSERT INTO waybill_requests (waybill_id, request_id, slot) VALUES (v_new, v_order.id, 1);

  -- The order's set of sheets changed, and with it the cancellability of its paper inside a day.
  UPDATE vehicle_requests
     SET assignment_history_dirty = true
   WHERE id = v_order.id AND assignment_history_dirty = false;

  -- The strict reconciliation event: the new number is named, and `source` tells a deploy's repair
  -- from a dispatcher's decision.
  INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (v_old.issued_by, 'waybill.esm2_sync', 'vehicle_request', v_order.id::text,
          jsonb_build_object(
            'reason', c_reason,
            'cancelled', jsonb_build_array(),
            'issued', jsonb_build_array(v_label),
            'trimmed', jsonb_build_array(),
            'scope', jsonb_build_array(jsonb_build_object('from', c_from, 'to', c_to)),
            'replaces', v_series.prefix || lpad(v_old.number::text, v_series.number_width, '0'),
            'operationId', v_corr,
            'source', 'migration 0360'));

  RAISE NOTICE 'ЭСМ-2, ТС-202: выписан лист % за 02–04.10 взамен 00000734', v_label;
END
$weekly_visa_gap$;
