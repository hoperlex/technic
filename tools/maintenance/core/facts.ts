/**
 * Факты о проекте: то, что система знает без участия модели.
 *
 * ГЛАВНОЕ СВОЙСТВО — ДЕТЕРМИНИРОВАННОСТЬ. Каждый факт добыт инструментом, который можно
 * перезапустить и получить тот же ответ. Агент не должен каждый раз заново исследовать
 * репозиторий: то, что считается машиной, обязано быть посчитано машиной — иначе прогон дорожает,
 * а ответы плывут от запуска к запуску.
 */
import type { Severity } from './types.ts';

/** Состояние дерева на момент сбора. */
export interface GitFacts {
  readonly head: string;
  readonly branch: string;
  /** Чистое дерево — условие автоматических правок: иначе откат унесёт чужую работу. */
  readonly clean: boolean;
  readonly changedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
}

/** Итог запуска внешнего инструмента. */
export interface ToolRun {
  readonly ok: boolean;
  readonly durationMs: number;
  /** Короткая человеческая строка итога: её печатают в отчёте и кладут в задание агенту. */
  readonly summary: string;
  /** Заполнено, если шаг не выполнялся, и тогда `ok` ничего не доказывает. */
  readonly skipped?: string;
}

export interface LintMessage {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface LintFacts extends ToolRun {
  /**
   * Удалось ли получить машинный отчёт.
   *
   * Отдельно от `ok`, и это не педантизм: `ok: false` значит «в коде есть ошибки», а
   * `measured: false` — «инструмент не смог проверить». Спутать их опасно ровно в одну сторону:
   * ноль ошибок у несработавшего линта выглядит как чистый код и пропускает правку в приём.
   */
  readonly measured: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly byRule: Readonly<Record<string, number>>;
  readonly messages: readonly LintMessage[];
}

/** Размер и доля комментариев. Комментарии считаются отдельно и в долг не записываются. */
export interface FileMetrics {
  readonly file: string;
  readonly lines: number;
  readonly codeLines: number;
  readonly commentLines: number;
}

export interface MetricFacts {
  readonly files: number;
  readonly totalLines: number;
  readonly largest: readonly FileMetrics[];
}

/** Нарушение направления зависимостей или цикл — считается статически, без модели. */
export interface DependencyViolation {
  readonly kind: 'direction' | 'cycle' | 'unknown-package';
  readonly from: string;
  readonly to: string;
  readonly files: readonly string[];
  readonly severity: Severity;
  readonly detail: string;
}

export interface DependencyFacts extends ToolRun {
  readonly modules: number;
  readonly edges: number;
  readonly violations: readonly DependencyViolation[];
}

/** Решение по одному файлу: можно ли его трогать. */
export interface SurfaceFact {
  readonly file: string;
  readonly mode: string;
  readonly surface: string;
}

/** Какие правила и решения относятся к затронутым файлам. Этим сужается контекст агента. */
export interface RelevanceFacts {
  readonly domains: readonly string[];
  readonly policies: readonly string[];
  readonly adr: readonly string[];
  readonly surfaces: readonly SurfaceFact[];
}

export interface ProjectFacts {
  readonly collectedAt: string;
  readonly root: string;
  readonly git: GitFacts;
  readonly lint: LintFacts;
  readonly typecheck: ToolRun;
  readonly tests: ToolRun;
  readonly metrics: MetricFacts;
  readonly dependencies: DependencyFacts;
  readonly relevance: RelevanceFacts;
  /** Файлы, вокруг которых работает этот прогон. Пусто — прогон по всему дереву. */
  readonly scopeFiles: readonly string[];
}
