-- The two requester events in the module mail switch — ENABLED (ADR 0227, decision D6, step M2;
-- the switch table is `module_mail_event_settings`, mechanics — ADR 0159 decision 3).
--
-- ENABLED BY THE RELEASE, NOT AFTER IT (owner decision D6). Unlike the events of ADR 0159, these
-- letters go to the request author — an account of the portal, not an outside contractor — and
-- the owner chose to switch them on with the release. The emergency brake stays where it is: an
-- administrator switches either event off in «Рассылки → События писем» without a deploy.
--
-- THE CHECK IS REPLACED WHOLE, NOT EXTENDED: the list in the constraint is dropped and set again,
-- both commands in the ONE transaction the runner wraps each file in, so there is no moment
-- without the constraint. The list must match `MODULE_MAIL_EVENTS` in the contracts and the
-- `check` of `module_mail_event_settings` in `apps/api/src/db/schema.ts`. The table has one row
-- per event (eleven after this file), so the swap is instant.
--
-- DEPLOY WINDOW. The previous server keeps serving while this runs. It never queues these events
-- (it does not know them); its `GET /admin/mail/events` maps its own registry and ignores rows it
-- does not know, and its `PATCH /admin/mail/events/:event` answers 404 for them. Old
-- `module_mail_recipients` rows are untouched: copies for the new events are an administrator's
-- choice, not the deploy's.
--
-- REVERSIBILITY: delete the two rows and restore the previous CHECK; the previous code neither
-- reads nor lists them. Stopping the letters needs no rollback at all — it is the switch.

-- ── Lock timeout ──
--
-- Replacing the CHECK takes ACCESS EXCLUSIVE on `module_mail_event_settings`: a table of eleven
-- rows, but read on every opening of the service request list and inside every transition that
-- sends a letter. Migrations run while the previous release serves (`docs/runbook.md`), so a long
-- transaction on that table makes this request wait, and every later query that conflicts with it
-- queues behind the waiting request: the module hangs with no error. With the timeout the wait ends
-- after 10 s with SQLSTATE 55P03 "canceling statement due to lock timeout": the file rolls back
-- whole, `deploy-auto` stops before the restart, the old release keeps serving, and the same deploy
-- is rerun (runbook, "A migration fails with canceling statement due to lock timeout"). `SET LOCAL`
-- ends with this file only because the runner wraps each file in its own transaction
-- (`applyMigrations`, `apps/api/src/db/migration-journal.ts`); outside a transaction it would do
-- nothing.
SET LOCAL lock_timeout = '10s';

ALTER TABLE module_mail_event_settings DROP CONSTRAINT module_mail_event_settings_event_check;

ALTER TABLE module_mail_event_settings ADD CONSTRAINT module_mail_event_settings_event_check
  CHECK (event IN (
    'service_request_waiting_it',
    'service_request_cancelled',
    'service_request_assigned',
    'service_request_status_changed',
    'service_request_estimate',
    'service_request_document',
    'service_request_comment',
    'office_equipment_candidate_pending',
    'office_equipment_candidate_decided',
    'service_request_requester_comment',
    'service_request_requester_status'
  ));

-- A row per event: a missing row is read by the application fail-closed, as switched off, and from
-- outside that is indistinguishable from "an administrator switched it off". `updated_by` stays
-- NULL: the deploy flipped these, not a person.
INSERT INTO module_mail_event_settings (event, is_enabled) VALUES
  ('service_request_requester_comment', true),
  ('service_request_requester_status', true);
