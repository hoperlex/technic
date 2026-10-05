#!/usr/bin/env node
/**
 * The only bundle-size algorithm: gzip of entry/route synchronous manifest closures.
 *
 * A smaller main file is not necessarily a smaller first screen: shared chunks still have to be
 * downloaded. Follow imports, not filenames, and exclude dynamicImports until their screen opens.
 * Baseline reports and the gate use exactly this calculation so their results stay comparable.
 *
 * node scripts/bundle-size.mjs --build --json
 * node scripts/bundle-size.mjs --check          (always builds first)
 * node scripts/bundle-size.mjs --route waste    (also accepts a positional, case-insensitive hint)
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (value) => process.stdout.write(value + '\n');

/** Missing imports must fail closed: silently skipping one makes a broken build look smaller. */
export function closure(manifest, startKeys) {
  const seen = new Set();
  const queue = [...startKeys];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) throw new Error('Нет чанка в manifest: ' + key);
    seen.add(key);
    queue.push(...(chunk.imports ?? []));
  }
  return [...seen].sort();
}

function measure(manifest, dist, roots) {
  const chunks = closure(manifest, roots);
  // A manifest can alias a file under multiple keys; the browser downloads it only once.
  const names = [...new Set(chunks.map((key) => manifest[key].file))].sort();
  const files = names
    .map((file) => {
      if (typeof file !== 'string') throw new Error('Чанк без имени файла');
      const full = path.resolve(dist, file);
      if (!full.startsWith(path.resolve(dist) + path.sep))
        throw new Error('Файл вне dist: ' + file);
      const content = readFileSync(full);
      return { file, raw: content.length, gzip: gzipSync(content).length };
    })
    .filter(({ file }) => /\.m?js$/.test(file));
  return {
    roots: [...new Set(roots)].sort(),
    chunks,
    raw: files.reduce((sum, file) => sum + file.raw, 0),
    gzip: files.reduce((sum, file) => sum + file.gzip, 0),
    files,
  };
}

export function bundleReport(manifest, dist, budget, routeHint) {
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (entries.length === 0) throw new Error('В manifest нет точки входа');
  if (typeof budget.requireDynamicRoutes !== 'boolean')
    throw new Error('Нет политики корней маршрутов');
  const entry = measure(manifest, dist, entries);
  const routes = {};
  for (const [id, limit] of Object.entries(budget.routes).sort(([a], [b]) => a.localeCompare(b))) {
    const roots = Object.keys(manifest).filter(
      (key) => (manifest[key].src ?? key) === limit.source,
    );
    const embedded = roots.length === 0 || roots.every((key) => entry.chunks.includes(key));
    if (
      budget.requireDynamicRoutes &&
      (embedded || roots.some((key) => !manifest[key].isDynamicEntry))
    ) {
      throw new Error(
        'Маршрут ' + id + ' не имеет отдельного динамического корня: ' + limit.source,
      );
    }
    // Before route splitting, explicitly label the baseline as embedded instead of pretending
    // an absent route is a separate, zero-cost chunk. Later the budget forbids this state.
    routes[id] = {
      source: limit.source,
      embedded,
      ...measure(manifest, dist, [...entries, ...roots]),
    };
  }
  if (budget.requireDynamicRoutes) {
    // Separate dynamic roots are not enough: a route can still import another section eagerly.
    // Use the same measured closure, so the ownership guard cannot disagree with the byte budget.
    for (const [id, route] of Object.entries(routes)) {
      for (const [otherId, other] of Object.entries(routes)) {
        if (id === otherId) continue;
        const sectionRoots = other.roots.filter((root) => !entries.includes(root));
        if (sectionRoots.some((root) => route.chunks.includes(root))) {
          throw new Error('Маршрут ' + id + ' статически загружает раздел ' + otherId);
        }
      }
    }
  }
  const dynamic = {};
  for (const key of Object.keys(manifest)
    .filter((key) => manifest[key].isDynamicEntry)
    .sort()) {
    dynamic[key] = measure(manifest, dist, [...entries, key]);
  }
  const report = { entry, routes, dynamic };
  if (routeHint) {
    const needle = routeHint.toLowerCase();
    const configured = Object.entries(budget.routes).find(
      ([id]) => id.toLowerCase() === needle,
    )?.[1];
    const roots = Object.keys(manifest).filter((key) =>
      configured
        ? (manifest[key].src ?? key) === configured.source
        : (manifest[key].src ?? key).toLowerCase().includes(needle),
    );
    // A typo or a route without a chunk must fail, never return a deceptively small entry total.
    if (roots.length === 0) {
      throw new Error(
        'Маршрут «' + routeHint + '» не совпал с manifest: опечатка или ещё нет своего чанка',
      );
    }
    report.selected = { hint: routeHint, ...measure(manifest, dist, [...entries, ...roots]) };
  }
  return report;
}

export function budgetViolations(report, budget) {
  const errors = [];
  const check = (name, actual, maximum) => {
    if (!Number.isSafeInteger(maximum) || maximum <= 0)
      throw new Error('Некорректный бюджет: ' + name);
    if (actual > maximum) errors.push(name + ': ' + actual + ' > ' + maximum + ' байт gzip');
  };
  check('entry', report.entry.gzip, budget.entryGzip);
  for (const [id, limit] of Object.entries(budget.routes)) {
    check('entry + ' + id, report.routes[id].gzip, limit.gzip);
  }
  return errors;
}

function parseArgs(argv) {
  const options = {
    build: false,
    check: false,
    json: false,
    dist: path.join(WEB, 'dist'),
    budget: path.join(WEB, 'bundle-budget.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--build', '--check', '--json'].includes(arg)) options[arg.slice(2)] = true;
    else if (/^--(route|dist|budget)(=|$)/.test(arg)) {
      const [name, inline] = arg.slice(2).split('=', 2);
      const value = inline ?? argv[++index];
      if (!value || value.startsWith('-')) throw new Error('У --' + name + ' нет значения');
      options[name] = value;
    } else if (arg.startsWith('-')) throw new Error('Неизвестный аргумент: ' + arg);
    else if (!options.route) options.route = arg;
    else throw new Error('Лишний аргумент: ' + arg);
  }
  if ((options.check || options.build) && path.resolve(options.dist) !== path.join(WEB, 'dist')) {
    throw new Error('--build/--check работает только со свежим production dist');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check || options.build) {
    // Vite's local default embeds a timestamp. A fixed BUILD_ID makes byte-level comparisons
    // deterministic; deployment still supplies its own commit id, independent of this gate.
    process.stderr.write('Сборка с BUILD_ID=quality-check…\n');
    try {
      execFileSync('pnpm', ['--filter', '@technic/web', 'build'], {
        cwd: WEB,
        stdio: options.json ? ['inherit', 2, 2] : 'inherit',
        env: { ...process.env, BUILD_ID: 'quality-check' },
      });
    } catch {
      // Never fall back to an old dist after a failed build: it describes different source code.
      throw new Error('Сборка не прошла — замер отменён.');
    }
  } else {
    process.stderr.write('Без --build меряется готовый dist: замер может быть устаревшим.\n');
  }
  const manifest = JSON.parse(readFileSync(path.join(options.dist, '.vite/manifest.json'), 'utf8'));
  const budget = JSON.parse(readFileSync(options.budget, 'utf8'));
  const report = bundleReport(manifest, options.dist, budget, options.route);
  if (options.json) say(JSON.stringify(report, null, 2));
  else {
    const row = (name, size) =>
      say(
        name +
          ': ' +
          (size.gzip / 1024).toFixed(1) +
          ' КиБ gzip; ' +
          size.gzip +
          ' байт; ' +
          size.files.length +
          ' JS-чанков',
      );
    row('entry', report.entry);
    for (const [id, size] of Object.entries(report.routes)) {
      row('entry + ' + id + (size.embedded ? ' (внутри entry)' : ''), size);
    }
    if (report.selected) row('Маршрут «' + report.selected.hint + '»', report.selected);
  }
  if (options.check) {
    const errors = budgetViolations(report, budget);
    if (errors.length) throw new Error('Бюджет бандла превышен:\n' + errors.join('\n'));
  }
}

// Exported functions let fixture tests exercise this same algorithm without building the portal.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
