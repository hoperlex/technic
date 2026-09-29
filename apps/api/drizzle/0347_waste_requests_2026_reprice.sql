-- Reprice waste removal requests of 2026 by the corrected waste price list.
--
-- WHY. The price list (`waste_tariffs`) was corrected by hand on 29.09.2026, and its current values
-- hold for the whole of 2026. A request and its completion keep a price SNAPSHOT (ADR 0009,
-- ADR 0022): a price list edit never rewrites them, and nothing reprices them later except an edit
-- of that very request. Without this file the year keeps its old and missing prices, and the waste
-- statistics tab goes on reporting most requests of a month as "без цены".
--
-- SCOPE. Waste removal requests — the only priced type (`PRICED_REQUEST_TYPES`) — whose day falls
-- in 2026: the removal day of the completion, else the planned delivery day in Moscow. That is the
-- day that puts a request into a month of the statistics tab and of the Excel book
-- (`analytics/facts-waste.ts`), so exactly the figures people look at get corrected. The year is
-- written out rather than taken from now(): a database that applies this file in January 2027 must
-- fix the same requests. Deleted and cancelled requests are repriced as well — a deleted request can
-- be restored, and it would come back with the old price.
--
-- WHICH POSITION. The pick the portal makes today (`resolveWasteTariffByKind` + `pickWasteTariff`):
-- an active position of an active operator for "waste type × vehicle kind truck" (removal is billed
-- by dump trucks, ADR 0022); the request's own operator when it has one (ADR 0026), otherwise the
-- cheapest position with ties broken by id. This is a frozen copy of the rule for a one-time fix,
-- not a second living carrier of it: nothing reads this file after it has run.
--
-- WHAT IS REWRITTEN (user decisions of 29.09.2026):
-- - the request snapshot: tariff and price (`amount` is GENERATED and follows);
-- - the completion price and sum, but only where the sum came from the price list: no price and no
--   sum, or a sum equal to volume × price of a price list position. Anything else was typed by a
--   person — a sum that differs from volume × price (an operator's invoice), a price without a
--   tariff ("taken not from the price list", see the completion snapshot check), a sum without a
--   price, a price with a deliberately empty sum — and is kept and named in NOTICE;
-- - no position for the pair → the old price stays: a gap in the price list is more likely an
--   omission than a decision that the removal is free. The pairs are named in NOTICE so the price
--   list can be completed; the portal reprices such a request on its next edit.
--
-- NOT TOUCHED. Truck rows (`waste_request_vehicles`, ADR 0011): they record what was agreed per
-- truck, and the portal no longer creates them; their count is reported. Request `version` and
-- `updated_at` stay as they are, and no history entry is written (user decision): a bumped version
-- would fail every edit form left open during the rollout with a conflict, while the server
-- reprices a saved request from the same price list anyway.
--
-- ROLLBACK. The previous snapshots are in the pre-migration backup `deploy-auto` takes
-- (`docs/runbook.md`, "Бэкапы"): restore `price_per_m3`, `waste_tariff_id` and `total_cost` of the
-- requests named by the summary from it by `request_id`; there is no reverse file.

CREATE TEMP TABLE waste_reprice_2026 ON COMMIT DROP AS
SELECT r.id,
       r.num,
       r.operator_counterparty_id,
       r.waste_type_id,
       t.id           AS tariff_id,
       t.price_per_m3 AS price_per_m3
  FROM waste_requests r
  LEFT JOIN waste_request_completions c ON c.request_id = r.id
  LEFT JOIN LATERAL (
        SELECT wt.id, wt.price_per_m3
          FROM waste_tariffs wt
          JOIN counterparties cp ON cp.id = wt.operator_counterparty_id
         WHERE wt.waste_type_id = r.waste_type_id
           AND wt.container_kind = 'truck'
           AND wt.is_active
           AND cp.is_active
           AND (r.operator_counterparty_id IS NULL
                OR wt.operator_counterparty_id = r.operator_counterparty_id)
         -- One position per operator for the pair is held by a unique index, so with an operator
         -- this yields at most one row; without one it is the cheapest, ties by id as in the portal.
         ORDER BY wt.price_per_m3, wt.id
         LIMIT 1) t ON true
 WHERE r.request_type = 'waste_removal'
   AND r.waste_type_id IS NOT NULL
   AND coalesce(c.removed_on, (r.delivery_at AT TIME ZONE 'Europe/Moscow')::date)
         BETWEEN DATE '2026-01-01' AND DATE '2026-12-31';

DO $waste_reprice$
DECLARE
  v_scope        integer;
  v_requests     integer;
  v_completions  integer;
  v_manual       integer := 0;
  v_no_tariff    integer;
  v_truck_rows   integer;
  v_row          record;
BEGIN
  SELECT count(*) INTO v_scope FROM waste_reprice_2026;

  UPDATE waste_requests r
     SET waste_tariff_id = x.tariff_id,
         price_per_m3    = x.price_per_m3
    FROM waste_reprice_2026 x
   WHERE r.id = x.id
     AND x.tariff_id IS NOT NULL
     AND (r.waste_tariff_id IS DISTINCT FROM x.tariff_id
          OR r.price_per_m3 IS DISTINCT FROM x.price_per_m3);
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  -- A sum "from the price list" is volume × price rounded to kopecks (`calcWasteAmount`). The
  -- tolerance absorbs the float rounding of the JS formula that produced it; a hand-typed invoice
  -- differs by far more than a kopeck.
  UPDATE waste_request_completions c
     SET waste_tariff_id = x.tariff_id,
         price_per_m3    = x.price_per_m3,
         total_cost      = round(c.volume_m3 * x.price_per_m3, 2)
    FROM waste_reprice_2026 x
   WHERE c.request_id = x.id
     AND x.tariff_id IS NOT NULL
     AND c.volume_m3 IS NOT NULL
     AND ((c.price_per_m3 IS NULL AND c.total_cost IS NULL)
          OR (c.waste_tariff_id IS NOT NULL
              AND c.total_cost IS NOT NULL
              AND abs(c.total_cost - c.volume_m3 * c.price_per_m3) < 0.01))
     AND (c.waste_tariff_id IS DISTINCT FROM x.tariff_id
          OR c.price_per_m3 IS DISTINCT FROM x.price_per_m3
          OR c.total_cost IS DISTINCT FROM round(c.volume_m3 * x.price_per_m3, 2));
  GET DIAGNOSTICS v_completions = ROW_COUNT;

  -- Hand-typed completions that the price list would have changed. Named one by one: each is an
  -- invoice somebody entered, and whether the new price should replace it is a person's call.
  FOR v_row IN
    SELECT x.num, c.volume_m3, c.price_per_m3, c.total_cost, x.price_per_m3 AS new_price
      FROM waste_request_completions c
      JOIN waste_reprice_2026 x ON x.id = c.request_id
     WHERE x.tariff_id IS NOT NULL
       AND c.volume_m3 IS NOT NULL
       AND NOT ((c.price_per_m3 IS NULL AND c.total_cost IS NULL)
                OR (c.waste_tariff_id IS NOT NULL
                    AND c.total_cost IS NOT NULL
                    AND abs(c.total_cost - c.volume_m3 * c.price_per_m3) < 0.01))
       AND c.total_cost IS DISTINCT FROM round(c.volume_m3 * x.price_per_m3, 2)
     ORDER BY x.num
  LOOP
    v_manual := v_manual + 1;
    RAISE NOTICE 'Вывоз: заявка № % — закрытие заполнено вручную (сумма %, % м³, цена %), оставлено; по прайсу было бы % ₽',
      v_row.num, coalesce(v_row.total_cost || ' ₽', 'пусто'), v_row.volume_m3,
      coalesce(v_row.price_per_m3 || ' ₽/м³', 'пусто'), round(v_row.volume_m3 * v_row.new_price, 2);
  END LOOP;

  -- Gaps in the price list, grouped by pair: that is the unit somebody fixes in the directory.
  SELECT count(*) INTO v_no_tariff FROM waste_reprice_2026 WHERE tariff_id IS NULL;
  FOR v_row IN
    SELECT coalesce(cp.name, 'оператор не назначен') AS operator_name,
           wt.name                                 AS waste_type_name,
           count(*)                                AS requests,
           string_agg(x.num::text, ', ' ORDER BY x.num) AS nums
      FROM waste_reprice_2026 x
      JOIN waste_types wt ON wt.id = x.waste_type_id
      LEFT JOIN counterparties cp ON cp.id = x.operator_counterparty_id
     WHERE x.tariff_id IS NULL
     GROUP BY cp.name, wt.name
     ORDER BY count(*) DESC, cp.name, wt.name
  LOOP
    RAISE NOTICE 'Вывоз: нет позиции в прайсе «% × %» — заявок %, цена оставлена прежней: № %',
      v_row.operator_name, v_row.waste_type_name, v_row.requests, v_row.nums;
  END LOOP;

  SELECT count(DISTINCT v.request_id) INTO v_truck_rows
    FROM waste_request_vehicles v
    JOIN waste_reprice_2026 x ON x.id = v.request_id
   WHERE v.deleted_at IS NULL;

  RAISE NOTICE 'Вывоз, пересчёт 2026 года: заявок в охвате %, цена заявки сменилась у %, закрытий пересчитано %, ручных сумм оставлено %, без позиции в прайсе %, со строками самосвалов (не тронуты) %',
    v_scope, v_requests, v_completions, v_manual, v_no_tariff, v_truck_rows;
END
$waste_reprice$;
