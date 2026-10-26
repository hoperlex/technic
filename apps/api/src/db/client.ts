import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config';
import { logger } from '../logger';
import { createBoundedPool } from './bounded-pool';
import * as schema from './schema';

/**
 * The `sslmode` parameter is cut from the URL: the `ssl` object sets TLS instead (the CA from
 * PGSSLROOTCERT gives verify-full against Yandex Managed PostgreSQL).
 */
function buildPool(connectionString: string, poolMax: number): pg.Pool {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  const ssl = config.db.sslCa ? { ca: config.db.sslCa, rejectUnauthorized: true } : false;
  return createBoundedPool({
    connectionString: url.toString(),
    ssl,
    max: poolMax,
    connectTimeoutMs: config.db.connectTimeoutMs,
    idleTimeoutMs: config.db.idleTimeoutMs,
    queryTimeoutMs: config.db.queryTimeoutMs,
    onIdleError: (err) => logger.warn({ err }, 'Простаивающее соединение с PostgreSQL оборвалось'),
  });
}

export const pool = buildPool(config.db.url, config.db.poolMax);

export const db = drizzle(pool, { schema, casing: 'snake_case' });

export type DB = typeof db;

/**
 * Readiness asks the same pool the requests use: a separate connection would answer "ready" while
 * every request waits for a client. `pool.query` releases the client with the error, so a failed
 * ping does not put its client back.
 */
export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
