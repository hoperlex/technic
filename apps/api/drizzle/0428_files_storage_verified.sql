-- Storage verification mark of an uploaded file (snow-removal plan, §3.2).
--
-- WHY. A ticket must be paper that really reached the storage. `files.status = 'active'` does not
-- prove it: attaching a request document promotes a still-pending upload to `active` without asking
-- the storage (`markFilesActive`), and `POST /files/:id/complete` returns early for a row that is
-- already `active`. Both ticket write paths (completion and the late attachment of ADR 0189) now
-- require this mark, which only the completion route sets after it has seen the object in storage.
--
-- No backfill: the mark is a statement about a verification that happened, and for existing rows it
-- did not happen in a way this column can witness. The completion route verifies an already-active
-- row without the mark instead of returning early.
--
-- WHY IT SURVIVES THE DEPLOY WINDOW. A nullable column without a default is a catalogue change; the
-- old API neither reads nor writes it. An upload completed by the old API in the window lacks the
-- mark: the ticket paths refuse it as unfinished, and the person uploads the scan again.
--
-- LOCKS. `ADD COLUMN` takes ACCESS EXCLUSIVE on `files` for a catalogue change only.
SET LOCAL lock_timeout = '10s';

ALTER TABLE files ADD COLUMN storage_verified_at timestamptz;
