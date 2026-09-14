/**
 * Обход дерева в пределах заявленной области.
 *
 * Область задаётся конфигом и применяется ОДИН раз, здесь: если бы каждый анализатор решал сам,
 * какие файлы смотреть, они разошлись бы в наборах, и метрики перестали бы сходиться с графом
 * зависимостей.
 */
import path from 'node:path';
import { readdirSync } from 'node:fs';
import type { ScopeConfig } from './config.ts';
import { matchesAny, normalizePath } from './paths.ts';

export interface ListOptions {
  readonly root: string;
  readonly scope: ScopeConfig;
  /** Расширения с точкой: `.ts`, `.tsx`. Пустой список — любые файлы. */
  readonly extensions: readonly string[];
}

/**
 * Все файлы области, отсортированные.
 *
 * Порядок задан явно, а не оставлен файловой системе: от него зависит порядок находок в отчёте, а
 * отчёт, который меняется от запуска к запуску на неизменённом коде, нечем сравнивать.
 */
export function listFiles(options: ListOptions): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Каталог исчез между чтением родителя и заходом внутрь. Для сборщика фактов это не событие:
      // он снимает картину дерева, а не стережёт его целостность.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = normalizePath(options.root, full);
      if (matchesAny(relative, options.scope.exclude)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.extensions.length > 0 && !options.extensions.includes(path.extname(entry.name))) {
        continue;
      }
      if (options.scope.include.length > 0 && !matchesAny(relative, options.scope.include))
        continue;
      out.push(relative);
    }
  };
  walk(options.root);
  return out.sort();
}

/** Попадает ли файл в область работы. */
export function inScope(root: string, scope: ScopeConfig, file: string): boolean {
  const relative = normalizePath(root, file);
  if (matchesAny(relative, scope.exclude)) return false;
  return scope.include.length === 0 || matchesAny(relative, scope.include);
}
