/**
 * Изоляция проверки и разбор вины.
 *
 * Проверяется то, ради чего изоляция и делалась: чужая работа в общем дереве не должна ни
 * краснить проверку, ни откатывать верную правку. И обратное: если база красна сама по себе,
 * система обязана сказать это словами, а не списать поломку на партию.
 *
 * Уровни проверки подменяются командами оболочки — настоящие ворота идут минутами и зависят от
 * состояния репозитория, то есть проверяли бы не то.
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

/**
 * Репозиторий, где в HEAD лежит «здоровый» файл, а рабочее дерево содержит и правку партии, и
 * чужую работу рядом. Ровно та обстановка, из-за которой изоляция и понадобилась.
 */
function repoWithNeighbourWork(): string {
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'isolation-'));
  mkdirSync(path.join(dir, 'apps/api/src'), { recursive: true });
  mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/api/src/a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(path.join(dir, 'apps/api/src/neighbour.ts'), 'export const n = 1;\n', 'utf8');
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'начало');

  writeFileSync(path.join(dir, 'apps/api/src/a.ts'), 'export const a = 2;\n', 'utf8');
  // Чужая правка: система её не заказывала, откатить не может и учитывать в проверке не должна.
  writeFileSync(path.join(dir, 'apps/api/src/neighbour.ts'), 'сломано(((\n', 'utf8');
  return dir;
}

function configWith(dir: string, levels: VerificationLevel[]): MaintenanceConfig {
  const fixture = configFixture();
  return {
    ...fixture,
    root: dir,
    verification: levels,
    analysis: {
      ...fixture.analysis,
      lintCommand: ['sh', '-c', 'echo "[]" > {out}'],
      typecheckCommand: ['true'],
      isolateVerification: true,
      linkPaths: [],
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
    // Чужая правка рядом признана человеком: без этого замок остановил бы прогон раньше, и мы
    // проверяли бы не изоляцию, а согласие.
    allowConcurrent: true,
    tmpDir: path.join(dir, 'tmp'),
    extraLevels: [],
  });
}

/** Шаг, который падает, только если видит чужой испорченный файл. */
const SENSITIVE: VerificationLevel = {
  id: 'gates',
  title: 'ворота',
  command: ['sh', '-c', 'grep -q "сломано" apps/api/src/neighbour.ts && exit 1; exit 0'],
  enabledByDefault: true,
};

/** Шаг, который падает всегда: так выглядит база, красная сама по себе. */
const ALWAYS_RED: VerificationLevel = {
  id: 'gates',
  title: 'ворота',
  command: ['false'],
  enabledByDefault: true,
};

/** Шаг, который проверяет, что правка партии действительно наложена на базу. */
const NEEDS_BATCH: VerificationLevel = {
  id: 'gates',
  title: 'ворота',
  command: ['sh', '-c', 'grep -q "a = 2" apps/api/src/a.ts'],
  enabledByDefault: true,
};

test('чужая незавершённая работа не краснит проверку партии', () => {
  const dir = repoWithNeighbourWork();
  try {
    const result = decide(dir, [SENSITIVE]);
    // В изолированном дереве стоит HEAD плюс файлы партии; испорченный сосед туда не попадает.
    assert.equal(result.outcome, 'accept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('правка партии в изолированном дереве видна', () => {
  const dir = repoWithNeighbourWork();
  try {
    assert.equal(decide(dir, [NEEDS_BATCH]).outcome, 'accept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('красная база не списывается на партию: приём, а не откат', () => {
  const dir = repoWithNeighbourWork();
  try {
    const result = decide(dir, [ALWAYS_RED]);
    assert.equal(result.outcome, 'accept');
    assert.match(result.reason, /падает и без этой правки/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
