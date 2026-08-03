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
 * Запуск: node scripts/bundle-size.mjs [маршрут]
 *   node scripts/bundle-size.mjs            → точка входа
 *   node scripts/bundle-size.mjs waste      → точка входа + чанк раздела «Вывоз мусора»
 */
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');

if (!existsSync(MANIFEST)) {
  console.error(
    'Нет dist/.vite/manifest.json — соберите приложение: pnpm --filter @technic/web build',
  );
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

const routeHint = process.argv[2];
const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry);

/**
 * Чанк маршрута ищется по подстроке в `src`. Пока разделения нет, он лежит внутри точки входа —
 * тогда замер честно показывает, что первый экран тянет всё приложение целиком.
 */
const routeKeys = routeHint
  ? Object.keys(manifest).filter((key) => (manifest[key].src ?? key).includes(routeHint))
  : [];

const keys = closure([...entryKeys, ...routeKeys]);
const { raw, gzip, files } = sizeOf(keys);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;

console.log(`Точка входа: ${entryKeys.join(', ') || '—'}`);
if (routeHint) {
  console.log(
    `Маршрут «${routeHint}»: ${routeKeys.length > 0 ? routeKeys.join(', ') : 'своего чанка нет — код внутри точки входа'}`,
  );
}
console.log(`Чанков в замыкании: ${keys.size}`);
for (const f of files.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${f.file} — ${kb(f.bytes)}`);
}
console.log(`Итого JS первого экрана: ${kb(raw)} (gzip ${kb(gzip)})`);
