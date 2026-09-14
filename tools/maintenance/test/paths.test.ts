/**
 * Пути и защищённые области.
 *
 * Проверяется не библиотека сопоставления, а те решения, ошибка в которых означает молчаливое
 * разрешение править запрещённое: покрывает ли маска каталога сам каталог, побеждает ли точечное
 * правило общее и что происходит при ничьей.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, matchesPattern, normalizePath } from '../core/paths.ts';
import { resolveSurface, strictestMode } from '../policies/surfaces.ts';
import type { ProtectedSurface } from '../core/types.ts';

const ROOT = '/repo';

test('путь приводится к виду от корня независимо от того, как он написан', () => {
  assert.equal(normalizePath(ROOT, '/repo/apps/api/src/x.ts'), 'apps/api/src/x.ts');
  assert.equal(normalizePath(ROOT, './apps/api/src/x.ts'), 'apps/api/src/x.ts');
  assert.equal(normalizePath(ROOT, 'apps/api/../api/src/x.ts'), 'apps/api/src/x.ts');
});

test('маска каталога покрывает и сам каталог, и всё внутри него', () => {
  assert.ok(matchesPattern('apps/api/drizzle', 'apps/api/drizzle/**'));
  assert.ok(matchesPattern('apps/api/drizzle/0001.sql', 'apps/api/drizzle/**'));
  assert.ok(matchesPattern('apps/api/drizzle/meta/x.json', 'apps/api/drizzle/**'));
  assert.ok(!matchesPattern('apps/api/drizzled.ts', 'apps/api/drizzle/**'));
});

test('из нескольких масок выигрывает самая длинная, а не первая по списку', () => {
  const patterns = ['apps/**', 'apps/api/src/db/schema.ts'];
  assert.equal(bestMatch('apps/api/src/db/schema.ts', patterns), 'apps/api/src/db/schema.ts');
  assert.equal(bestMatch('apps/api/src/routes/x.ts', patterns), 'apps/**');
});

const SURFACES: ProtectedSurface[] = [
  { id: 'wide', mode: 'manual-review', paths: ['apps/**'], why: '', see: [] },
  { id: 'exact', mode: 'forbidden', paths: ['apps/api/src/db/schema.ts'], why: '', see: [] },
  {
    id: 'tie-soft',
    mode: 'manual-review',
    paths: ['packages/contracts/src/permissions.ts'],
    why: '',
    see: [],
  },
  {
    id: 'tie-hard',
    mode: 'forbidden',
    paths: ['packages/contracts/src/permissions.ts'],
    why: '',
    see: [],
  },
];

test('точечный запрет побеждает общее разрешение', () => {
  const verdict = resolveSurface(ROOT, SURFACES, 'allowed', 'apps/api/src/db/schema.ts');
  assert.equal(verdict.mode, 'forbidden');
  assert.equal(verdict.surface?.id, 'exact');
});

test('при одинаковых масках побеждает строгая: разногласие толкуется не в пользу правки', () => {
  const verdict = resolveSurface(
    ROOT,
    SURFACES,
    'allowed',
    'packages/contracts/src/permissions.ts',
  );
  assert.equal(verdict.mode, 'forbidden');
});

test('файл вне описанных областей получает умолчание', () => {
  const verdict = resolveSurface(ROOT, SURFACES, 'allowed', 'scripts/check.mjs');
  assert.equal(verdict.mode, 'allowed');
  assert.equal(verdict.surface, null);
});

test('партия оценивается по самому строгому файлу', () => {
  const verdicts = [
    resolveSurface(ROOT, SURFACES, 'allowed', 'scripts/check.mjs'),
    resolveSurface(ROOT, SURFACES, 'allowed', 'apps/api/src/db/schema.ts'),
  ];
  assert.equal(strictestMode(verdicts, 'allowed'), 'forbidden');
});
