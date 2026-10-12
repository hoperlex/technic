import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_FLOOR_PASS_MARKER,
  CLIENT_FLOOR_REFUSED,
  CLIENT_FLOOR_REFUSED_MARKER,
  REQUIRED_CLIENT_FLOOR,
  clientFloorPreflight,
  judgeClientFloor,
  parseServedContract,
} from '../src/lib/client-floor';

/**
 * Client floor preflight of `deploy-auto` (ADR 0226).
 *
 * What is guarded, layer by layer, because each layer breaks on its own:
 *   1. the verdict — the same answer the API's startup check would give for every floor state:
 *      equal, higher, lower, unset (the API reads 1) and unreadable (the API does not start);
 *   2. the advice — a refusal names the command that will actually work: `--client-floor=N` only
 *      when the served bundle already carries contract N, otherwise the release that must come first;
 *   3. the shell wiring — the block of `deploy-auto.sh` itself, run under bash with a stand-in for
 *      `docker compose`: an answer is a marker with its exit code, and silence (a missing script
 *      exits 0 under `pnpm --filter`) refuses instead of passing;
 *   4. the placement — before anything that changes the site, after the candidate image exists;
 *   5. the release itself — never requires a floor above its own bundle's contract.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEPLOY_AUTO = 'deploy/deploy-auto.sh';
const WEB_CONTRACT = 'apps/web/src/shared/api/clientContract.ts';

function readRepoFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

describe('client floor: verdict on the raw prod.env value', () => {
  it('equal to the requirement passes', () => {
    expect(judgeClientFloor('3', 3)).toEqual({
      kind: 'pass',
      required: 3,
      configured: 3,
      defaulted: false,
    });
  });

  it('above the requirement passes: the floor rises release after release', () => {
    expect(judgeClientFloor('7', 3)).toMatchObject({ kind: 'pass', configured: 7 });
  });

  it('below the requirement is refused', () => {
    expect(judgeClientFloor('6', 7)).toEqual({
      kind: 'below',
      required: 7,
      configured: 6,
      defaulted: false,
    });
  });

  /**
   * Unset is not "unknown, let it pass": the API reads it as 1, so the preflight does too. Any
   * other reading would mispredict the startup it exists to predict.
   */
  it('unset is judged as the API reads it — the default 1', () => {
    expect(judgeClientFloor(undefined, 3)).toEqual({
      kind: 'below',
      required: 3,
      configured: 1,
      defaulted: true,
    });
    expect(judgeClientFloor(undefined, 1)).toMatchObject({ kind: 'pass', defaulted: true });
  });

  /** These values fail the API's own schema: it would not start, whatever the requirement. */
  it.each(['', 'abc', '4.5', '0', '-3'])('unreadable value %j is refused', (raw) => {
    expect(judgeClientFloor(raw, 1)).toEqual({ kind: 'unreadable', required: 1, raw });
  });

  it('the served contract is a positive integer or unknown', () => {
    expect(parseServedContract('7')).toBe(7);
    expect(parseServedContract(' 6 ')).toBe(6);
    expect(parseServedContract('')).toBeNull();
    expect(parseServedContract(undefined)).toBeNull();
    expect(parseServedContract('0')).toBeNull();
    expect(parseServedContract('7a')).toBeNull();
  });

  /**
   * The R1 expectation, pinned on purpose. Production runs with a floor of at least
   * `CONFIRMED_PRODUCTION_FLOOR` (set by the operator before 12.10.2026), so this release must pass
   * there. A release that raises `REQUIRED_CLIENT_FLOOR` above it fails here — and that is the
   * point: it may do so only after the floor operation is confirmed on production, and whoever
   * confirms it updates the number below (ADR 0226, the R1 → floor 7 → R2 sequence).
   */
  it('this release passes on the floor confirmed on production', () => {
    const CONFIRMED_PRODUCTION_FLOOR = 4;
    expect(judgeClientFloor(String(CONFIRMED_PRODUCTION_FLOOR)).kind).toBe('pass');
  });
});

describe('client floor: what the refusal tells the operator', () => {
  const below = judgeClientFloor('6', 7);

  it('a pass says both numbers and exits 0', () => {
    const report = clientFloorPreflight(judgeClientFloor('7', 7), 7);
    expect(report.exitCode).toBe(0);
    expect(report.lines.join('\n')).toMatch(/не ниже 7.*MIN_CLIENT_CONTRACT=7.*пройдено/);
  });

  it('served contract at the requirement: raise the floor, then repeat the deploy', () => {
    const report = clientFloorPreflight(below, 7);
    const text = report.lines.join('\n');
    expect(report.exitCode).toBe(CLIENT_FLOOR_REFUSED);
    expect(text).toMatch(/MIN_CLIENT_CONTRACT=6/);
    expect(text).toMatch(/Ничего не изменено/);
    expect(text).toMatch(/^ {4}deploy-auto --client-floor=7$/m);
    expect(text).toMatch(/^ {4}deploy-auto$/m);
  });

  /**
   * `--client-floor=7` refuses a floor above the served contract, so advising it here would send
   * the operator into a second refusal. The way out is the release that carries contract 7 first.
   */
  it('served contract below the requirement: the contract release first, not the floor', () => {
    const text = clientFloorPreflight(below, 6).lines.join('\n');
    expect(text).toMatch(/Раздаётся контракт 6 — ниже 7/);
    expect(text).toMatch(/сначала выкатите выпуск, чья сборка несёт CLIENT_CONTRACT/i);
    expect(text).not.toMatch(/^ {4}deploy-auto --client-floor=7$/m);
  });

  it('served contract unknown: how to read it, and both branches', () => {
    const text = clientFloorPreflight(below, null).lines.join('\n');
    expect(text).toMatch(/deploy-auto --client-floor покажет/);
    expect(text).toMatch(/Если он не ниже 7 — deploy-auto --client-floor=7/);
  });

  it('unset floor says so instead of printing an invented value', () => {
    const text = clientFloorPreflight(judgeClientFloor(undefined, 3), 6).lines.join('\n');
    expect(text).toMatch(/MIN_CLIENT_CONTRACT не задан \(сервер берёт 1\)/);
  });

  it('an unreadable value is named, cut, and refused', () => {
    const report = clientFloorPreflight(judgeClientFloor('x'.repeat(100), 3), 6);
    const text = report.lines.join('\n');
    expect(report.exitCode).toBe(CLIENT_FLOOR_REFUSED);
    expect(text).toMatch(/не стартует вовсе/);
    expect(text).toMatch(/x{40}…/);
    expect(text).not.toMatch(/x{41}/);
  });
});

/**
 * The preflight block of `deploy-auto.sh`, cut out of the real file: from its first statement to
 * the captcha preflight that follows it. Testing a copy would prove nothing about the script.
 */
function preflightBlock(): string {
  const script = readRepoFile(DEPLOY_AUTO);
  const start = script.indexOf('FLOOR_SERVED="$(client_contract_deployed');
  const end = script.indexOf('\n# Captcha preflight', start);
  if (start < 0 || end < 0) throw new Error(`${DEPLOY_AUTO}: блок предпроверки пола не найден`);
  return script.slice(start, end);
}

type Run = { status: number | null; stdout: string; stderr: string };

/**
 * Runs the block under bash. `docker compose` is replaced by a function: in `real` mode it drops
 * `run --rm -T migrate` and executes the rest — the actual `pnpm … check:client-floor` command of
 * the script, against the actual CLI; in the other modes it imitates what a broken image answers.
 */
function runBlock(mode: string, env: Record<string, string> = {}, served = '6'): Run {
  const prelude = `
set -euo pipefail
log()  { echo "==> $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }
client_contract_deployed() { printf '%s' "$STUB_SERVED"; }
fake_compose() {
  [ "$1 $2 $3 $4" = "run --rm -T migrate" ] || { echo "unexpected compose call: $*" >&2; return 99; }
  shift 4
  case "$STUB_MODE" in
    real)     "$@" ;;
    silent)   return 0 ;;
    crash)    echo "Error: boom" >&2; return 1 ;;
    mismatch) echo "${CLIENT_FLOOR_REFUSED_MARKER}"; return 0 ;;
  esac
}
COMPOSE=(fake_compose)
COMMIT_SHA=abc1234
PROD_ENV=/etc/technic-portal/prod.env
`;
  const result = spawnSync(
    'bash',
    ['-c', `${prelude}\n${preflightBlock()}\necho AFTER-PREFLIGHT`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        STUB_MODE: mode,
        STUB_SERVED: served,
        ...env,
      },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('deploy-auto: the preflight block under bash', () => {
  it('a pass continues the deploy and prints the verdict', { timeout: 60_000 }, () => {
    const run = runBlock('real', { MIN_CLIENT_CONTRACT: String(REQUIRED_CLIENT_FLOOR) });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/пройдено/);
    expect(run.stdout).toMatch(/AFTER-PREFLIGHT/);
    // The marker is transport, not text for the operator.
    expect(run.stdout).not.toMatch(new RegExp(`^ *${CLIENT_FLOOR_PASS_MARKER}$`, 'm'));
  });

  it('a low floor stops the deploy with the command to run', { timeout: 60_000 }, () => {
    const run = runBlock('real', {}, String(REQUIRED_CLIENT_FLOOR));
    expect(run.status).toBe(1);
    expect(run.stdout).not.toMatch(/AFTER-PREFLIGHT/);
    expect(run.stderr).toMatch(new RegExp(`deploy-auto --client-floor=${REQUIRED_CLIENT_FLOOR}`));
    expect(run.stderr).toMatch(/ОШИБКА: предпроверка пола клиента отказала/);
  });

  it('an unreadable floor stops the deploy', { timeout: 60_000 }, () => {
    const run = runBlock('real', { MIN_CLIENT_CONTRACT: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/не стартует вовсе/);
  });

  /** `pnpm --filter <pkg> <missing-script>` exits 0 in silence: a bare code 0 is not a pass. */
  it('silence with exit code 0 refuses instead of passing', () => {
    const run = runBlock('silent');
    expect(run.status).toBe(1);
    expect(run.stdout).not.toMatch(/AFTER-PREFLIGHT/);
    expect(run.stderr).toMatch(/выполнить не удалось \(код 0, ответа нет\)/);
  });

  it('a crash refuses and shows what the check printed', () => {
    const run = runBlock('crash');
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Error: boom/);
    expect(run.stderr).toMatch(/выполнить не удалось \(код 1/);
  });

  it('a marker that contradicts its exit code is not an answer', () => {
    const run = runBlock('mismatch', { CLIENT_FLOOR_REFUSED_MARKER });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/выполнить не удалось/);
  });

  it('the markers the shell matches are the ones the CLI prints', () => {
    const block = preflightBlock();
    expect(block).toContain(`grep -qx '${CLIENT_FLOOR_PASS_MARKER}'`);
    expect(block).toContain(`grep -qx '${CLIENT_FLOOR_REFUSED_MARKER}'`);
    expect(block).toContain(`[ "$floor_rc" -eq ${CLIENT_FLOOR_REFUSED} ]`);
  });
});

describe('deploy-auto: where the preflight stands', () => {
  const script = readRepoFile(DEPLOY_AUTO);
  const at = (needle: string, from = 0): number => {
    const index = script.indexOf(needle, from);
    expect(index, `${DEPLOY_AUTO}: не найдено ${needle}`).toBeGreaterThan(0);
    return index;
  };
  const build = at('"${COMPOSE[@]}" build "${SERVICES[@]}"');
  const preflight = at('check:client-floor -- "--served=$FLOOR_SERVED"');

  it('after the candidate image is built — it is asked, not the working tree', () => {
    expect(preflight).toBeGreaterThan(build);
  });

  it.each([
    ['the captcha preflight', '--profile tools run --rm -T captcha-check'],
    ['the vhost sync', '\nsync_vhost\n'],
    ['--cutover', '\n  cutover_run\n'],
    [
      'the migration status check',
      'run --rm -T migrate pnpm --silent --filter @technic/api db:migrate:check',
    ],
  ])('before %s', (_name, needle) => {
    expect(preflight).toBeLessThan(at(needle, build));
  });

  it('before the migrations of the plain deploy', () => {
    expect(preflight).toBeLessThan(script.lastIndexOf('"${COMPOSE[@]}" run --rm -T migrate ||'));
  });

  it('the image carries the script the shell calls', () => {
    const pkg = JSON.parse(readRepoFile('apps/api/package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:client-floor']).toBe('tsx scripts/client-floor-check.ts');
    expect(() => readRepoFile('apps/api/scripts/client-floor-check.ts')).not.toThrow();
  });

  /** The preflight reads the floor through `migrate`; it predicts the API only if their env is one. */
  it('migrate starts with the same environment as technic-api', () => {
    const compose = readRepoFile('deploy/docker-compose.yml');
    const service = (name: string): string => {
      const start = compose.indexOf(`\n  ${name}:\n`);
      expect(start, `deploy/docker-compose.yml: нет сервиса ${name}`).toBeGreaterThan(0);
      const next = compose.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
      return compose.slice(start, next < 0 ? undefined : start + 1 + next);
    };
    expect(service('technic-api')).toMatch(/\n {4}<<: \*common-env\n/);
    expect(service('migrate')).toMatch(/\n {4}<<: \*common-env\n/);
    expect(service('migrate')).not.toMatch(/MIN_CLIENT_CONTRACT/);
  });
});

describe('the release requires no more than its own bundle carries', () => {
  /**
   * The bundle's number read the way `deploy-auto` reads it (`client_contract_deployed`): the same
   * pattern pins the line format, because `--client-floor=N` checks its precondition with it.
   */
  it('REQUIRED_CLIENT_FLOOR <= CLIENT_CONTRACT of the web bundle', () => {
    expect(readRepoFile(DEPLOY_AUTO)).toContain(
      "sed -n 's/^export const CLIENT_CONTRACT = \\([0-9]\\{1,\\}\\);.*/\\1/p'",
    );
    const matches = [
      ...readRepoFile(WEB_CONTRACT).matchAll(/^export const CLIENT_CONTRACT = ([0-9]+);/gm),
    ];
    expect(matches, `${WEB_CONTRACT}: строка CLIENT_CONTRACT не в том виде`).toHaveLength(1);
    const contract = Number(matches[0]![1]);
    // A release above its own bundle would answer 426 to every freshly opened tab.
    expect(REQUIRED_CLIENT_FLOOR).toBeLessThanOrEqual(contract);
  });
});
