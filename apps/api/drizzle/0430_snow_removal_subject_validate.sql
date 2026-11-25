-- Validation of `waste_requests_snow_subject_check` (snow-removal plan, §3.1).
--
-- The previous migration added the check NOT VALID, so it has guarded every write since its commit
-- without scanning the table under ACCESS EXCLUSIVE. VALIDATE scans the existing rows under SHARE
-- UPDATE EXCLUSIVE, which lets reads and ordinary writes continue. It fails only if a legacy row
-- references the reserved id, which no code could have written before the previous migration seeded
-- it.
--
-- A separate committed file on purpose: if the scan is cancelled by `lock_timeout` or fails, the
-- guard itself stays in force and the deploy retries just this step.
SET LOCAL lock_timeout = '10s';

ALTER TABLE waste_requests VALIDATE CONSTRAINT waste_requests_snow_subject_check;
