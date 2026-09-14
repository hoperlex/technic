/**
 * Публичный вход переносимого ядра.
 *
 * Всё, что нужно конфигу проекта и будущим адаптерам, экспортируется отсюда. Когда система
 * переедет во внешнюю библиотеку, этот файл станет её `index.ts` без правок — при условии, что в
 * него по-прежнему не попадёт ничего из `project/`.
 */
export { defineMaintenanceConfig, loadConfig, resolveConfig } from './core/config.ts';
export type {
  MaintenanceConfig,
  MaintenanceConfigInput,
  ScopeConfig,
  VerificationLevel,
} from './core/config.ts';
export type { DomainProvider, PolicyProvider, Reporter } from './core/contracts.ts';
export { MaintenanceConfigError } from './core/errors.ts';
export { bestMatch, matchesAny, matchesPattern, normalizePath } from './core/paths.ts';
export type * from './core/types.ts';
export { YamlPolicyProvider } from './policies/provider.ts';
export { isAtLeastAsStrict, resolveSurface, strictestMode } from './policies/surfaces.ts';
export { ensureWorkspace, isIgnoredByGit, workspaceOf } from './state/workspace.ts';
export type { Workspace } from './state/workspace.ts';
export { ConsoleReporter } from './reporters/console.ts';
