/**
 * Анализаторы на маленьком дереве-заготовке.
 *
 * Заготовка собирается в рабочем каталоге прогона (`.maintenance/tmp`), а не в системном временном:
 * каталог всё равно вне истории, зато видно, что именно проверялось, если тест упал.
 *
 * Проверяется то, ради чего анализаторы написаны: направление между пакетами, которого не видит
 * линт; цикл; и разбор карты кода — единственного места, где в этом проекте описаны домены.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { collectDependencies } from '../analyzers/dependencies.ts';
import { collectMetrics } from '../analyzers/metrics.ts';
import { codeMapDomains } from '../project/code-map.ts';
import type { ModulePackage } from '../core/types.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

function makeTree(files: Record<string, string>): string {
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'fixture-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

const PACKAGES: ModulePackage[] = [
  { id: 'contracts', path: 'packages/contracts', role: 'shared', mayDependOn: [] },
  { id: 'api', path: 'apps/api', role: 'backend', mayDependOn: ['contracts'] },
  { id: 'web', path: 'apps/web', role: 'frontend', mayDependOn: ['contracts'] },
];

test('разрешённое направление нарушением не считается', () => {
  const dir = makeTree({
    'apps/api/src/a.ts':
      "import { x } from '../../../packages/contracts/src/index.ts';\nexport const a = x;\n",
    'packages/contracts/src/index.ts': 'export const x = 1;\n',
  });
  try {
    const { facts } = collectDependencies({
      root: dir,
      files: ['apps/api/src/a.ts', 'packages/contracts/src/index.ts'],
      packages: PACKAGES,
      aliases: [],
      maxCycles: 10,
    });
    assert.equal(facts.violations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('импорт словаря из приложения — нарушение направления, которого не ловит линт', () => {
  const dir = makeTree({
    'packages/contracts/src/index.ts':
      "import { helper } from '../../../apps/api/src/a.ts';\nexport const x = helper;\n",
    'apps/api/src/a.ts': 'export const helper = 1;\n',
  });
  try {
    const { facts } = collectDependencies({
      root: dir,
      files: ['packages/contracts/src/index.ts', 'apps/api/src/a.ts'],
      packages: PACKAGES,
      aliases: [],
      maxCycles: 10,
    });
    const direction = facts.violations.filter((violation) => violation.kind === 'direction');
    assert.equal(direction.length, 1);
    assert.equal(direction[0]?.from, 'contracts');
    assert.equal(direction[0]?.to, 'api');
    assert.equal(direction[0]?.severity, 'hard');
    assert.equal(facts.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('взаимный импорт через публичный вход виден как цикл', () => {
  const dir = makeTree({
    'apps/web/src/entities/thing/index.ts': "export { grid } from './ui/grid.ts';\n",
    'apps/web/src/entities/thing/ui/grid.ts':
      "import { helper } from '../index.ts';\nexport const grid = helper;\n",
  });
  try {
    const { facts } = collectDependencies({
      root: dir,
      files: ['apps/web/src/entities/thing/index.ts', 'apps/web/src/entities/thing/ui/grid.ts'],
      packages: PACKAGES,
      aliases: [],
      maxCycles: 10,
    });
    const cycles = facts.violations.filter((violation) => violation.kind === 'cycle');
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0]?.files.length, 2);
    assert.equal(cycles[0]?.severity, 'soft');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('алиас действует только в своей области', () => {
  const dir = makeTree({
    'apps/web/src/shared/ui/button.ts': 'export const button = 1;\n',
    'apps/web/src/pages/page.ts':
      "import { button } from '@shared/ui/button';\nexport const page = button;\n",
    'apps/api/src/route.ts':
      "import { button } from '@shared/ui/button';\nexport const route = button;\n",
  });
  try {
    const { facts } = collectDependencies({
      root: dir,
      files: [
        'apps/web/src/pages/page.ts',
        'apps/api/src/route.ts',
        'apps/web/src/shared/ui/button.ts',
      ],
      packages: PACKAGES,
      aliases: [{ prefix: '@shared/', target: 'apps/web/src/shared/', within: 'apps/web/' }],
      maxCycles: 10,
    });
    // Портальный импорт разрешился и дал связь; такой же импорт в сервере остался неразрешённым и
    // ложной связи не создал — иначе анализ показал бы зависимость api от web, которой нет.
    assert.equal(facts.edges, 1);
    assert.equal(facts.violations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('комментарии считаются отдельно от кода', () => {
  const dir = makeTree({
    'apps/api/src/a.ts': [
      '/*',
      ' * пояснение',
      ' */',
      '// ещё одно',
      'export const a = 1;',
      '',
      'export const b = 2;',
    ].join('\n'),
  });
  try {
    const metrics = collectMetrics(dir, ['apps/api/src/a.ts'], 5);
    assert.equal(metrics.largest[0]?.commentLines, 4);
    assert.equal(metrics.largest[0]?.codeLines, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('домены читаются из карты кода, а не из отдельного списка', async () => {
  const dir = makeTree({
    'docs/code-map.md': [
      '# Карта',
      '',
      '## Вывоз мусора',
      '',
      '- Домен: `вывоз-мусора`',
      '- Источник истины: [waste.ts](../packages/contracts/src/waste.ts)',
      '- API-маршруты: [waste.ts](../apps/api/src/routes/waste.ts)',
      '- Тесты: `waste-*.db.test.ts`',
      '- Решения: [ADR 0009](adr/0009-waste.md)',
      '',
      '## Заказ ТС',
      '',
      '- Домен: `заказ-тс`',
      '- Web: [vehicle](../apps/web/src/pages/vehicle)',
      '',
    ].join('\n'),
  });
  try {
    const domains = await codeMapDomains({ file: 'docs/code-map.md' }).load(dir);
    assert.equal(domains.length, 2);
    assert.equal(domains[0]?.id, 'вывоз-мусора');
    assert.deepEqual(domains[0]?.paths, [
      'packages/contracts/src/waste.ts',
      'apps/api/src/routes/waste.ts',
    ]);
    assert.deepEqual(domains[0]?.adr, ['docs/adr/0009-waste.md']);
    // Маска тестов путём не является: `waste-*.db.test.ts` нельзя ни открыть, ни сопоставить с
    // файлом области — и в состав домена она не попадает.
    assert.equal(domains[1]?.paths.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
