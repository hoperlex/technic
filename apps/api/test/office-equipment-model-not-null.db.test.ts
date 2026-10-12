import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * Every office equipment card refers to its model — release B of the consumables transition
 * (ADR 0132, decision 3): the migration whose name ends in `_office_equipment_model_not_null.sql`.
 *
 * WHAT IS CLAIMED.
 *   · After the migration `office_equipment.model_id` is `NOT NULL`, and the previous release's
 *     insert without a model id — the statement it issues while it serves this migration's window —
 *     still succeeds: the mirror trigger fills the link before the constraint is checked.
 *   · The re-parse and backfill link every card that has none, by the rule of 0171: an existing
 *     model is found by its spelling key, a missing one is created with the most frequent spelling,
 *     the card takes the model's name, and `updated_at` is not touched.
 *   · A card the backfill cannot link (an empty spelling key) stops the migration by the guard,
 *     which names the card, instead of `SET NOT NULL` failing with a bare "contains null values".
 *   · The file is idempotent: rerun on a migrated database it changes nothing.
 *
 * WHY THE SQL IS TAKEN FROM THE FILE. The migration is applied by `applyMigrations` in `beforeAll`,
 * and the journal will not run it twice — yet its work has to be checked on live rows. So each case
 * rebuilds the state before it inside a transaction (the release A schema: the column nullable and,
 * where cards without a link are needed, the mirror switched off while they are inserted), runs the
 * file's text as is and rolls everything back. The file is found by its name, not its number — a
 * parallel stream may take the number, and the integrator renumbers.
 *
 * The migration locks `office_equipment` exclusively inside each case's transaction, so this file
 * wants its own database or a run with one worker:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55979/technic_test \
 *     npx vitest run office-equipment-model-not-null --maxWorkers=1
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like every `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

const MIGRATION_SUFFIX = '_office_equipment_model_not_null.sql';

const MIGRATION_SQL = ((): string => {
  const files = listMigrationFiles().filter((name) => name.endsWith(MIGRATION_SUFFIX));
  if (files.length !== 1) {
    throw new Error(`expected exactly one migration *${MIGRATION_SUFFIX}, found ${files.length}`);
  }
  return readMigration(files[0]!);
})();

/** The release A state this migration starts from: the link nullable. */
const RELEASE_A_COLUMN = 'ALTER TABLE office_equipment ALTER COLUMN model_id DROP NOT NULL';

let client: pg.Client;
let typeId: string;
let cardNo = 0;

interface CardRow {
  model_id: string | null;
  name: string;
  updated_at: string;
}

/** A site for the case's cards, created inside its transaction and rolled back with it. */
async function makeObject(tag: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO construction_objects (code, name, address)
     VALUES ($1, $2, 'г Москва, ул Тестовая, д 1') RETURNING id`,
    [`OENN-${RUN}-${tag}`, `Площадка моделей ${RUN} ${tag}`],
  );
  return res.rows[0]!.id;
}

/** A card the way any writer inserts it: a name, and a model id only when given. */
async function insertCard(objectId: string, name: string, modelId: string | null = null) {
  cardNo += 1;
  const res = await client.query<{ id: string }>(
    `INSERT INTO office_equipment (equipment_type_id, model_id, name, inventory_number, object_id,
                                   location, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'к1', '2026-09-01T10:00:00Z') RETURNING id`,
    [typeId, modelId, name, `OENN-${RUN}-${cardNo}`, objectId],
  );
  return res.rows[0]!.id;
}

async function cardOf(id: string): Promise<CardRow> {
  const res = await client.query<CardRow>(
    `SELECT model_id, name, updated_at::text AS updated_at FROM office_equipment WHERE id = $1`,
    [id],
  );
  return res.rows[0]!;
}

async function modelsByKey(name: string): Promise<{ id: string; name: string }[]> {
  const res = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM office_equipment_models
      WHERE equipment_type_id = $1
        AND office_equipment_model_key(name) = office_equipment_model_key($2)`,
    [typeId, name],
  );
  return res.rows;
}

async function columnIsNullable(): Promise<boolean> {
  const res = await client.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'office_equipment'
        AND column_name = 'model_id'`,
  );
  return res.rows[0]!.is_nullable === 'YES';
}

/** Cards without a link, inserted the only way they can exist: past the mirror, on release A. */
async function withoutMirror(insert: () => Promise<void>): Promise<void> {
  await client.query('ALTER TABLE office_equipment DISABLE TRIGGER office_equipment_model_mirror');
  await insert();
  await client.query(
    'ALTER TABLE office_equipment ENABLE ALWAYS TRIGGER office_equipment_model_mirror',
  );
}

describe.skipIf(!DB_URL)('office_equipment.model_id NOT NULL: backfill, guard, constraint', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
    const type = await client.query<{ id: string }>(
      `SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    if (!type.rows[0]) throw new Error('no office equipment types: migration 0104 is not applied');
    typeId = type.rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  it('the migrated schema carries NOT NULL, and no card is without a model', async () => {
    expect(await columnIsNullable()).toBe(false);
    const orphans = await client.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM office_equipment WHERE model_id IS NULL',
    );
    expect(orphans.rows[0]!.c).toBe(0);
  });

  it('the previous release inserts without a model id, and the mirror links it first', async () => {
    await client.query('BEGIN');
    try {
      const objectId = await makeObject('old');
      const name = `Kyocera ECOSYS M2040 ${RUN}`;
      // Exactly the previous release's statement when a client names the model in words:
      // `model_id` explicitly NULL. It must not fail on the constraint.
      const id = await insertCard(objectId, `  KYOCERA   ECOSYS M2040 ${RUN} `);
      const row = await cardOf(id);
      expect(row.model_id).not.toBeNull();
      const models = await modelsByKey(name);
      expect(models).toHaveLength(1);
      expect(row.model_id).toBe(models[0]!.id);
      // Nulling the link by an edit resolves it again instead of failing.
      await client.query('UPDATE office_equipment SET model_id = NULL WHERE id = $1', [id]);
      expect((await cardOf(id)).model_id).toBe(models[0]!.id);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('backfill links every card by the rule of 0171 and touches nothing else', async () => {
    await client.query('BEGIN');
    try {
      await client.query(RELEASE_A_COLUMN);
      const objectId = await makeObject('bf');
      const known = `Ricoh IM 350 ${RUN}`;
      const fresh = `Pantum M6500 ${RUN}`;
      // A model already in the directory, and a card linked to it the normal way.
      const linked = await insertCard(objectId, known);
      const knownModel = (await cardOf(linked)).model_id!;

      const ids: Record<string, string> = {};
      await withoutMirror(async () => {
        // A card of a known model, spelled differently: it must join that model.
        ids.upper = await insertCard(objectId, known.toUpperCase());
        // A model nobody created yet, in two spellings: the frequent one wins the canon.
        ids.freshA = await insertCard(objectId, fresh.toUpperCase());
        ids.freshB = await insertCard(objectId, fresh.toUpperCase());
        ids.freshC = await insertCard(objectId, `${fresh.replace(' ', '  ')}`);
      });
      for (const id of Object.values(ids)) expect((await cardOf(id)).model_id).toBeNull();
      const before = new Map<string, CardRow>();
      for (const id of [...Object.values(ids), linked]) before.set(id, await cardOf(id));

      await client.query(MIGRATION_SQL);

      expect(await columnIsNullable()).toBe(false);
      const upper = await cardOf(ids.upper!);
      expect(upper.model_id).toBe(knownModel);
      expect(upper.name).toBe(known);

      const freshModels = await modelsByKey(fresh);
      expect(freshModels).toHaveLength(1);
      expect(freshModels[0]!.name).toBe(fresh.toUpperCase());
      for (const id of [ids.freshA!, ids.freshB!, ids.freshC!]) {
        const row = await cardOf(id);
        expect(row.model_id).toBe(freshModels[0]!.id);
        expect(row.name).toBe(fresh.toUpperCase());
      }
      // Linking a card to its model is not an edit of it, and a linked card is not touched at all.
      for (const id of Object.values(ids)) {
        expect((await cardOf(id)).updated_at).toBe(before.get(id)!.updated_at);
      }
      expect(await cardOf(linked)).toEqual(before.get(linked));
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('the guard stops the migration and names a card the backfill cannot link', async () => {
    await client.query('BEGIN');
    try {
      await client.query(RELEASE_A_COLUMN);
      const objectId = await makeObject('guard');
      let id = '';
      await withoutMirror(async () => {
        // A name of one no-break space: `btrim` keeps it non-empty (0104's CHECK passes), but its
        // spelling key is empty, so no model can be found or created for it.
        id = await insertCard(objectId, ' ');
      });

      await client.query('SAVEPOINT migration');
      let message = '';
      try {
        await client.query(MIGRATION_SQL);
      } catch (e) {
        message = (e as Error).message;
      }
      await client.query('ROLLBACK TO SAVEPOINT migration');

      expect(message).toContain('office_equipment_model_not_null');
      expect(message).toContain(id);
      // The raise came from the guard, before the constraint: the column is still nullable.
      expect(await columnIsNullable()).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('rerun on a migrated database changes nothing', async () => {
    await client.query('BEGIN');
    try {
      const count = async (table: string) =>
        (await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`)).rows[0]!.c;
      const models = await count('office_equipment_models');
      await client.query(MIGRATION_SQL);
      expect(await count('office_equipment_models')).toBe(models);
      expect(await columnIsNullable()).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
