import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMigrationFiles, migrationsDir, readMigration } from '../src/db/migration-journal';

describe('request creation receipt release dependency', () => {
  it('ships the receipt table through exactly one numbered migration', () => {
    const creators = listMigrationFiles().filter((name) =>
      /\bCREATE TABLE request_create_attempts\b/.test(readMigration(name)),
    );
    expect(creators).toHaveLength(1);
    expect(creators[0]).toMatch(/^\d{4}_request_create_idempotency\.sql$/);
    expect(existsSync(join(migrationsDir, 'pending', 'request-create-idempotency.sql'))).toBe(
      false,
    );
  });

  it.each([
    ['numbered', 'HEAD:apps/api/drizzle/0384_request_create_idempotency.sql', 0],
    ['pending', 'HEAD:apps/api/drizzle/pending/request-create-idempotency.sql', 3],
    ['absent', '', 3],
    [
      'duplicate',
      'HEAD:apps/api/drizzle/0384_request_create_idempotency.sql\nHEAD:apps/api/drizzle/pending/request-create-idempotency.sql',
      3,
    ],
  ])('deploy preflight %s: candidate DDL is checked before build', (_, matches, status) => {
    const deploy = readFileSync(new URL('../../../deploy/deploy-auto.sh', import.meta.url), 'utf8');
    const start = deploy.indexOf('# The receipt routes can pass health');
    const end = deploy.indexOf('\nCOMMIT_SHA=', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThan(deploy.indexOf('log "build:'));
    const guard = deploy.slice(start, end);
    const result = spawnSync(
      'bash',
      [
        '-c',
        `git_c() { if [ "$1" = cat-file ]; then return 0; fi; if [ "$1" = grep ]; then printf '%s\\n' "$FAKE_MATCHES"; return 0; fi; return 2; }
fail() { printf '%s\\n' "$1" >&2; exit 3; }
${guard}`,
      ],
      { encoding: 'utf8', env: { ...process.env, FAKE_MATCHES: matches } },
    );
    expect(result.status, result.stderr).toBe(status);
    if (status !== 0) expect(result.stderr).toMatch(/SQL в pending не накатывается/);
  });
});
