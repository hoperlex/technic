import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = readFileSync(join(repoRoot, 'deploy/deploy-auto.sh'), 'utf8');
// The R1 revision keeps these cases stable when HEAD later raises the requirement for R2.
const R1_REVISION = '1f6670b6';

/** Exercise the real floor operation through its refusal, before it can touch prod.env. */
function floorOperation(): string {
  const start = script.indexOf('client_floor_current() {');
  const end = script.indexOf('\n# Режим технических работ', start);
  if (start < 0 || end < 0) throw new Error('deploy-auto: client floor operation not found');
  return script.slice(start, end);
}

function runFloor(target: number, revision: string, required?: string) {
  const prelude = `
set -euo pipefail
log() { printf 'LOG: %s\\n' "$*"; }
warn() { printf 'WARN: %s\\n' "$*" >&2; }
fail() { printf 'REFUSED: %s\\n' "$*" >&2; exit 1; }
git_c() {
  if [ -z "$STUB_REQUIRED" ]; then git -C "$STUB_REPO" "$@"; return; fi
  if [ "$1" = cat-file ]; then
    case "$3" in *:apps/api/src/lib/client-floor.ts) return 0;; esac
    return 1
  fi
  if [ "$1" = show ]; then
    case "$2" in
      *:apps/web/src/shared/api/clientContract.ts)
        printf 'export const CLIENT_CONTRACT = 7;\\n'; return 0 ;;
      *:apps/api/src/lib/client-floor.ts)
        printf 'export const REQUIRED_CLIENT_FLOOR = %s;\\n' "$STUB_REQUIRED"; return 0 ;;
    esac
  fi
  return 1
}
DO_CLIENT_FLOOR=1
CLIENT_FLOOR_ARG="$STUB_TARGET"
CURRENT_BEFORE="$STUB_REVISION"
PROD_ENV=/tmp/client-floor-operation-test-no-prod-env
PROD_ENV_EXISTS=0
`;
  return spawnSync('bash', ['-c', `${prelude}\n${floorOperation()}\nprintf 'PASSED-GUARD\\n'`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      STUB_REPO: repoRoot,
      STUB_TARGET: String(target),
      STUB_REVISION: revision,
      STUB_REQUIRED: required ?? '',
    },
  });
}

describe('deploy-auto --client-floor=N: serving API floor', () => {
  it('refuses below the requirement of a served R1 revision before touching prod.env', () => {
    const run = runFloor(2, R1_REVISION);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(
      /пол 2 ниже требования работающего выпуска \(3, REQUIRED_CLIENT_FLOOR/,
    );
    expect(run.stderr).not.toMatch(/нет \/tmp\/client-floor-operation-test-no-prod-env/);
  });

  it('reads the legacy config.ts location for the pre-R1 serving revision', () => {
    const run = runFloor(2, 'dc647215');
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(
      /пол 2 ниже требования работающего выпуска \(3, REQUIRED_CLIENT_FLOOR/,
    );
  });

  it('refuses an R2-style floor of 6 when the serving API requires 7', () => {
    const run = runFloor(6, 'synthetic-r2', '7');
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(
      /пол 6 ниже требования работающего выпуска \(7, REQUIRED_CLIENT_FLOOR/,
    );
    expect(run.stderr).not.toMatch(/нет \/tmp\/client-floor-operation-test-no-prod-env/);
  });

  it('permits a decrease down to the serving requirement', () => {
    const run = runFloor(3, R1_REVISION);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(/нет \/tmp\/client-floor-operation-test-no-prod-env/);
    expect(run.stderr).not.toMatch(/ниже требования работающего выпуска/);
  });

  it('refuses when the serving requirement cannot be read', () => {
    const run = runFloor(6, 'synthetic-r2', 'unknown');
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(/требование пола работающей ревизии/);
    expect(run.stderr).toMatch(/прочитать не удалось — prod.env не изменён/);
  });
});
