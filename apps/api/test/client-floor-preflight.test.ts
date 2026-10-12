import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_FLOOR_REFUSED,
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
 *   3. the release itself — never requires a floor above its own bundle's contract.
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
