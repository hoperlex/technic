-- Match the receipt cache's write policy to its read policy, as tickets do in 0191.
-- `model = 'proxy'` lets the operator choose a model and is never a reusable cache key.
-- Without this exclusion, a repeated scan reaches the model but its successful response
-- fails to persist because the old index still enforces uniqueness for that placeholder.
--
-- Safe before application restart: this only relaxes an existing constraint. Both old and
-- new workers already bypass cache reads for `proxy`; explicit-model cache keys stay unique.
-- The migration runner wraps index replacement in one transaction; no attempts are removed.
DROP INDEX auto_part_receipt_attempts_cache_unique;

CREATE UNIQUE INDEX auto_part_receipt_attempts_cache_unique
  ON auto_part_receipt_recognition_attempts (
    page_sha256, engine, model, prompt_version, preprocessing_version
  )
  WHERE status = 'done' AND NOT forced AND model <> 'proxy';
