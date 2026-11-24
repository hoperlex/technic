import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { personEmployments, personSpecializations } from '../src/db/schema';
import { listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * `schema.ts` and the migration state the same default twice, and nothing else ties them together:
 * drizzle never reads the default back from the database, so a schema edit without its migration
 * (or the reverse) passes every type check and every test that sends an explicit date. This plain
 * test runs in `pnpm check`, unlike the DB regression `person-period-moscow-default.db.test.ts`,
 * so a drift fails the fast gate.
 *
 * The migration is found by its suffix, not its number: parallel streams renumber at push time.
 */
const SUFFIX = '_person_period_moscow_start_default.sql';
const dialect = new PgDialect();

function migrationDefaults(): Map<string, string> {
  const files = listMigrationFiles().filter((name) => name.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  const sql = readMigration(files[0]!);
  const defaults = new Map<string, string>();
  const statement = /ALTER TABLE\s+(\w+)\s+ALTER COLUMN\s+started_on\s+SET DEFAULT\s+([\s\S]+?);/gi;
  for (const match of sql.matchAll(statement)) defaults.set(match[1]!, match[2]!.trim());
  return defaults;
}

function schemaDefault(column: { default: unknown }): string {
  const rendered = dialect.sqlToQuery(column.default as Parameters<PgDialect['sqlToQuery']>[0]);
  expect(rendered.params).toEqual([]);
  return rendered.sql;
}

describe('person period start defaults', () => {
  it('schema.ts states exactly the default the migration installs', () => {
    const defaults = migrationDefaults();
    expect([...defaults.keys()].sort()).toEqual(['person_employments', 'person_specializations']);
    expect(schemaDefault(personEmployments.startedOn)).toBe(defaults.get('person_employments'));
    expect(schemaDefault(personSpecializations.startedOn)).toBe(
      defaults.get('person_specializations'),
    );
  });

  it('is the Moscow calendar day, not the session day', () => {
    for (const expression of migrationDefaults().values()) {
      expect(expression).toBe("(now() AT TIME ZONE 'Europe/Moscow')::date");
    }
  });
});
