/**
 * Размер файлов и доля комментариев.
 *
 * КОММЕНТАРИИ СЧИТАЮТСЯ ОТДЕЛЬНО И В ДОЛГ НЕ ЗАПИСЫВАЮТСЯ. Это не мелочь учёта: в проекте, где
 * комментарий объясняет причину решения, счётчик «строк всего» наказывал бы за объяснения и
 * поощрял их снимать. Поэтому метрика файла — строки кода; объём комментариев показывается рядом
 * как отдельная величина и целью обслуживания не является.
 *
 * Разбор намеренно простой (без построения дерева разбора): метрика нужна как СИГНАЛ для отбора
 * кандидатов, и точность до строки здесь не окупается. Ошибки разбора возможны на строке вида
 * `const url = 'https://…'` — такая строка посчитается кодом, и это верный ответ.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { FileMetrics, MetricFacts } from '../core/facts.ts';

export function measureFile(root: string, file: string): FileMetrics {
  const text = readFileSync(path.join(root, file), 'utf8');
  let code = 0;
  let comment = 0;
  let inBlock = false;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (inBlock) {
      comment += 1;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      comment += 1;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) {
      comment += 1;
      continue;
    }
    code += 1;
  }
  return { file, lines: lines.length, codeLines: code, commentLines: comment };
}

export function collectMetrics(
  root: string,
  files: readonly string[],
  keepLargest: number,
): MetricFacts {
  const measured: FileMetrics[] = [];
  let total = 0;
  for (const file of files) {
    try {
      const metrics = measureFile(root, file);
      measured.push(metrics);
      total += metrics.lines;
    } catch {
      // Нечитаемый файл в метрике не участвует. Сообщать об этом должен не счётчик строк: если
      // файл действительно сломан, об этом скажут типы и тесты.
    }
  }
  measured.sort((a, b) => b.codeLines - a.codeLines || (a.file < b.file ? -1 : 1));
  return { files: measured.length, totalLines: total, largest: measured.slice(0, keepLargest) };
}
