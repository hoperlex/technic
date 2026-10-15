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

function shellFunction(name: string): string {
  const start = deployScript.indexOf(`\n${name}() {`);
  const end = deployScript.indexOf('\n}', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return deployScript.slice(start + 1, end + 2);
}

const cutoverAdvice = shellFunction('cutover_recovery_hint');

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

  it.each(['migrating', 'migrated'])(
    'rejects every destructive command in a wide %s window before side effects',
    (phase) => {
      for (const flags of ['previous', 'restore', 'previous restore']) {
        const shell = `
fail() { printf '%s\\n' "$1" >&2; exit 37; }
snapshot_config() { printf 'snapshot\\n'; }
cutover_phase_or_fail() { CUTOVER_PHASE=${phase}; CUTOVER_CANDIDATE=sha-new; CUTOVER_EXTRAS=extra.sql; }
${cutoverAdvice}
${shellFunction('cutover_guard_destructive')}
DO_PREVIOUS=0 DO_RESTORE_DB=0
case ' ${flags} ' in *' previous '*) DO_PREVIOUS=1 ;; esac
case ' ${flags} ' in *' restore '*) DO_RESTORE_DB=1 ;; esac
cutover_guard_destructive
snapshot_config
`;
        const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(37);
        expect(result.stdout).not.toContain('snapshot');
        expect(result.stderr).toContain('PITR');
        expect(result.stderr).not.toContain('--previous --restore-db');
        expect(result.stderr).not.toContain('--cutover-revert');
      }
    },
  );

  it('reports wide and narrow recovery paths without promising a dump rollback', () => {
    const status = shellFunction('cutover_status_line');
    for (const [extras, phase, expected, forbidden] of [
      ['extra.sql', 'migrated', 'PITR', '--cutover-revert'],
      ['', 'migrated', '--cutover-revert', 'PITR'],
      ['', 'migrating', 'сверить журнал', '--cutover-revert'],
    ]) {
      const shell = `
${cutoverAdvice}
cutover_state_read() { CUTOVER_PHASE=${phase}; CUTOVER_CANDIDATE=sha-new; CUTOVER_MIGRATION=main.sql; CUTOVER_EXTRAS=${extras}; CUTOVER_DUMP=pre.dump; }
${status}
cutover_state_read
printf '%s\\n' "$(cutover_status_line)"
printf '%s\\n' "$(cutover_recovery_hint)"
`;
      const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stdout).not.toContain(forbidden);
      expect(result.stdout).not.toContain('--previous --restore-db');
    }
  });

  it.each([
    ['extra.sql', 'PITR', '--cutover-revert'],
    ['', '--cutover-revert', 'PITR'],
  ])('uses phase-aware advice in the failure trap (extras=%s)', (extras, expected, forbidden) => {
    const shell = `
warn() { printf '%s\\n' "$*" >&2; }
write_report() { :; }
${cutoverAdvice}
${recoverFunction()}
CUTOVER_ACTIVE=1 CUTOVER_PHASE=migrated CUTOVER_EXTRAS=${extras}
CUTOVER_STATE=cutover.state SCHEMA_FLOOR_STATE=schema-floor.state
REASON=failed ACTION=cutover
false || recover
`;
    const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain(forbidden);
  });

  it('keeps previous distinct from the pre-cutover current release', () => {
    const rollbackStart = deployScript.indexOf('if [ "$ROLLBACK_MODE" -eq 1 ]; then');
    const rollbackEnd = deployScript.indexOf(
      '  # The rollback recreates the containers',
      rollbackStart,
    );
    expect(rollbackStart).toBeGreaterThanOrEqual(0);
    const rollbackPrelude = deployScript.slice(rollbackStart, rollbackEnd);
    expect(rollbackPrelude).toContain('TARGET_TAG="$PREVIOUS_BEFORE"');
    expect(rollbackPrelude).not.toContain('TARGET_TAG="$CURRENT_BEFORE"');
  });
});
