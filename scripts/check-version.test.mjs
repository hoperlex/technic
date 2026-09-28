#!/usr/bin/env node
/**
 * Regression tests for `scripts/check-version.mjs`: `node --test scripts/check-version.test.mjs`.
 *
 * WHY FIXTURE REPOSITORIES. The live tree's tags are placed by hand and change with every release,
 * so "green on the tree today" promises nothing about the rule itself. Each test builds a small git
 * repository with its own policy, release migrations and tags, and pins exactly one rule; only the
 * policy file is also read from the live tree, because a quoting slip there (an unquoted hex
 * commit parses as a number) would silently empty an exact set.
 *
 * `node:test` without dependencies, like `docs-navigation.test.mjs`: root scripts have no
 * `package.json` of their own, and a second test stack for them would buy nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkVersion, compareReleases, loadPolicy, parseVersion } from './check-version.mjs';

// Fixture commits must not depend on the machine's git setup: a global signing or hook config
// would make tag creation fail or prompt instead of testing the check.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const POLICY = ({ shared = '[]', outOfOrder = '[]' } = {}) => `
sources:
  file: VERSION
  tag:
    pattern: 'v{version}'
    since: '0.1.2.0010'
    retroactive: false
knownCollisions: []
knownSharedReleaseCommits: ${shared}
knownOutOfOrderReleases: ${outOfOrder}
`;

// `seq` follows the release number unless a test says otherwise, so ordinary fixtures are in order.
const releaseSql = (version, seq = Number(version.split('.')[2])) =>
  `INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (\n` +
  `  ${seq}, '${version}', '2026-09-25', 'fixture', '{}', '[]'::jsonb\n);\n` +
  `-- rollback: DELETE FROM app_releases WHERE version = '${version}';\n`;

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function fixture(policy = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-version-'));
  cleanups.push(root);
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV }).trim();
  const write = (rel, text) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  git('init', '-q', '-b', 'main');
  write('architecture/policies/versioning.yaml', POLICY(policy));
  for (const n of ['0010', '0011', '0012']) write(`docs/adr/${n}-fixture.md`, `# ADR ${n}. X\n`);
  write('apps/api/drizzle/0000_schema.sql', 'CREATE TABLE app_releases (version text);\n');

  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  /** One commit that brings the release migration(s) and moves VERSION to the eldest of them. */
  const release = (...versions) => {
    versions.forEach((v, i) =>
      write(`apps/api/drizzle/01${v.split('.')[2]}${i}_releases.sql`, releaseSql(v)),
    );
    write('VERSION', `${versions.at(-1)}\n`);
    return commit(`release ${versions.join(', ')}`);
  };
  const tag = (version, sha, { annotated = true } = {}) =>
    annotated
      ? git('tag', '-a', `v${version}`, sha, '-m', `release ${version}`)
      : git('tag', `v${version}`, sha);
  return { root, git, write, commit, release, tag };
}

const run = (root, options = {}) => checkVersion({ root, ...options });
const has = (list, pattern) => list.some((line) => pattern.test(line));

test('версии сравниваются числами, а не строкой', () => {
  assert.ok(compareReleases(parseVersion('0.1.10.0001'), parseVersion('0.1.9.0002')) > 0);
  assert.ok(compareReleases(parseVersion('0.2.1.0001'), parseVersion('0.1.99.0002')) > 0);
  assert.equal(parseVersion('0.1.9'), null);
  assert.equal(parseVersion('0.1.09.0001'), null);
});

test('без флагов: предупреждение на КАЖДЫЙ выпуск без тега от порога, а не только на текущий', () => {
  const f = fixture();
  f.release('0.1.1.0010'); // below the threshold: never tagged, never warned
  const second = f.release('0.1.2.0010');
  f.release('0.1.3.0011');
  f.release('0.1.4.0012');
  f.tag('0.1.3.0011', f.git('rev-parse', 'HEAD~1'));

  const r = run(f.root);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, /0\.1\.2\.0010 не помечен тегом.*место — /), r.warnings.join('\n'));
  assert.ok(has(r.warnings, new RegExp(`место — ${second.slice(0, 8)}`)));
  assert.ok(has(r.warnings, /0\.1\.4\.0012 не помечен тегом/));
  assert.ok(!has(r.warnings, /0\.1\.3\.0011 не помечен/));
  assert.ok(!has(r.warnings, /0\.1\.1\.0010/));
});

test('незакоммиченная миграция выпуска — предупреждение с подсказкой, а не ошибка', () => {
  const f = fixture();
  f.release('0.1.2.0010');
  f.write('apps/api/drizzle/0200_releases.sql', releaseSql('0.1.3.0011'));
  f.write('VERSION', '0.1.3.0011\n');
  const r = run(f.root);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, /0\.1\.3\.0011 не помечен.*ещё не закоммичена/));
});

test('--tags: аннотированный тег на коммите миграции проходит без ошибок', () => {
  const f = fixture();
  const sha = f.release('0.1.2.0010');
  // A later commit on top: the audit must follow the migration, not HEAD.
  f.write('README', 'later\n');
  f.commit('unrelated');
  f.tag('0.1.2.0010', sha);
  const r = run(f.root, { tags: true });
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.summary, /на коммитах миграций: 1/));
});

test('--tags: тег не на коммите миграции — ошибка с обоими коммитами', () => {
  const f = fixture();
  const sha = f.release('0.1.2.0010');
  f.write('README', 'later\n');
  const later = f.commit('later');
  f.tag('0.1.2.0010', later);
  const r = run(f.root, { tags: true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], new RegExp(`${later.slice(0, 8)}.*${sha.slice(0, 8)}`));
});

test('--tags: лёгкий тег — ошибка, даже на правильном коммите', () => {
  const f = fixture();
  const sha = f.release('0.1.2.0010');
  f.tag('0.1.2.0010', sha, { annotated: false });
  const r = run(f.root, { tags: true });
  assert.ok(has(r.errors, /лёгкий/));
  assert.ok(has(r.summary, /на коммитах миграций: 0/));
});

test('--tags: тег без записи выпуска в миграциях — ошибка', () => {
  const f = fixture();
  const sha = f.release('0.1.2.0010');
  f.tag('0.1.7.0012', sha);
  const r = run(f.root, { tags: true });
  assert.ok(has(r.errors, /v0\.1\.7\.0012.*записи выпуска 0\.1\.7\.0012 в миграциях нет/));
});

test('--tags: тег впереди дерева (коммит вне истории HEAD) не считается ошибкой', () => {
  const f = fixture();
  f.release('0.1.2.0010');
  f.git('checkout', '-q', '-b', 'ahead');
  const ahead = f.release('0.1.3.0011');
  f.tag('0.1.3.0011', ahead);
  f.git('checkout', '-q', 'main');
  const r = run(f.root, { tags: true });
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.notes, /v0\.1\.3\.0011 стоит вне истории HEAD/));
});

test('два выпуска одним коммитом: новый случай — предупреждение, известный — примечание', () => {
  const unknown = fixture();
  const sha = unknown.release('0.1.2.0010', '0.1.3.0011');
  unknown.tag('0.1.2.0010', sha);
  unknown.tag('0.1.3.0011', sha);
  const a = run(unknown.root, { tags: true });
  assert.deepEqual(a.errors, []);
  assert.ok(has(a.warnings, /0\.1\.2\.0010, 0\.1\.3\.0011 приехали одним коммитом/));

  const known = fixture({ shared: "[{ versions: ['0.1.2.0010', '0.1.3.0011'] }]" });
  const sha2 = known.release('0.1.2.0010', '0.1.3.0011');
  known.tag('0.1.2.0010', sha2);
  known.tag('0.1.3.0011', sha2);
  const b = run(known.root, { tags: true });
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.warnings, []);
  assert.ok(has(b.notes, /известный случай/));
});

test('известный случай с чужим коммитом или разошедшийся по коммитам — запись устарела', () => {
  const f = fixture({ shared: "[{ commit: 'deadbeef', versions: ['0.1.2.0010', '0.1.3.0011'] }]" });
  f.release('0.1.2.0010', '0.1.3.0011');
  assert.ok(has(run(f.root).warnings, /записан коммит deadbeef.*устарела/));

  const g = fixture({ shared: "[{ versions: ['0.1.2.0010', '0.1.3.0011'] }]" });
  g.release('0.1.2.0010');
  g.release('0.1.3.0011');
  assert.ok(has(run(g.root).warnings, /разными коммитами — запись политики устарела/));
});

test('--tags: VERSION в помеченном коммите не старший выпуск — предупреждение', () => {
  const f = fixture();
  f.write('apps/api/drizzle/0100_releases.sql', releaseSql('0.1.2.0010'));
  f.write('VERSION', '0.1.1.0010\n');
  const sha = f.commit('release without VERSION bump');
  f.write('VERSION', '0.1.2.0010\n');
  f.commit('VERSION bump');
  f.tag('0.1.2.0010', sha);
  const r = run(f.root, { tags: true });
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, /VERSION = 0\.1\.1\.0010, а старший выпуск.*0\.1\.2\.0010/));
});

test('порядок прихода: выпуск, пришедший позже с меньшими seq и номером, — ошибка с обоими коммитами', () => {
  // The shape of 0344/0345: the branch that lands second took the pair "next free" at its start.
  const f = fixture();
  f.write('apps/api/drizzle/0200_releases.sql', releaseSql('0.1.3.0011', 3));
  f.write('VERSION', '0.1.3.0011\n');
  const higher = f.commit('release 0.1.3');
  f.write('apps/api/drizzle/0199_releases.sql', releaseSql('0.1.2.0010', 2));
  const lower = f.commit('late release 0.1.2');
  const r = run(f.root);
  assert.equal(r.errors.length, 1, r.errors.join('\n'));
  assert.match(
    r.errors[0],
    new RegExp(`0\\.1\\.2\\.0010.*${lower.slice(0, 8)}.*${higher.slice(0, 8)}`),
  );
  assert.match(r.errors[0], /номер 0\.1\.2\.0010 не старше 0\.1\.3\.0011 и seq 2 не больше 3/);
});

test('порядок прихода: ловится и один seq, если номер вырос', () => {
  const f = fixture();
  f.write('apps/api/drizzle/0200_releases.sql', releaseSql('0.1.2.0010', 5));
  f.commit('release 0.1.2 with seq 5');
  f.write('apps/api/drizzle/0201_releases.sql', releaseSql('0.1.3.0011', 4));
  f.write('VERSION', '0.1.3.0011\n');
  f.commit('release 0.1.3 with seq 4');
  const r = run(f.root);
  assert.equal(r.errors.length, 1, r.errors.join('\n'));
  assert.match(r.errors[0], /seq 4 не больше 5/);
  assert.doesNotMatch(r.errors[0], /номер 0\.1\.3\.0011 не старше/);
});

test('порядок прихода: ветка, влитая позже, приходит merge-коммитом первородительской линии', () => {
  const late = fixture();
  late.release('0.1.2.0010');
  late.git('checkout', '-q', '-b', 'side');
  late.write('apps/api/drizzle/0300_releases.sql', releaseSql('0.1.3.0011'));
  late.commit('side takes 0.1.3');
  late.git('checkout', '-q', 'main');
  late.write('apps/api/drizzle/0301_releases.sql', releaseSql('0.1.4.0012'));
  late.write('VERSION', '0.1.4.0012\n');
  const mainline = late.commit('main takes 0.1.4 first');
  late.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const merge = late.git('rev-parse', 'HEAD');
  const r = run(late.root);
  assert.equal(r.errors.length, 1, r.errors.join('\n'));
  assert.match(
    r.errors[0],
    new RegExp(`0\\.1\\.3\\.0011.*${merge.slice(0, 8)}.*${mainline.slice(0, 8)}`),
  );

  // Landing in number order is fine even when the branch was written in parallel.
  const early = fixture();
  early.release('0.1.2.0010');
  early.git('checkout', '-q', '-b', 'side');
  early.write('apps/api/drizzle/0300_releases.sql', releaseSql('0.1.3.0011'));
  early.commit('side takes 0.1.3');
  early.git('checkout', '-q', 'main');
  early.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  early.write('apps/api/drizzle/0301_releases.sql', releaseSql('0.1.4.0012'));
  early.write('VERSION', '0.1.4.0012\n');
  early.commit('main takes 0.1.4 after the merge');
  assert.deepEqual(run(early.root).errors, []);
});

test('порядок прихода: известная пара — не ошибка, а примечание; пара по порядку — запись устарела', () => {
  const outOfOrder = "[{ versions: ['0.1.2.0010', '0.1.3.0011'] }]";
  const f = fixture({ outOfOrder });
  f.write('apps/api/drizzle/0200_releases.sql', releaseSql('0.1.3.0011'));
  f.write('VERSION', '0.1.3.0011\n');
  f.commit('release 0.1.3');
  f.write('apps/api/drizzle/0199_releases.sql', releaseSql('0.1.2.0010'));
  f.commit('late release 0.1.2');
  const r = run(f.root, { tags: true });
  assert.deepEqual(r.errors, []);
  assert.ok(
    has(r.notes, /0\.1\.2\.0010 пришёл в историю позже 0\.1\.3\.0011.*известное исключение/),
  );

  const g = fixture({ outOfOrder });
  g.release('0.1.2.0010');
  g.release('0.1.3.0011');
  assert.ok(
    has(run(g.root).warnings, /knownOutOfOrderReleases.*по порядку — запись политики устарела/),
  );
});

test('миграция, внесённая самим merge-коммитом, закоммичена им, и тег на нём проходит сверку', () => {
  // Conflict resolution or an evil merge: the file is in neither parent, only in the merge.
  const f = fixture();
  f.release('0.1.2.0010');
  f.git('checkout', '-q', '-b', 'side');
  f.write('side.txt', 'side\n');
  f.commit('side work');
  f.git('checkout', '-q', 'main');
  f.write('main.txt', 'main\n');
  f.commit('main work');
  f.git('merge', '-q', '--no-ff', '--no-commit', 'side');
  f.write('apps/api/drizzle/0300_releases.sql', releaseSql('0.1.3.0011'));
  f.write('VERSION', '0.1.3.0011\n');
  const merge = f.commit('merge side, release 0.1.3 written in the merge');
  assert.equal(f.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);

  const plain = run(f.root);
  assert.deepEqual(plain.errors, []);
  assert.ok(!has(plain.warnings, /ещё не закоммичена/), plain.warnings.join('\n'));
  assert.ok(has(plain.warnings, new RegExp(`0\\.1\\.3\\.0011.*место — ${merge.slice(0, 8)}`)));

  f.tag('0.1.3.0011', merge);
  assert.deepEqual(run(f.root, { tags: true }).errors, []);
});

test('миграция с боковой ветки: тег — на её коммите, а не на merge', () => {
  const f = fixture();
  f.release('0.1.2.0010');
  f.git('checkout', '-q', '-b', 'side');
  f.write('apps/api/drizzle/0300_releases.sql', releaseSql('0.1.3.0011'));
  f.write('VERSION', '0.1.3.0011\n');
  const side = f.commit('side release 0.1.3');
  f.git('checkout', '-q', 'main');
  f.write('main.txt', 'main\n');
  f.commit('main work');
  f.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  f.tag('0.1.3.0011', side);
  assert.deepEqual(run(f.root, { tags: true }).errors, []);
});

test('порядок прихода: выпуски до порога не сверяются', () => {
  const f = fixture();
  f.write('apps/api/drizzle/0200_releases.sql', releaseSql('0.1.2.0010'));
  f.write('VERSION', '0.1.2.0010\n');
  f.commit('release 0.1.2');
  f.write('apps/api/drizzle/0100_releases.sql', releaseSql('0.1.1.0010'));
  f.commit('journal backfill below the threshold');
  assert.deepEqual(run(f.root).errors, []);
});

test('--remote: незапушенный тег — предупреждение, расхождение с origin — ошибка', () => {
  const origin = mkdtempSync(path.join(tmpdir(), 'check-version-origin-'));
  cleanups.push(origin);
  execFileSync('git', ['init', '-q', '--bare', origin], { env: GIT_ENV });

  const f = fixture();
  const first = f.release('0.1.2.0010');
  const second = f.release('0.1.3.0011');
  f.git('remote', 'add', 'origin', origin);
  f.git('push', '-q', 'origin', 'main');
  f.tag('0.1.2.0010', first);
  f.tag('0.1.3.0011', second);
  f.git('push', '-q', 'origin', 'v0.1.2.0010');

  const pushedOne = run(f.root, { tags: true, remote: true });
  assert.deepEqual(pushedOne.errors, []);
  assert.ok(has(pushedOne.warnings, /v0\.1\.3\.0011 не запушен в origin/));
  assert.ok(!has(pushedOne.warnings, /v0\.1\.2\.0010 не запушен/));

  // Moving a published tag locally is exactly the divergence the remote audit exists for.
  f.git('tag', '-d', 'v0.1.2.0010');
  f.tag('0.1.2.0010', second);
  const moved = run(f.root, { remote: true });
  assert.ok(has(moved.errors, /v0\.1\.2\.0010 в origin указывает на/));
});

test('--remote: недоступный origin — ошибка, а не тихий зелёный ответ', () => {
  const f = fixture();
  f.release('0.1.2.0010');
  f.git('remote', 'add', 'origin', path.join(tmpdir(), 'check-version-no-such-remote'));
  const r = run(f.root, { remote: true });
  assert.ok(has(r.errors, /сверка с origin не выполнена/));
});

test('вне репозитория: без флагов — предупреждение, запрошенная сверка — ошибка', () => {
  const f = fixture();
  f.release('0.1.2.0010');
  rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
  const plain = run(f.root);
  assert.deepEqual(plain.errors, []);
  assert.ok(has(plain.warnings, /git не ответил/));
  assert.ok(has(run(f.root, { tags: true }).errors, /git не ответил/));
});

test('политика дерева читается: порог и точные множества на месте', () => {
  const policy = loadPolicy(path.resolve(import.meta.dirname, '..'));
  assert.equal(policy.since.raw, '0.1.83.0191');
  assert.deepEqual(
    policy.knownCollisions.map((k) => k.versions),
    [
      ['0.1.64.0154', '0.1.64.0155'],
      ['0.1.66.0156', '0.1.66.0158'],
    ],
  );
  assert.deepEqual(
    policy.knownSharedCommits.map((k) => [k.commit, k.versions]),
    [
      ['f7246a0f', ['0.1.87.0197', '0.1.89.0199']],
      ['6b3c3330', ['0.1.92.0202', '0.1.93.0203']],
    ],
  );
});
