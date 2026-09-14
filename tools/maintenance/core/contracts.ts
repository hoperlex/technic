/**
 * Границы системы, вынесенные в интерфейсы.
 *
 * Здесь ровно те интерфейсы, у которых уже есть реализация: абстракция, придуманная заранее «на
 * вырост», описывает воображаемую систему, а не эту. Остальные (`Analyzer`, `FindingStore`,
 * `AgentAdapter`, `WorkspaceTransaction`, `Verifier`, `ScopeResolver`) появятся вместе со своими
 * этапами — план называет их поимённо.
 */
import type { Domain, PolicySet } from './types.ts';

/**
 * Откуда система узнаёт логические области проекта.
 *
 * Интерфейс существует ради одной вещи: состав доменов — единственное, что в этом репозитории
 * описано человеческим документом (картой кода), а в другом может прийти из конфига, из структуры
 * каталогов или ниоткуда. Ядру знать об этом не нужно.
 */
export interface DomainProvider {
  /** Человеку в отчёте: откуда взяты домены. */
  readonly id: string;
  load(root: string): Promise<readonly Domain[]>;
}

/** Откуда система берёт правила. Реализация по умолчанию читает `architecture/**`. */
export interface PolicyProvider {
  load(): Promise<PolicySet>;
}

/** Куда система печатает. Отделено от логики, чтобы отчёт мог уйти не только в терминал. */
export interface Reporter {
  line(text?: string): void;
  heading(text: string): void;
  item(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}
