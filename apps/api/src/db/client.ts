import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config';
import * as schema from './schema';

/**
 * Строит пул pg с явным управлением TLS.
 * Параметр `sslmode` вырезается из URL — режим TLS задаётся объектом `ssl`
 * (CA из PGSSLROOTCERT → verify-full к Yandex Managed PostgreSQL).
 */
function buildPool(connectionString: string, poolMax: number): pg.Pool {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  const ssl = config.db.sslCa ? { ca: config.db.sslCa, rejectUnauthorized: true } : false;
  return new pg.Pool({ connectionString: url.toString(), max: poolMax, ssl });
}

export const pool = buildPool(config.db.url, config.db.poolMax);

export const db = drizzle(pool, { schema, casing: 'snake_case' });

export type DB = typeof db;

export async function pingDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
