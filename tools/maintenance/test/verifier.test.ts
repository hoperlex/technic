/**
 * Решение о судьбе партии.
 *
 * Уровни проверки подменяются командами оболочки (`true` и `false`): проверяется не то, зелены ли
 * сегодня ворота проекта, а то, какое решение система принимает при каждом их исходе. Настоящие
 * ворота идут минутами и зависят от чужой работы в общем дереве — тест, который от этого зависит,
 * не проверяет ничего.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { verifyBatch } from '../verification/verifier.ts';
import type { MaintenanceConfig, VerificationLevel } from '../core/config.ts';
import { configFixture, policySetFixture } from './fixtures.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

/** Репозиторий с одним файлом партии, уже изменённым: так выглядит дерево после работы исполнителя. */
function repoWithEdit(): string {
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'verify-'));
  mkdirSync(path.join(dir, 'apps/api/src'), { recursive: true });
  mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/api/src/a.ts'), 'было\n', 'utf8');
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'начало');
  writeFileSync(path.join(dir, 'apps/api/src/a.ts'), 'стало\n', 'utf8');
  return dir;
}

function configWith(dir: string, levels: VerificationLevel[]): MaintenanceConfig {
  return {
    ...configFixture(),
    root: dir,
    verification: levels,
    /*
     * Линт подменяется пустышкой, которая всё же ПИШЕТ машинный отчёт: пустой список файлов —
     * это «проверено, ошибок нет». Команда, которая просто завершается успехом, означает другое —
     * «отчёта нет», и с недавних пор система справедливо считает это поводом для отката.
     */
    analysis: {
      ...configFixture().analysis,
      lintCommand: ['sh', '-c', 'echo "[]" > {out}'],
      typecheckCommand: ['true'],
    },
  };
}

function decide(dir: string, levels: VerificationLevel[]) {
  return verifyBatch({
    config: configWith(dir, levels),
    policies: policySetFixture(),
    baseline: { lintErrors: 0, lintWarnings: 0, typecheckOk: true, dirtyBefore: [] },
    allowed: ['apps/api/src/a.ts'],
    claimed: ['apps/api/src/a.ts'],
    allowConcurrent: false,
    tmpDir: path.join(dir, 'tmp'),
    extraLevels: [],
  });
}

const GREEN: VerificationLevel = {
  id: 'gates',
  title: 'ворота',
  command: ['true'],
  enabledByDefault: true,
};
const RED: VerificationLevel = { ...GREEN, command: ['false'] };
const OPTIONAL_RED: VerificationLevel = {
  id: 'db',
  title: 'db-набор',
  command: ['false'],
  enabledByDefault: false,
};

test('зелёная проверка при целом замке — приём', () => {
  const dir = repoWithEdit();
  try {
    const result = decide(dir, [GREEN]);
    assert.equal(result.outcome, 'accept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('красная проверка — откат, и в отчёте остаётся вывод упавшего шага', () => {
  const dir = repoWithEdit();
  try {
    const result = decide(dir, [RED]);
    assert.equal(result.outcome, 'rollback');
    assert.equal(result.levels[0]?.ok, false);
    assert.equal(typeof result.levels[0]?.output, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('выключенный уровень не выполняется и решения не портит', () => {
  const dir = repoWithEdit();
  try {
    const result = decide(dir, [GREEN, OPTIONAL_RED]);
    assert.equal(result.outcome, 'accept');
    assert.equal(result.levels.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ни одного выполненного уровня — не приём, а вопрос человеку', () => {
  const dir = repoWithEdit();
  try {
    // Партия зелена ровно в том смысле, что её никто не проверял. Принять её на этом основании
    // значит объявить доказанным то, что никто не доказывал.
    const result = decide(dir, [OPTIONAL_RED]);
    assert.equal(result.outcome, 'manual-review');
    assert.match(result.reason, /подтверждать сохранение поведения нечем/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ухудшение базовой линии решается без запуска ворот', () => {
  const dir = repoWithEdit();
  try {
    const result = verifyBatch({
      config: {
        ...configWith(dir, [GREEN]),
        analysis: {
          ...configFixture().analysis,
          lintCommand: ['false'],
          typecheckCommand: ['true'],
        },
      },
      policies: policySetFixture(),
      baseline: { lintErrors: 0, lintWarnings: 0, typecheckOk: true, dirtyBefore: [] },
      allowed: ['apps/api/src/a.ts'],
      claimed: ['apps/api/src/a.ts'],
      allowConcurrent: false,
      tmpDir: path.join(dir, 'tmp'),
      extraLevels: [],
    });
    // Линт не отдал отчёт — значит, посчитать нечем, и это не «ошибок ноль». Ворота при этом не
    // запускались: платить шестью минутами за уже известный ответ незачем.
    assert.equal(result.outcome, 'rollback');
    assert.equal(result.levels.length, 0);
    assert.match(result.reason, /сравнить с базовой линией нечем/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
