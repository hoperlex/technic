// Deliberately NOT `src/config.ts`: it validates the whole environment on import, so with a floor
// below the requirement it would throw before this script could explain the refusal.
import {
  CLIENT_FLOOR_PASS_MARKER,
  CLIENT_FLOOR_REFUSED_MARKER,
  clientFloorPreflight,
  judgeClientFloor,
  parseServedContract,
} from '../src/lib/client-floor';

/**
 * Client floor preflight — a release gate of `deploy-auto` (ADR 0226).
 *
 * WHAT IT ANSWERS. Will the API of THIS image start with the floor that `prod.env` holds? In
 * production the API refuses to start when `MIN_CLIENT_CONTRACT` is below `REQUIRED_CLIENT_FLOOR`
 * (`src/config.ts`), and without this question the refusal shows up only at the health check:
 * after the dump, after the migrations, with the old containers replaced — the portal is down, and
 * `--previous` returns code, not schema.
 *
 * WHERE IT RUNS. From `deploy-auto`, right after the build and before the captcha preflight, the
 * vhost sync, `--cutover` and the migration status check: as the `migrate` service of the CANDIDATE
 * image (`TAG=$COMMIT_SHA`). Both sides are therefore read the way the new `technic-api` will read
 * them — the requirement from the code that is about to run, the floor through the same `env_file`
 * and the same zod schema (an empty or non-numeric value fails there, while the shell's
 * `tr -dc 0-9` would read it as a number).
 *
 * ARGUMENTS. `--served=<N>` — the contract of the bundle served now, read by `deploy-auto` from the
 * running revision. It only shapes the advice (`--client-floor=N` is refused above it); empty means
 * unknown. The `--` that `pnpm run … -- --served=N` passes through is ignored.
 *
 * ANSWER. The last stdout line is a marker — `client-floor pass` with exit code 0, or
 * `client-floor refused` with exit code 3 after the reason and the command to run. `deploy-auto`
 * takes only a marker and its code together as an answer: `pnpm --filter` exits 0 in silence when
 * the script is missing. Anything else (1 for a bad argument, a crash, no marker) means the check
 * did not run, and `deploy-auto` refuses too: nothing has changed yet, and passing blindly is
 * exactly the outage this gate prevents.
 *
 * Usage:
 *   TAG=<sha> docker compose -f deploy/docker-compose.yml -p technic run --rm -T migrate \
 *     pnpm --silent --filter @technic/api check:client-floor -- --served=7
 *   MIN_CLIENT_CONTRACT=4 pnpm --filter @technic/api check:client-floor
 */

const EXIT_BAD_ARGUMENT = 1;

function main(argv: readonly string[]): number {
  let servedRaw: string | undefined;
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg.startsWith('--served=')) {
      servedRaw = arg.slice('--served='.length);
      continue;
    }
    process.stdout.write(
      `client-floor-check: неизвестный аргумент ${arg} (ожидается --served=<контракт>)\n`,
    );
    return EXIT_BAD_ARGUMENT;
  }

  const verdict = judgeClientFloor(process.env.MIN_CLIENT_CONTRACT);
  const report = clientFloorPreflight(verdict, parseServedContract(servedRaw));
  const marker = report.exitCode === 0 ? CLIENT_FLOOR_PASS_MARKER : CLIENT_FLOOR_REFUSED_MARKER;
  process.stdout.write(`${[...report.lines, marker].join('\n')}\n`);
  return report.exitCode;
}

process.exitCode = main(process.argv.slice(2));
