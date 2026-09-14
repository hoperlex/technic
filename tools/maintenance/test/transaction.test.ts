/**
 * Контрольная точка, откат и замок поведения.
 *
 * Главное свойство, которое здесь проверяется: транзакция трогает ТОЛЬКО файлы партии. В общем
 * рабочем дереве рядом лежит чужая незавершённая работа, и откат, унёсший её, — самая дорогая
 * ошибка, которую эта система может совершить.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import { checkBehaviorLock, snapshotBaseline } from '../verification/behavior-lock.ts';
import type { LintFacts, ToolRun } from '../core/facts.ts';
import { configFixture, policySetFixture } from './fixtures.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

function makeRepo(files: Record<string, string>): string {
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'repo-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'начало');
  return dir;
}

function write(dir: string, file: string, body: string): void {
  writeFileSync(path.join(dir, file), body, 'utf8');
}

test('откат возвращает файл партии байт в байт', async () => {
  const dir = makeRepo({ 'a.ts': 'было\n', 'b.ts': 'сосед\n' });
  try {
    const transaction = new FileCheckpointTransaction(
      dir,
      path.join(dir, '.maintenance/checkpoints'),
    );
    const id = await transaction.createCheckpoint(['a.ts']);
    write(dir, 'a.ts', 'стало\n');
    assert.deepEqual(transaction.changedIn(id), ['a.ts']);

    const report = await transaction.rollback(id);
    assert.equal(readFileSync(path.join(dir, 'a.ts'), 'utf8'), 'было\n');
    assert.deepEqual(report.restored, ['a.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('откат не трогает чужую работу рядом', async () => {
  const dir = makeRepo({ 'a.ts': 'было\n', 'чужое.ts': 'чужое\n' });
  try {
    const transaction = new FileCheckpointTransaction(
      dir,
      path.join(dir, '.maintenance/checkpoints'),
    );
    const id = await transaction.createCheckpoint(['a.ts']);
    write(dir, 'a.ts', 'стало\n');
    // Правка соседа сделана НЕ партией: так выглядит параллельная работа человека в общем дереве.
    write(dir, 'чужое.ts', 'чужое, но уже другое\n');

    await transaction.rollback(id);
    assert.equal(readFileSync(path.join(dir, 'a.ts'), 'utf8'), 'было\n');
    assert.equal(readFileSync(path.join(dir, 'чужое.ts'), 'utf8'), 'чужое, но уже другое\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('откат удаляет файл, которого до партии не было', async () => {
  const dir = makeRepo({ 'a.ts': 'было\n' });
  try {
    const transaction = new FileCheckpointTransaction(
      dir,
      path.join(dir, '.maintenance/checkpoints'),
    );
    const id = await transaction.createCheckpoint(['новый.ts']);
    write(dir, 'новый.ts', 'создан правкой\n');
    const report = await transaction.rollback(id);
    assert.equal(existsSync(path.join(dir, 'новый.ts')), false);
    assert.deepEqual(report.removed, ['новый.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('приём снимает точку, оставляя правку в дереве', async () => {
  const dir = makeRepo({ 'a.ts': 'было\n' });
  try {
    const home = path.join(dir, '.maintenance/checkpoints');
    const transaction = new FileCheckpointTransaction(dir, home);
    const id = await transaction.createCheckpoint(['a.ts']);
    write(dir, 'a.ts', 'стало\n');
    await transaction.accept(id);
    assert.equal(readFileSync(path.join(dir, 'a.ts'), 'utf8'), 'стало\n');
    assert.equal(existsSync(path.join(home, id)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LINT_OK: LintFacts = {
  ok: true,
  measured: true,
  durationMs: 1,
  summary: '0 ошибок',
  errors: 0,
  warnings: 5,
  byRule: {},
  messages: [],
};
const TYPES_OK: ToolRun = { ok: true, durationMs: 1, summary: 'типы сходятся' };

function lockOn(
  dir: string,
  allowed: string[],
  dirtyBefore: string[] = [],
  claimed: string[] = [],
) {
  const config = { ...configFixture(), root: dir, scope: { include: ['**'], exclude: [] } };
  return checkBehaviorLock({
    config,
    policies: policySetFixture(),
    baseline: { lintErrors: 0, lintWarnings: 5, typecheckOk: true, dirtyBefore },
    allowed,
    // По умолчанию исполнитель ничего вне партии не называл: так выглядит и честная работа, и
    // чужая правка рядом — их различает отдельная проверка ниже.
    claimed,
    lintAfter: LINT_OK,
    typecheckAfter: TYPES_OK,
  });
}

test('правка в разрешённом файле замок не нарушает', () => {
  const dir = makeRepo({ 'apps/api/src/a.ts': 'было\n' });
  try {
    write(dir, 'apps/api/src/a.ts', 'стало\n');
    assert.deepEqual(lockOn(dir, ['apps/api/src/a.ts']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл вне партии, названный исполнителем, — выход за границы', () => {
  const dir = makeRepo({ 'apps/api/src/a.ts': 'было\n', 'apps/api/src/b.ts': 'было\n' });
  try {
    write(dir, 'apps/api/src/a.ts', 'стало\n');
    write(dir, 'apps/api/src/b.ts', 'тоже стало\n');
    const violations = lockOn(dir, ['apps/api/src/a.ts'], [], ['apps/api/src/b.ts']);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'out-of-scope');
    assert.deepEqual(violations[0]?.files, ['apps/api/src/b.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл вне партии, которого исполнитель не называл, — чужая работа рядом', () => {
  const dir = makeRepo({ 'apps/api/src/a.ts': 'было\n', 'apps/api/src/чужое.ts': 'было\n' });
  try {
    write(dir, 'apps/api/src/a.ts', 'стало\n');
    // Так выглядит параллельная работа человека: файл изменился уже ПОСЛЕ снятия точки, и в
    // отчёте исполнителя его нет. Валить на этом прогон нельзя — в общем дереве это обычное дело.
    write(dir, 'apps/api/src/чужое.ts', 'чужая работа\n');
    const violations = lockOn(dir, ['apps/api/src/a.ts']);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'concurrent-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('чужая правка, сделанная ДО партии, нарушением не считается', () => {
  const dir = makeRepo({ 'apps/api/src/a.ts': 'было\n', 'apps/api/src/чужое.ts': 'было\n' });
  try {
    write(dir, 'apps/api/src/чужое.ts', 'чужая работа\n');
    const before = snapshotBaseline(
      { ...configFixture(), root: dir },
      LINT_OK,
      TYPES_OK,
    ).dirtyBefore;
    write(dir, 'apps/api/src/a.ts', 'стало\n');
    assert.deepEqual(lockOn(dir, ['apps/api/src/a.ts'], [...before]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('правка теста внутри партии — нарушение замка, а не мелочь', () => {
  const dir = makeRepo({ 'apps/api/test/a.test.ts': 'было\n' });
  try {
    write(dir, 'apps/api/test/a.test.ts', 'стало\n');
    const violations = lockOn(dir, ['apps/api/test/a.test.ts']);
    const kinds = violations.map((violation) => violation.kind);
    assert.ok(kinds.includes('evidence-touched'));
    assert.ok(kinds.includes('protected-touched'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('рост числа ошибок линта — нарушение, а рост предупреждений — нет', () => {
  const dir = makeRepo({ 'apps/api/src/a.ts': 'было\n' });
  try {
    write(dir, 'apps/api/src/a.ts', 'стало\n');
    const config = { ...configFixture(), root: dir };
    const worse = checkBehaviorLock({
      config,
      policies: policySetFixture(),
      baseline: { lintErrors: 0, lintWarnings: 5, typecheckOk: true, dirtyBefore: [] },
      allowed: ['apps/api/src/a.ts'],
      claimed: [],
      lintAfter: { ...LINT_OK, errors: 2, warnings: 99 },
      typecheckAfter: TYPES_OK,
    });
    assert.equal(worse.length, 1);
    assert.match(worse[0]?.detail ?? '', /ошибок линта стало больше/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
