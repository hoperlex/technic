-- Rental closing facts and vehicle request documents (plan
-- `docs/vehicle-rental-completion-documents-plan.md` §4.1, owner decisions D1–D8 of 28.10.2026).
--
-- WHAT IS ADDED. Additive only: three nullable columns on `vehicle_request_completions` and three
-- columns on `vehicle_request_files`, one of them defaulted. Old code running during the
-- migration/restart window never reads them and keeps writing valid rows: a closing without the
-- second count and without delivery is the shape every closing had, and a link inserted without a
-- kind is an attachment, which is what old code means by a link.
--
-- NO BACKFILL. Closings before this release were never asked for the second count or for delivery;
-- NULL means "not asked". Copying `worked_amount` into the matching count would be harmless but
-- would make an old closing look as if both counts had been entered.
--
-- ROLLBACK. An old image refuses to start on a newer schema, so a rollback after this migration is
-- `--previous --restore-db`; old code never meets rows written by the new code.

-- Strong locks on live tables (ACCESS EXCLUSIVE for ADD COLUMN / ADD CONSTRAINT). The runner wraps
-- the file in one transaction; a blocked deploy gives up after 10 s while the old API keeps serving,
-- instead of queueing every portal query on these tables behind it (S-27, runbook).
SET LOCAL lock_timeout = '10s';

-- Both counts of a rental closing (D1). `worked_amount` stays the BILLED count — the one the cost is
-- rate × count of — so every existing reader (card, journal, summary book) keeps its meaning. The
-- count matching `worked_unit` is the same number by definition; the CHECK refuses a row where the
-- two copies disagree instead of leaving a reader to guess which one is true. NULL is legal for
-- both: closings before this release, non-rentals and an old tab's closing (plan §4.3).
ALTER TABLE vehicle_request_completions
  ADD COLUMN worked_hours numeric(10, 2),
  ADD COLUMN worked_shifts numeric(10, 2),
  -- Delivery to and from the site (D3): one amount, apart from `total_cost` and never part of it —
  -- the owner treats delivery as a separate entity with its own paperwork. NULL is "no delivery";
  -- a zero would be a second spelling of the same thing, hence `> 0`.
  ADD COLUMN delivery_cost numeric(14, 2),
  ADD CONSTRAINT vehicle_request_completions_worked_hours_positive_check
    CHECK (worked_hours IS NULL OR worked_hours > 0),
  ADD CONSTRAINT vehicle_request_completions_worked_shifts_positive_check
    CHECK (worked_shifts IS NULL OR worked_shifts > 0),
  ADD CONSTRAINT vehicle_request_completions_unit_count_check CHECK (
    (worked_unit <> 'hours' OR worked_hours IS NULL OR worked_hours = worked_amount)
    AND (worked_unit <> 'shifts' OR worked_shifts IS NULL OR worked_shifts = worked_amount)
  ),
  ADD CONSTRAINT vehicle_request_completions_delivery_cost_positive_check
    CHECK (delivery_cost IS NULL OR delivery_cost > 0);

-- Documents in the same link table as the requester's attachments (D8). One table keeps one link,
-- one download rule (`files.ts` follows this table with the lessor scope), one `UNIQUE (file_id)`
-- and one branch of `file_is_linked(uuid)`; a second table would have to repeat all four, and a
-- branch forgotten in `file_is_linked` hands a file to its uploader forever.
--
-- `kind` separates who owns the row: an attachment belongs to the request editor
-- (`addFileIds`/`removeFileIds`), a document to the documents door. Without it the editor's remove
-- button would take an invoice off a closed request. Type is free text (D5), the date is typed by
-- hand and may be any date (owner correction to P4); who added a document is `files.uploaded_by`,
-- which the attach path already requires to be the caller.
ALTER TABLE vehicle_request_files
  ADD COLUMN kind text NOT NULL DEFAULT 'attachment',
  ADD COLUMN doc_type text,
  ADD COLUMN doc_date date,
  ADD CONSTRAINT vehicle_request_files_kind_check CHECK (kind IN ('attachment', 'document')),
  -- A document has both, an attachment neither: a typed attachment or an untyped document would
  -- each be a row two readers classify differently.
  ADD CONSTRAINT vehicle_request_files_document_check CHECK (
    (kind = 'document') = (doc_type IS NOT NULL AND doc_date IS NOT NULL)
    AND (kind = 'document' OR (doc_type IS NULL AND doc_date IS NULL))
    AND (doc_type IS NULL OR btrim(doc_type) <> '')
  );

COMMENT ON COLUMN vehicle_request_completions.delivery_cost IS
  'Delivery to and from the site, rub. Separate from total_cost and never added to it; NULL = no delivery.';
COMMENT ON COLUMN vehicle_request_files.kind IS
  'attachment = the requester''s file owned by the request editor; document = typed and dated paper added from «В работе» on.';
