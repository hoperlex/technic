import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SHELL_SECTIONS } from '@technic/contracts';

const SCRIPT = path.resolve('scripts/bundle-size.mjs');
const SOURCE = 'src/pages/waste/WasteRequestsPage.tsx';
interface Chunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
interface Size {
  raw: number;
  gzip: number;
  chunks: string[];
  files: { file: string; raw: number; gzip: number }[];
}
interface Report {
  entry: Size;
  routes: Record<string, Size & { embedded: boolean }>;
  selected?: Size;
}
interface Fixture {
  manifest: Record<string, Chunk>;
  files: Record<string, string>;
  budget: {
    requireDynamicRoutes: boolean;
    entryGzip: number;
    routes: Record<string, { source: string; gzip: number }>;
  };
}

function runFixture(change: (fixture: Fixture) => void = () => undefined, args: string[] = []) {
  const fixture: Fixture = {
    manifest: {
      'index.html': {
        file: 'entry.js',
        isEntry: true,
        imports: ['shared'],
        dynamicImports: [SOURCE],
      },
      shared: { file: 'shared.js', imports: ['index.html'] },
      [SOURCE]: { file: 'waste.js', src: SOURCE, isDynamicEntry: true, imports: ['shared'] },
    },
    files: { 'entry.js': 'entry code', 'shared.js': 'shared code', 'waste.js': 'waste code' },
    budget: {
      requireDynamicRoutes: true,
      entryGzip: 10000,
      routes: { waste: { source: SOURCE, gzip: 10000 } },
    },
  };
  change(fixture);
  const root = mkdtempSync(path.join(tmpdir(), 'technic-bundle-fixture-'));
  try {
    mkdirSync(path.join(root, '.vite'));
    writeFileSync(path.join(root, '.vite/manifest.json'), JSON.stringify(fixture.manifest));
    writeFileSync(path.join(root, 'budget.json'), JSON.stringify(fixture.budget));
    for (const [file, content] of Object.entries(fixture.files))
      writeFileSync(path.join(root, file), content);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--dist', root, '--budget', path.join(root, 'budget.json'), '--json', ...args],
      { encoding: 'utf8' },
    );
    return {
      ...result,
      report: result.status === 0 ? (JSON.parse(result.stdout) as Report) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('машинный бюджет бандла', () => {
  it('обходит циклические синхронные импорты, не включает отложенный маршрут в entry', () => {
    const result = runFixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.report!.entry.chunks).toEqual(['index.html', 'shared']);
    expect(result.report!.entry.raw).toBe('entry code'.length + 'shared code'.length);
    expect(result.report!.entry.gzip).toBe(
      gzipSync('entry code').length + gzipSync('shared code').length,
    );
    expect(result.report!.routes.waste!.embedded).toBe(false);
    expect(result.report!.routes.waste!.files).toHaveLength(3);
  });

  it('дедуплицирует общий файл по имени, даже если manifest содержит два ключа', () => {
    const result = runFixture((fixture) => {
      fixture.manifest.alias = { file: 'shared.js' };
      fixture.manifest['index.html']!.imports!.push('alias');
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.report!.entry.files).toHaveLength(2);
    expect(result.report!.routes.waste!.files).toHaveLength(3);
  });

  it('подсказка маршрута нечувствительна к регистру', () => {
    const result = runFixture(undefined, ['--route', 'WaStE']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.report!.selected!.gzip).toBe(result.report!.routes.waste!.gzip);
  });

  it('промах подсказки не подменяет маршрут меньшей цифрой entry', () => {
    const result = runFixture(undefined, ['--route', 'typo']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('не совпал с manifest');
  });

  it('отсутствующий корень разрешён только явно обозначенному baseline до разреза', () => {
    const result = runFixture((fixture) => {
      delete fixture.manifest[SOURCE];
      fixture.budget.requireDynamicRoutes = false;
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.report!.routes.waste!.embedded).toBe(true);
    expect(result.report!.routes.waste!.gzip).toBe(result.report!.entry.gzip);
  });

  it.each(['absent', 'static'])('строгая политика не принимает %s route root', (kind) => {
    const result = runFixture((fixture) => {
      if (kind === 'absent') delete fixture.manifest[SOURCE];
      else fixture.manifest['index.html']!.imports!.push(SOURCE);
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('не имеет отдельного динамического корня');
  });

  it.each(['entry', 'import', 'file'])('не занижает замер при отсутствующем %s', (kind) => {
    const result = runFixture((fixture) => {
      if (kind === 'entry') fixture.manifest['index.html']!.isEntry = false;
      if (kind === 'import') fixture.manifest.shared!.imports!.push('missing');
      if (kind === 'file') delete fixture.files['shared.js'];
    });
    expect(result.status).toBe(1);
  });

  it('gate не принимает сторонний dist вместо свежей production-сборки', () => {
    const result = runFixture(undefined, ['--check']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('только со свежим production dist');
  });

  it('один лишний байт превышает лимит entry и маршрута', () => {
    // Import the same implementation in Node rather than copying its budget comparison here.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import { budgetViolations } from ' +
          JSON.stringify(pathToFileURL(SCRIPT).href) +
          ';' +
          'process.stdout.write(JSON.stringify(budgetViolations(' +
          '{entry:{gzip:101},routes:{waste:{gzip:201}}},' +
          '{entryGzip:100,routes:{waste:{gzip:200}}})));',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      'entry: 101 > 100 байт gzip',
      'entry + waste: 201 > 200 байт gzip',
    ]);
  });

  it('лимиты покрывают ровно SHELL_SECTIONS, а source ссылается на настоящий файл', () => {
    const budget = JSON.parse(readFileSync('bundle-budget.json', 'utf8')) as Fixture['budget'];
    expect(Object.keys(budget.routes).sort()).toEqual(
      SHELL_SECTIONS.map((section) => section.id).sort(),
    );
    expect(budget.entryGzip).toBeGreaterThan(0);
    for (const limit of Object.values(budget.routes)) {
      expect(limit.gzip).toBeGreaterThan(0);
      expect(existsSync(limit.source), limit.source).toBe(true);
    }
  });
});
