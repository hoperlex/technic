-- Mail kinds of the letters to the request author — ONLY the `mail_kind` values (ADR 0227, E1 and
-- E11, step M1; the general mechanics of module mail is ADR 0159).
--
-- WHY A FILE WITH TWO VALUES ALONE. The runner applies each migration file in ONE transaction
-- (`apps/api/src/db/migration-journal.ts`), and PostgreSQL does not allow using a new enum value
-- before that transaction commits. The switch rows of the next file do not use `mail_kind` (their
-- key is text), but the pair is kept apart by the rollback boundary as well: enum values can never
-- be removed, while switch rows are removed by a plain `DELETE`. The same split as `0272`/`0273`
-- and `0257`/`0258`.
--
-- WHY A KIND PER EVENT. The queue is unique on `(kind, dedupe_key)`. The requester letters anchor
-- on the message id and the status history row id — the very anchors of the service letters about
-- the same fact — so a shared kind would let `ON CONFLICT DO NOTHING` swallow one of the two
-- letters without a trace.
--
-- DEPLOY WINDOW. Migrations run while the previous server still serves: it never writes these
-- values (it does not know them) and reads `mail_messages.kind` only as text for the mail log, so
-- the new values are inert until the new server starts.
--
-- REVERSIBILITY: additive. An enum value cannot be dropped; a code rollback simply stops writing
-- it. The values alone send nothing: letters need the switch rows of the next file.

ALTER TYPE mail_kind ADD VALUE IF NOT EXISTS 'service_request_requester_comment';
ALTER TYPE mail_kind ADD VALUE IF NOT EXISTS 'service_request_requester_status';
