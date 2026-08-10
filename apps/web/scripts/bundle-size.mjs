#!/usr/bin/env node
/**
 * Сколько JS скачивает первый экран.
 *
 * Считать по именам файлов в dist нельзя: сегодня приложение — один чанк, а после разделения
 * бандла (этап 5 плана) у маршрута появятся собственные общие чанки, и «размер главного файла»
 * станет меньше, ничего на самом деле не улучшив. Поэтому берётся манифест сборки и от точки
 * входа рекурсивно обходятся синхронные импорты: динамические (`dynamicImports`) в счёт не идут —
 * их браузер и не запрашивает, пока пользователь не дойдёт до соответствующего экрана.
 *
 * Одна и та же функция считает и базовый замер, и любой последующий: сравнение «до/после» имеет
 * смысл, только если обе стороны посчитаны одинаково.
 *
 * Запуск: node scripts/bundle-size.mjs [--build] [--route <подстрока>]
 *   node scripts/bundle-size.mjs --build                → свежая сборка, затем точка входа
 *   node scripts/bundle-size.mjs --build --route waste  → она же плюс чанк раздела «Вывоз мусора»
 *   node scripts/bundle-size.mjs waste                  → готовый dist, маршрут можно и позиционно
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');

/**
 * Разбор аргументов вручную: позиционный маршрут появился раньше флагов, и `process.argv[2]`
 * иначе принял бы за подсказку сам `--build`. Обе формы маршрута оставлены живыми — прежние
 * вызовы из плана и из истории переписывать незачем.
 */
function parseArgs(argv) {
  let build = false;
  let route;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build') {
      build = true;
    } else if (arg === '--route' || arg.startsWith('--route=')) {
      const value = arg === '--route' ? argv[++index] : arg.slice('--route='.length);
      if (!value || value.startsWith('-')) {
        console.error('У --route нет значения: укажите подстроку пути, например --route waste');
        process.exit(1);
      }
      route = value;
    } else if (arg.startsWith('-')) {
      console.error(`Неизвестный аргумент: ${arg}`);
      process.exit(1);
    } else {
      route ??= arg;
    }
  }
  return { build, route };
}

const { build, route: routeHint } = parseArgs(process.argv.slice(2));

if (build) {
  /*
   * BUILD_ID задаёт замер, а не vite.config.ts: без переменной конфиг подставляет текущее время,
   * оно вшивается в бандл через `define` — и один и тот же код от сборки к сборке весит
   * по-разному. Бюджет по плавающему числу не сторожат, поэтому у проверки свой постоянный
   * идентификатор; релизный BUILD_ID (commit SHA) приходит от deploy-auto и сюда не относится.
   */
  console.log('Сборка с BUILD_ID=quality-check…');
  try {
    execFileSync('pnpm', ['--filter', '@technic/web', 'build'], {
      stdio: 'inherit',
      env: { ...process.env, BUILD_ID: 'quality-check' },
    });
  } catch {
    // Своя причина уже напечатана самой сборкой; мерить старый dist после провала нельзя — число
    // получится от кода, которого больше нет.
    console.error('Сборка не прошла — замер отменён.');
    process.exit(1);
  }
} else {
  // Считается то, что лежит в dist прямо сейчас: это может быть сборка недельной давности, и
  // расхождение с текущим кодом ничем себя не выдаёт — отсюда и предупреждение.
  console.warn('Без --build меряется готовый dist: замер может быть устаревшим.');
}

if (!existsSync(MANIFEST)) {
  console.error('Нет dist/.vite/manifest.json — соберите приложение: запустите с флагом --build');
  process.exit(1);
}

/** @type {Record<string, { file: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; src?: string; css?: string[] }>} */
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** Транзитивное замыкание синхронных импортов: то, что браузер обязан скачать вместе с чанком. */
function closure(startKeys) {
  const seen = new Set();
  const queue = [...startKeys];
  while (queue.length > 0) {
    const key = queue.shift();
    if (!key || seen.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) continue;
    seen.add(key);
    for (const next of chunk.imports ?? []) queue.push(next);
  }
  return seen;
}

function sizeOf(chunkKeys) {
  let raw = 0;
  let gzip = 0;
  const files = [];
  for (const key of chunkKeys) {
    const chunk = manifest[key];
    if (!chunk?.file) continue;
    const full = path.join(DIST, chunk.file);
    if (!existsSync(full)) continue;
    const content = readFileSync(full);
    raw += content.length;
    gzip += gzipSync(content).length;
    files.push({ file: chunk.file, bytes: content.length });
  }
  return { raw, gzip, files };
}

const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry);

/**
 * Чанк маршрута ищется по подстроке в `src` без учёта регистра: файлы страниц названы
 * `WasteRequestsPage.tsx`, а подсказку набирают строчными — точное сравнение не находило ничего.
 */
const needle = routeHint?.toLowerCase();
const routeKeys = needle
  ? Object.keys(manifest).filter((key) => (manifest[key].src ?? key).toLowerCase().includes(needle))
  : [];

/*
 * Промах — всегда ошибка, а не заметка внизу вывода: замер без чанка маршрута выглядит как
 * обычный замер точки входа, только меньше, и такое число легко принять за улучшение. Две
 * причины промаха неразличимы отсюда, поэтому названы обе.
 */
if (routeHint && routeKeys.length === 0) {
  console.error(
    `Маршрут «${routeHint}» не совпал ни с одним ключом манифеста: либо опечатка в подстроке, ` +
      'либо у маршрута ещё нет своего чанка — тогда его код внутри точки входа, и мерить его ' +
      'отдельно нечем (запустите без маршрута).',
  );
  process.exit(1);
}

const keys = closure([...entryKeys, ...routeKeys]);
const { raw, gzip, files } = sizeOf(keys);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;

console.log(`Точка входа: ${entryKeys.join(', ') || '—'}`);
if (routeHint) {
  console.log(`Маршрут «${routeHint}»: ${routeKeys.join(', ')}`);
}
console.log(`Чанков в замыкании: ${keys.size}`);
for (const f of files.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${f.file} — ${kb(f.bytes)}`);
}
console.log(`Итого JS первого экрана: ${kb(raw)} (gzip ${kb(gzip)})`);
