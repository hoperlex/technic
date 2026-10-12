import { sql } from 'drizzle-orm';
import type { db as AppDb } from '../src/db/client';

/**
 * Put the executor scope switch (ADR 0179) OFF for a file written against release A's model.
 *
 * Since the switch migration (owner decision S-12) every migrated database arrives with
 * `service_request_executor_scope` ON: a holder of the IT or executor grant without another grant of
 * the module sees only the requests assigned to them, created by them or taken off them. The files
 * that call this describe the model with the key OFF — the IT grant's module-wide scope over
 * requests — which stays the documented emergency state (`UPDATE … SET is_enabled = false`) until
 * release B removes `serviceRequests` from the module-wide scope maps. Release B makes OFF equal to
 * ON (the parity case of `service-executor-scope.db.test.ts`) and is the moment these files' scope
 * expectations get rewritten; the ON model itself is covered there, on its own database.
 *
 * NOT RESTORED AFTERWARDS, on purpose. The key is global, and `pnpm check:db` runs files on one
 * shared database in parallel: a file switching it back on in `afterAll` could do so while a
 * sibling that needs it off is mid-run. Every other file passes with the key in either state
 * (checked by running the service request suite both ways), so leaving it off costs nobody.
 */
export async function pinExecutorScopeOff(db: Pick<typeof AppDb, 'execute'>): Promise<void> {
  const res = await db.execute(sql`
    UPDATE feature_flags SET is_enabled = false, updated_at = now()
     WHERE key = 'service_request_executor_scope'`);
  // The row must exist: an UPDATE of a missing row changes nothing silently, and the file would
  // then run in a state nobody chose.
  if (res.rowCount !== 1)
    throw new Error('feature_flags has no service_request_executor_scope row');
}
