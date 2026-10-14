import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const deployScript = readFileSync(join(repoRoot, 'deploy/deploy-auto.sh'), 'utf8');

function recoverFunction(): string {
  const start = deployScript.indexOf('\nrecover() {');
  const end = deployScript.indexOf('\ntrap recover EXIT', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return deployScript.slice(start + 1, end);
}

describe('deploy-auto recovery advice', () => {
  it('does not offer a pre-migration dump after migrations may have committed', () => {
    // A failed file rolls back, but earlier files in the same deploy can already be committed.
    const shell = `
warn() { printf '%s\\n' "$*" >&2; }
write_report() { :; }
CUTOVER_ACTIVE=0
RESTORE_DB_TOUCHED=0
ROLLBACK_UP_STARTED=0
MIGRATION_ATTEMPTED=1
SERVICES_STOPPED=0
REASON='canceling statement due to lock timeout'
ACTION=deploy
DUMP_FILE=before-migrations.dump
${recoverFunction()}
false || recover
`;
    const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('PITR');
    expect(result.stderr).toContain('restore_gate');
    expect(result.stderr).not.toContain('deploy-auto --previous --restore-db');
  });
});
