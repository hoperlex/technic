-- Ordinary request creation gets a receipt before the request is inserted.
-- The reservation and request ID commit together, so a concurrent retry waits on the primary key
-- and cannot create a second request or repeat file attachment. The response is filled before the
-- first HTTP 201; a crash in that gap leaves a request ID from which a retry can finish the receipt.
-- Keep request_id without an FK: hard deletion of a New request must not free its attempt key.
-- The migration runner wraps this file in a transaction. The users FK touches a hot table;
-- abort a blocked deployment quickly while the old API continues to serve traffic.
SET LOCAL lock_timeout = '10s';

CREATE TABLE request_create_attempts (
    key uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('vehicle', 'waste', 'mech', 'service')),
    actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    fingerprint text NOT NULL,
    request_id uuid,
    next_key uuid UNIQUE,
    metadata jsonb,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT request_create_attempts_fingerprint_check CHECK (btrim(fingerprint) <> ''),
    CONSTRAINT request_create_attempts_response_check
        CHECK (response IS NULL OR request_id IS NOT NULL),
    CONSTRAINT request_create_attempts_tombstone_check
        CHECK (next_key IS NULL OR (request_id IS NULL AND metadata IS NULL AND response IS NULL))
);
