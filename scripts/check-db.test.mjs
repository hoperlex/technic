import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-db.mjs', import.meta.url));

function runGate(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'technic-db-gate-test-'));
  const trace = join(dir, 'calls');
  const fakePnpm = join(dir, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.some((arg) => arg.endsWith('/quality-db.ts'))) process.exit(0);
const pkg = args[args.indexOf('--filter') + 1];
const workers = args.find((arg) => arg.startsWith('--maxWorkers='));
appendFileSync(process.env.DB_GATE_TRACE, pkg + ' ' + workers + '\\n');
const firstApi = pkg === '@technic/api' && workers === '--maxWorkers=3';
const failed = firstApi && process.env.DB_GATE_MODE !== 'green';
const unhandled = firstApi && process.env.DB_GATE_MODE === 'unhandled';
const report = {
  testResults: pkg === '@technic/api'
    ? [{ name: '/repo/apps/api/test/probe.db.test.ts', status: failed ? 'failed' : 'passed' }]
    : [],
};
const jsonFile = args.find((arg) => arg.startsWith('--outputFile.json=')).slice(18);
writeFileSync(jsonFile, JSON.stringify(report));
writeFileSync(process.env.TECHNIC_DB_UNHANDLED_REPORT, JSON.stringify(unhandled ? [{ code: '57P01', message: 'connection terminated' }] : []));
process.exit(failed && !unhandled ? 1 : 0);
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(process.execPath, [script, 'probe.db.test.ts'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEST_DATABASE_URL: 'postgres://postgres@localhost:5433/fake',
        DB_GATE_TRACE: trace,
        DB_GATE_MODE: mode,
      },
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(trace, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a mixed file failure and unhandled error cannot become green after retrying only the file', () => {
  const result = runGate('unhandled');
  assert.equal(result.status, 1, result.output);
  assert.doesNotMatch(result.calls, /@technic\/api --maxWorkers=1/);
});

test('a plain parallel file failure still gets its serial retry', () => {
  const result = runGate('failed');
  assert.equal(result.status, 0, result.output);
  assert.match(result.calls, /@technic\/api --maxWorkers=1/);
});

test('a clean first pass remains green', () => {
  const result = runGate('green');
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.calls, /@technic\/api --maxWorkers=1/);
});
