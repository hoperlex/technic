-- Enable the document-based service estimate and automatic approval workflow.
--
-- ADR 0208 turns the already deployed capabilities from ADR 0183 into the default external
-- service workflow. Migration 0307 created both rows disabled; all API, worker, and web readers
-- of estimate format and file purpose have been deployed since release 0183. Migrations run before
-- the application restart, so the previous application version must tolerate this change: it does,
-- because it owns both flags and both request bodies already.
--
-- The statements remain ordered to preserve the original rollout rule: accepting document
-- revisions comes before applying the signature exemption. They become visible together at commit,
-- which is safe now that the full reader set is already deployed.
--
-- Rollback is operational rather than structural:
--   UPDATE feature_flags
--      SET is_enabled = false, updated_at = now()
--    WHERE key IN ('service_estimate_document_mode', 'service_estimate_exemption');
-- This stops new document revisions and new automatic approvals without rewriting existing facts.

UPDATE feature_flags
   SET is_enabled = true,
       updated_at = now()
 WHERE key = 'service_estimate_document_mode'
   AND is_enabled = false;

UPDATE feature_flags
   SET is_enabled = true,
       updated_at = now()
 WHERE key = 'service_estimate_exemption'
   AND is_enabled = false;

DO $$
DECLARE disabled_keys text;
BEGIN
  SELECT string_agg(expected.key, ', ' ORDER BY expected.key)
    INTO disabled_keys
    FROM (VALUES
      ('service_estimate_document_mode'),
      ('service_estimate_exemption')
    ) AS expected (key)
   WHERE NOT EXISTS (
     SELECT 1
       FROM feature_flags actual
      WHERE actual.key = expected.key
        AND actual.is_enabled
   );

  IF disabled_keys IS NOT NULL THEN
    RAISE EXCEPTION
      'Service document workflow did not open; missing or disabled feature flags: %',
      disabled_keys;
  END IF;
END $$;
