import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * `PUBLIC_ORIGIN` check of `deploy-auto` (runbook, "Reload throws the user to the login form").
 *
 * After the October 2026 host move `prod.env` kept the nip.io name of the new IP. Login worked,
 * every `/auth/refresh` got 403, every page reload threw people to the login form, and the deploy
 * reported success. What is guarded here, layer by layer:
 *   1. the comparison — the shell functions cut out of the real script, with the API's own origin
 *      guard as the oracle for "accepted", so a byte-level difference (trailing slash, upper case)
 *      is not waved through as "the same site";
 *   2. the preflight — reads the value the way compose does and only warns, naming both values,
 *      the consequence and the command that fixes it;
 *   3. the probe — exactly one POST to the real refresh route with the portal's Origin, read as
 *      401 ok / 403 wrong origin / anything else neutral;
 *   4. the placement — every mode that recreates the containers is warned before its destructive
 *      step, and both external health checks are followed by the probe.
 */

const cfg = { isProd: true, publicOrigin: 'https://auto.su10.ru' };
vi.mock('../src/config', () => ({ config: cfg }));
const { assertCookieOrigin } = await import('../src/lib/cookies');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEPLOY_AUTO = 'deploy/deploy-auto.sh';
const script = readRepoFile(DEPLOY_AUTO);

function readRepoFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

/** The address the script compares with, read from the script itself rather than restated. */
const HEALTH_EXTERNAL = (() => {
  const match = /^HEALTH_EXTERNAL="([^"]+)"$/m.exec(script);
  if (!match) throw new Error(`${DEPLOY_AUTO}: HEALTH_EXTERNAL не найден`);
  return match[1]!;
})();
/** What a browser on that address sends as Origin. */
const PORTAL_ORIGIN = new URL(HEALTH_EXTERNAL).origin;

/** A function of the real script, from its header to the closing brace at column 0. */
function shellFunction(name: string): string {
  const start = script.indexOf(`\n${name}() {\n`);
  if (start < 0) throw new Error(`${DEPLOY_AUTO}: функция ${name} не найдена`);
  const end = script.indexOf('\n}\n', start);
  return script.slice(start + 1, end + 2);
}

const FUNCTIONS = [
  'maint_env_get',
  'origin_normalize',
  'public_origin_verdict',
  'public_origin_fix_hint',
  'public_origin_preflight',
  'public_origin_probe',
  'external_health',
];

const scratch = mkdtempSync(join(tmpdir(), 'public-origin-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Run = { status: number | null; stdout: string; stderr: string };

/**
 * Runs `body` under bash after the script's own functions. `curl` is a stand-in that records its
 * arguments (one per line, calls separated by `--END--`) and answers as `STUB_HEAD` / `STUB_CODE`
 * say: a HEAD succeeds or fails, a POST prints its code the way `-w '%{http_code}'` does, and `000`
 * stands for "no connection" with curl's non-zero exit.
 */
function bash(body: string, env: Record<string, string> = {}): Run {
  const prelude = `
set -euo pipefail
log()  { echo "==> $*"; }
warn() { echo "!!  $*" >&2; }
curl() {
  { printf '%s\\n' "$@"; echo --END--; } >> "$STUB_CURL_LOG"
  case " $* " in
    *" -fsSI "*) [ "\${STUB_HEAD:-ok}" = ok ] ;;
    *) printf '%s' "\${STUB_CODE:-000}"; [ "\${STUB_CODE:-000}" != 000 ] || return 28 ;;
  esac
}
COMPOSE=(docker compose -f /opt/portals/technic/deploy/docker-compose.yml -p technic)
HEALTH_EXTERNAL='${HEALTH_EXTERNAL}'
PROD_ENV="\${STUB_PROD_ENV:-/nonexistent/prod.env}"
${FUNCTIONS.map(shellFunction).join('\n')}
`;
  const result = spawnSync('bash', ['-c', `${prelude}\n${body}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      STUB_CURL_LOG: join(scratch, 'curl.log'),
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Shell-quoted argument, so the values under test reach bash byte for byte. */
const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function normalize(url: string): string | null {
  const run = bash(`origin_normalize ${q(url)} || echo '<fail>'`);
  expect(run.status, run.stderr).toBe(0);
  return run.stdout === '<fail>\n' ? null : run.stdout;
}

function verdict(raw: string, reference = HEALTH_EXTERNAL): string {
  const run = bash(`public_origin_verdict ${q(raw)} ${q(reference)}`);
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

describe('origin_normalize: the origin as a browser spells it', () => {
  /** Node's URL serialises the origin exactly as browsers put it into the Origin header. */
  it.each([
    'https://auto.su10.ru',
    'https://auto.su10.ru/',
    'HTTPS://Auto.SU10.ru/login?next=/garage#top',
    'https://auto.su10.ru:443/',
    'http://auto.su10.ru:80',
    'https://auto.su10.ru:8443/',
    'https://auto.213-171-26-249.nip.io',
    'https://user:secret@auto.su10.ru/',
  ])('%s', (url) => {
    expect(normalize(url)).toBe(new URL(url).origin);
  });

  it.each(['', 'auto.su10.ru', 'ftp://auto.su10.ru', 'https://', 'https://auto.su10.ru:44x'])(
    'not an http(s) URL: %j',
    (url) => {
      expect(normalize(url)).toBeNull();
    },
  );
});

describe('public_origin_verdict', () => {
  it('equal origins pass, however the reference address is spelled', () => {
    expect(verdict('https://auto.su10.ru', 'https://auto.su10.ru/')).toBe('ok');
    expect(verdict('https://auto.su10.ru', 'https://auto.su10.ru')).toBe('ok');
    expect(verdict('https://auto.su10.ru', 'https://AUTO.su10.ru/')).toBe('ok');
    expect(verdict(PORTAL_ORIGIN)).toBe('ok');
  });

  /**
   * The same site is not enough: the API compares bytes. A trailing slash or an upper-case letter in
   * PUBLIC_ORIGIN refuses every refresh just as a foreign host does, so it must not read as "ok".
   */
  it.each(['https://auto.su10.ru/', 'https://Auto.su10.ru', 'https://auto.su10.ru:443'])(
    'same site, other bytes: %s',
    (raw) => {
      expect(verdict(raw)).toBe('noncanonical');
    },
  );

  it('the nip.io name of the new IP against the portal domain', () => {
    expect(verdict('https://auto.213-171-26-249.nip.io')).toBe('mismatch');
  });

  it('http against https, and another port', () => {
    expect(verdict('http://auto.su10.ru')).toBe('mismatch');
    expect(verdict('https://auto.su10.ru:8443')).toBe('mismatch');
  });

  it('an absent value', () => {
    expect(verdict('')).toBe('absent');
  });

  it('a value that is not an http(s) URL', () => {
    expect(verdict('auto.su10.ru')).toBe('invalid');
    expect(verdict('ftp://auto.su10.ru')).toBe('invalid');
  });

  it('a reference that does not parse leaves nothing to compare with', () => {
    expect(verdict('https://auto.su10.ru', 'auto.su10.ru')).toBe('unknown');
  });

  /**
   * The oracle is the API's own guard, not a second reading of it: "ok" must mean exactly "the
   * refresh of a browser on the portal address is let through".
   */
  it.each([
    'https://auto.su10.ru',
    'https://auto.su10.ru/',
    'https://Auto.su10.ru',
    'https://auto.su10.ru:443',
    'https://auto.213-171-26-249.nip.io',
    'http://auto.su10.ru',
    'https://auto.su10.ru:8443',
  ])('"ok" is what assertCookieOrigin accepts: %s', (raw) => {
    cfg.publicOrigin = raw;
    const req = { headers: { origin: PORTAL_ORIGIN }, log: { warn: vi.fn() } };
    let accepted = true;
    try {
      assertCookieOrigin(req as unknown as FastifyRequest);
    } catch {
      accepted = false;
    }
    expect(verdict(raw) === 'ok').toBe(accepted);
  });
});

describe('public_origin_preflight under bash', () => {
  function preflight(prodEnv: string | null): Run {
    const env: Record<string, string> = {};
    if (prodEnv !== null) {
      const file = join(scratch, `prod-${Math.random().toString(36).slice(2)}.env`);
      writeFileSync(file, prodEnv);
      env.STUB_PROD_ENV = file;
    }
    return bash('public_origin_preflight\necho AFTER-PREFLIGHT', env);
  }

  it('the portal origin passes quietly', () => {
    const run = preflight('NODE_ENV=production\nPUBLIC_ORIGIN=https://auto.su10.ru\n');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/PUBLIC_ORIGIN: ok \(https:\/\/auto\.su10\.ru\)/);
    expect(run.stderr).toBe('');
  });

  it('quotes are stripped as compose strips them', () => {
    const run = preflight('PUBLIC_ORIGIN="https://auto.su10.ru"\n');
    expect(run.stdout).toMatch(/PUBLIC_ORIGIN: ok/);
    expect(run.stderr).toBe('');
  });

  /** Warn-only: the deploy goes on, but the operator is told what breaks and how to fix it. */
  it('the nip.io value warns with both values, the consequence and the fix', () => {
    const run = preflight('PUBLIC_ORIGIN=https://auto.213-171-26-249.nip.io\n');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/AFTER-PREFLIGHT/);
    expect(run.stderr).toMatch(/не совпадает с адресом портала/);
    expect(run.stderr).toMatch(/PUBLIC_ORIGIN : https:\/\/auto\.213-171-26-249\.nip\.io/);
    expect(run.stderr).toMatch(/адрес портала : https:\/\/auto\.su10\.ru /);
    expect(run.stderr).toMatch(/форму входа/);
    expect(run.stderr).toMatch(/SmartCaptcha/);
    expect(run.stderr).toMatch(/ссылок в письмах/);
    expect(run.stderr).toMatch(/PUBLIC_ORIGIN=https:\/\/auto\.su10\.ru в /);
    expect(run.stderr).toMatch(/up -d --force-recreate technic-api technic-worker/);
    expect(run.stderr).toMatch(/Reload throws the user to the login form/);
  });

  it('a trailing slash warns that the API compares bytes', () => {
    const run = preflight('PUBLIC_ORIGIN=https://auto.su10.ru/\n');
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/не так, как браузер пишет Origin/);
    expect(run.stderr).toMatch(/побайтно/);
  });

  /** The API's schema requires the field (apps/api/src/config.ts): without it the API never starts. */
  it('an absent value warns that technic-api will not start', () => {
    const run = preflight('NODE_ENV=production\n');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/AFTER-PREFLIGHT/);
    expect(run.stderr).toMatch(/PUBLIC_ORIGIN не задан/);
    expect(run.stderr).toMatch(/не стартует вовсе/);
    expect(run.stderr).toMatch(/up -d --force-recreate technic-api technic-worker/);
  });

  it('http instead of https is a mismatch', () => {
    const run = preflight('PUBLIC_ORIGIN=http://auto.su10.ru\n');
    expect(run.stderr).toMatch(/не совпадает с адресом портала/);
  });

  it('an unreadable prod.env is noted and left to the checks that refuse on it', () => {
    const run = preflight(null);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/AFTER-PREFLIGHT/);
    expect(run.stderr).toMatch(/не сверен с адресом портала: .* нечитаем/);
  });
});

describe('public_origin_probe under bash', () => {
  function probe(code: string, head = 'ok'): Run & { calls: string[][] } {
    const log = join(scratch, `curl-${Math.random().toString(36).slice(2)}.log`);
    const run = bash('external_health\necho AFTER-PROBE', {
      STUB_CODE: code,
      STUB_HEAD: head,
      STUB_CURL_LOG: log,
    });
    let text = '';
    try {
      text = readFileSync(log, 'utf8');
    } catch {
      // No call at all leaves no file.
    }
    const calls = text
      .split('--END--\n')
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => chunk.replace(/\n$/, '').split('\n'));
    return { ...run, calls };
  }

  it('exactly one POST to the refresh route, with the portal Origin and no cookie', () => {
    const { calls } = probe('401');
    const posts = calls.filter((args) => args.includes('POST'));
    expect(posts).toHaveLength(1);
    const args = posts[0]!;
    expect(args.at(-1)).toBe(`${PORTAL_ORIGIN}/api/v1/auth/refresh`);
    expect(args).toContain(`Origin: ${PORTAL_ORIGIN}`);
    expect(args.some((arg) => /^(-b|--cookie|Cookie:)/i.test(arg))).toBe(false);
  });

  it('401 is the healthy answer', () => {
    const run = probe('401');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/обновление сессии: ok/);
    expect(run.stderr).toBe('');
  });

  it('403 names PUBLIC_ORIGIN and the fix', () => {
    const run = probe('403');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/AFTER-PROBE/);
    expect(run.stderr).toMatch(/PUBLIC_ORIGIN не совпадает с адресом портала/);
    expect(run.stderr).toMatch(/up -d --force-recreate technic-api technic-worker/);
  });

  it.each(['500', '429', '000'])('%s is reported neutrally with the code', (code) => {
    const run = probe(code);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/AFTER-PROBE/);
    expect(run.stderr).toMatch(new RegExp(`ответило ${code} вместо 401`));
    expect(run.stderr).not.toMatch(/PUBLIC_ORIGIN не совпадает/);
  });

  it('no probe when the portal does not answer at all', () => {
    const run = probe('401', 'down');
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/внешний health недоступен/);
    expect(run.calls.filter((args) => args.includes('POST'))).toHaveLength(0);
  });
});

describe('the probe asks the real route', () => {
  it('the auth routes live under /api/v1/auth and refresh is a POST there', () => {
    expect(readRepoFile('apps/api/src/app.ts')).toContain(
      "app.register(authRoutes, { prefix: '/api/v1/auth' })",
    );
    expect(readRepoFile('apps/api/src/routes/auth.ts')).toMatch(/r\.post\('\/refresh',/);
    expect(shellFunction('public_origin_probe')).toContain('"$origin/api/v1/auth/refresh"');
  });

  /** Only this order makes 401 mean "origin accepted": a cookie check first would answer 401 to both. */
  it('the handler checks the origin before it looks for the cookie', () => {
    const auth = readRepoFile('apps/api/src/routes/auth.ts');
    const handler = auth.slice(auth.indexOf("r.post('/refresh',"));
    const origin = handler.indexOf('assertCookieOrigin(req)');
    const cookie = handler.indexOf('readRefreshCookie(req)');
    expect(origin).toBeGreaterThan(0);
    expect(origin).toBeLessThan(cookie);
  });
});

describe('deploy-auto: where the check stands', () => {
  const at = (needle: string, from = 0): number => {
    const index = script.indexOf(needle, from);
    expect(index, `${DEPLOY_AUTO}: не найдено ${needle}`).toBeGreaterThan(0);
    return index;
  };
  /**
   * A top-level mode block: its last `if` at column 0 (an earlier one with the same condition only
   * labels the action for the report) up to its own `fi` at column 0.
   */
  const block = (header: string): [number, number] => {
    const start = script.lastIndexOf(`\n${header}\n`);
    expect(start, `${DEPLOY_AUTO}: не найден блок ${header}`).toBeGreaterThan(0);
    return [start, at('\nfi\n', start)];
  };

  it('the functions are defined before the first mode that runs them', () => {
    const firstMode = at('\nif [ "$DO_CUTOVER_REVERT" -eq 1 ]; then\n');
    for (const name of FUNCTIONS) expect(at(`\n${name}() {\n`)).toBeLessThan(firstMode);
  });

  it('the plain deploy (and --skip-migrate, --cutover): after the build, before the migrations', () => {
    const build = at('"${COMPOSE[@]}" build "${SERVICES[@]}"');
    const call = at('\npublic_origin_preflight\n', build);
    expect(call).toBeLessThan(at('\n  cutover_run\n', build));
    expect(call).toBeLessThan(
      at('run --rm -T migrate pnpm --silent --filter @technic/api db:migrate:check', build),
    );
  });

  it.each([
    [
      '--previous / --restore-db',
      'if [ "$ROLLBACK_MODE" -eq 1 ]; then',
      'confirm_tty "--restore-db"',
    ],
    ['--cutover-revert', 'if [ "$DO_CUTOVER_REVERT" -eq 1 ]; then', 'db:cutover-down'],
  ])('%s: before the destructive step and the restart', (_mode, header, destructive) => {
    const [start, end] = block(header);
    const call = at('\n  public_origin_preflight\n', start);
    expect(call).toBeLessThan(at(destructive, start));
    expect(call).toBeLessThan(at('up -d --no-build', start));
    expect(call).toBeLessThan(end);
  });

  it('both external health checks go through external_health and so through the probe', () => {
    expect(script.split('curl -fsSI -m 10 "$HEALTH_EXTERNAL"')).toHaveLength(2);
    expect(shellFunction('external_health')).toContain('curl -fsSI -m 10 "$HEALTH_EXTERNAL"');
    expect(shellFunction('cutover_run')).toMatch(/\n {2}external_health\n/);
    // The plain deploy's own check, at column 0 after the point where --cutover branches off.
    expect(script.indexOf('\nexternal_health\n', at('\n  cutover_run\n'))).toBeGreaterThan(0);
  });
});
