import { sql } from 'drizzle-orm';
import type { db as AppDb } from '../src/db/client';

/**
 * The model a test card is created with (ADR 0132, release B).
 *
 * `POST /office-equipment` takes the model by reference only: `name` left the input contract with
 * the `NOT NULL` on `office_equipment.model_id`. Tests that used to name a card's model in words
 * get the reference here instead.
 *
 * The model is found or created by the very rule of the directory — the pair "type + spelling key"
 * with the database's own `office_equipment_model_name_normalize` / `office_equipment_model_key`,
 * the same `ON CONFLICT … DO UPDATE` the name mirror uses (0171). So a run that already created the
 * model, or a parallel file naming the same model, gets the same row instead of a 409, and the
 * model a test now creates is exactly the one the mirror used to create from the old `name`:
 * cleanup that removes models by the run suffix keeps working unchanged.
 */
export async function officeEquipmentModelId(
  db: Pick<typeof AppDb, 'execute'>,
  equipmentTypeId: string,
  name: string,
): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO office_equipment_models (equipment_type_id, name)
    VALUES (${equipmentTypeId}::uuid, office_equipment_model_name_normalize(${name}))
    ON CONFLICT (equipment_type_id, office_equipment_model_key(name))
      DO UPDATE SET name = office_equipment_models.name
    RETURNING id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`no office equipment model «${name}»`);
  return id;
}
