-- Receipt-backed warehouse lots and immutable applications to vehicles (ADR 0216).
--
-- The legacy ADR 0134 warehouse remains frozen. A new warehouse lot is a receipt line, so the
-- paper document stays the single source for the name, quantity, and amount.

ALTER TABLE auto_part_receipt_lines
  ADD COLUMN destination text NOT NULL DEFAULT 'unassigned';

UPDATE auto_part_receipt_lines
   SET destination = 'vehicle'
 WHERE vehicle_id IS NOT NULL;

-- Old API versions only write vehicle_id. Keep the migration-first window compatible while also
-- preserving an explicit warehouse destination from the new API when vehicle_id is null.
CREATE FUNCTION auto_part_receipt_line_destination_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vehicle_id IS NOT NULL THEN
    NEW.destination := 'vehicle';
  ELSIF NEW.destination NOT IN ('unassigned', 'warehouse') THEN
    NEW.destination := 'unassigned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_part_receipt_line_destination_sync
BEFORE INSERT OR UPDATE OF vehicle_id, destination ON auto_part_receipt_lines
FOR EACH ROW EXECUTE FUNCTION auto_part_receipt_line_destination_sync();

ALTER TABLE auto_part_receipt_lines
  ADD CONSTRAINT auto_part_receipt_lines_destination_check CHECK (
    (destination = 'vehicle' AND vehicle_id IS NOT NULL)
    OR (destination IN ('unassigned', 'warehouse') AND vehicle_id IS NULL)
  );

CREATE INDEX auto_part_receipt_lines_warehouse_idx
  ON auto_part_receipt_lines (created_at, id)
  WHERE destination = 'warehouse';

CREATE TABLE auto_part_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES auto_part_receipt_lines(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  applied_on date NOT NULL,
  quantity integer NOT NULL,
  amount numeric(14,2) NOT NULL,
  document_number text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_part_applications_quantity_check CHECK (quantity > 0),
  CONSTRAINT auto_part_applications_amount_check CHECK (amount >= 0),
  CONSTRAINT auto_part_applications_document_number_check CHECK (btrim(document_number) <> '')
);

CREATE INDEX auto_part_applications_line_idx
  ON auto_part_applications (receipt_line_id, created_at, id);

CREATE INDEX auto_part_applications_vehicle_date_idx
  ON auto_part_applications (vehicle_id, applied_on DESC, created_at DESC, id DESC);

CREATE INDEX auto_part_applications_month_idx
  ON auto_part_applications (applied_on, created_at, id);

-- Applications are reporting documents. Corrections need an explicit reversal document in a
-- later decision; rewriting a row already included in a monthly export is never allowed.
CREATE FUNCTION auto_part_application_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auto_part_applications are immutable';
END;
$$;

CREATE TRIGGER auto_part_application_immutable
BEFORE UPDATE OR DELETE ON auto_part_applications
FOR EACH ROW EXECUTE FUNCTION auto_part_application_immutable();
