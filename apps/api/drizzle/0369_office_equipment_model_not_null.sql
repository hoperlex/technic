-- Every office equipment card refers to its model: release B of the consumables transition
-- (ADR 0132, decision 3; plan `docs/office-equipment-consumables-plan.md`, §5). Release A (0171)
-- added `office_equipment.model_id` as a nullable column, built the model directory from the fleet
-- and put the name mirror into the schema; this release closes the expand step with `NOT NULL`.
-- Release C — the trigger without its legacy branch — is a later release, never this one.
--
-- WHY THE GUARD BELOW CANNOT PLAUSIBLY FIRE (ADR 0132 named "a week of release A code on prod and a
-- zero count of cards without a model" as the condition; prod is not measured, so the count is
-- replaced by the guard, rule S-10 of the roadmap). A card without a model needs a write that
-- bypasses `office_equipment_model_mirror`, and none exists:
--   · 0171 ended with its own guard "no card without a model", and prod applied it;
--   · the mirror is the only trigger on `office_equipment`, `ENABLE ALWAYS` (so even
--     `session_replication_role = replica` runs it), and no migration since 0171, no script, worker
--     or route disables or replaces it;
--   · every branch of the mirror ends with a model id or a raise: an insert or update without a
--     model id resolves the card by "type + spelling key" and creates the missing model, and a
--     blank name raises before anything is written;
--   · the foreign key to the model is `ON DELETE RESTRICT`, so deleting a model never nulls a card.
-- The re-parse and backfill below are the idempotent repeat ADR 0132 promised for this release.
-- After them a card stays without a model only when its name has an empty spelling key — which
-- `office_equipment_name_not_blank_check` (0104) together with the mirror's own raise has ruled out
-- since 0171. The guard therefore exists to fail with card numbers instead of the bare "column
-- contains null values" if that reasoning is ever broken.
--
-- WHY IT SURVIVES THIS MIGRATION'S WINDOW (migrations run while the portal is up and before the
-- restart — AGENTS.md, `docs/runbook.md`). The code serving during the window is the previous
-- release, and it still inserts a card with `model_id = NULL` when a client sends only `name`
-- (`insertEquipmentCard`, `modelId: b.modelId ?? null`). That insert keeps working: PostgreSQL
-- checks `NOT NULL` after `BEFORE` row triggers, and the mirror fills `model_id` first. The same
-- holds for the previous release's PATCH by name and for its file import (which already writes the
-- model id). No portal bundle the prod floor admits sends `name` at all.
--
-- ROLLBACK. Code: the previous release writes through the same mirror, so it is compatible with this
-- schema while it keeps serving.
-- The previous server REFUSES to start on a schema with migrations its image does not know
-- (`assertMigrationsApplied`, "База новее кода"), so a code-only `--previous` after this release
-- cannot boot; schema rollback needs PITR to the pre-migration state and the matching code image.
-- The pre-migration dump is rejected by `restore_gate` after this file commits (runbook, «Откат»).
-- Schema: `ALTER TABLE office_equipment ALTER COLUMN model_id DROP NOT
-- NULL` is safe at any time; the backfilled links are correct data and stay.

-- ── 0. Lock timeout ──
--
-- The `LOCK` below takes ACCESS EXCLUSIVE on `office_equipment`. Migrations run while the previous
-- release serves (`docs/runbook.md`), so a long transaction on that table makes this request wait,
-- and every later query that conflicts with it queues behind the waiting request: the portal hangs
-- with no error. With the timeout the wait ends after 10 s with SQLSTATE 55P03 "canceling statement
-- due to lock timeout": the file rolls back whole, `deploy-auto` stops before the restart, the old
-- release keeps serving, and the same deploy is rerun (runbook, "A migration fails with canceling
-- statement due to lock timeout"). `SET LOCAL` ends with this file only because the runner wraps
-- each file in its own transaction (`applyMigrations`, `apps/api/src/db/migration-journal.ts`);
-- outside a transaction it would do nothing.
SET LOCAL lock_timeout = '10s';

-- ── 1. Lock ──
--
-- First, before the fleet is read, for the reason 0171 gives at its first line: between a snapshot
-- of names and the lock, a writer could add or rename a card the snapshot does not know, and the
-- guard would cancel the deploy. `ACCESS EXCLUSIVE` is what `SET NOT NULL` takes anyway; taking it
-- here makes the order of steps explicit rather than a side effect.
LOCK TABLE office_equipment IN ACCESS EXCLUSIVE MODE;

-- ── 2. Re-parse: models for cards that have none ──
--
-- The rule of 0171 step 3, word for word (canon = the most frequent normalized spelling in the
-- "type + key" group, ties broken lexicographically), narrowed to cards without a model: a linked
-- card's name is its model's name by the mirror, so it can add nothing. A blank key is skipped
-- here and left to the guard — inserting it would stop the migration on
-- `office_equipment_models_name_not_blank_check`, a name that tells the operator nothing.
WITH variants AS (
  SELECT equipment_type_id,
         office_equipment_model_key(name) AS key,
         office_equipment_model_name_normalize(name) AS spelling,
         count(*) AS cards
    FROM office_equipment
   WHERE model_id IS NULL
     AND office_equipment_model_key(name) <> ''
   GROUP BY 1, 2, 3
), canon AS (
  SELECT DISTINCT ON (equipment_type_id, key) equipment_type_id, key, spelling
    FROM variants
   ORDER BY equipment_type_id, key, cards DESC, spelling
)
INSERT INTO office_equipment_models (equipment_type_id, name)
SELECT equipment_type_id, spelling FROM canon
ON CONFLICT DO NOTHING;

-- ── 3. Backfill ──
--
-- The same pair as the parse. Only `model_id` is set: the mirror sees a changed link and copies
-- the model's name into the card itself, so the spelling is aligned by the one rule that does it
-- everywhere else. `updated_at` is not touched — linking a card to its model is not an edit of it.
UPDATE office_equipment e
   SET model_id = m.id
  FROM office_equipment_models m
 WHERE e.model_id IS NULL
   AND m.equipment_type_id = e.equipment_type_id
   AND office_equipment_model_key(m.name) = office_equipment_model_key(e.name);

-- ── 4. Guard ──
--
-- Names the cards the backfill could not link, so the operator knows which rows to fix by hand
-- (give the card a non-blank model name and rerun the deploy). A raise rolls back the whole file,
-- and the previous release keeps serving on the release A schema.
DO $$
DECLARE
  orphans bigint;
  sample text;
BEGIN
  SELECT count(*),
         string_agg(format('%s «%s» inv. %s s/n %s', id, name, inventory_number, serial_number),
                    '; ' ORDER BY created_at, id)
           FILTER (WHERE rn <= 20)
    INTO orphans, sample
    FROM (SELECT id, name, inventory_number, serial_number, created_at,
                 row_number() OVER (ORDER BY created_at, id) AS rn
            FROM office_equipment
           WHERE model_id IS NULL) AS o;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'office_equipment_model_not_null: % office equipment card(s) still have no model after the backfill (first 20: %)',
      orphans, sample;
  END IF;
END $$;

-- ── 5. The contract ──
--
-- `SET NOT NULL` scans the table once under the lock already held (a few hundred rows). From here
-- every reader may rely on the link; the mirror keeps resolving writes by name until release C,
-- because the previous release still serves this migration's window through that branch.
ALTER TABLE office_equipment ALTER COLUMN model_id SET NOT NULL;
