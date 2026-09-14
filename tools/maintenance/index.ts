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
export type { Finding, TrackedFinding, FindingSeverity, BehaviorRisk } from './core/finding.ts';
export { fingerprintOf, trackFinding } from './core/finding.ts';
export { parseFindings } from './core/finding-io.ts';
export type { ParseResult } from './core/finding-io.ts';
export { selectFindings } from './core/selector.ts';
export type { Decision, Selection, SelectOptions, Verdict } from './core/selector.ts';
export type * from './core/facts.ts';
export { inScope, listFiles } from './core/files.ts';
export { collectFacts, relevanceOf, saveFacts } from './analyzers/facts.ts';
export { collectDependencies } from './analyzers/dependencies.ts';
export { collectGit, changedSince } from './analyzers/git.ts';
export { collectLint } from './analyzers/lint.ts';
export { collectMetrics, measureFile } from './analyzers/metrics.ts';
export { run, toolRun, skipped, withOutFile } from './analyzers/run.ts';
export { renderPacket } from './work-packets/render.ts';
export { reviewerPacket } from './work-packets/reviewer.ts';
export { fixerPacket } from './work-packets/fixer.ts';
export type { PacketRole, PacketSection, WorkPacket } from './work-packets/types.ts';
export { YamlPolicyProvider } from './policies/provider.ts';
export { isAtLeastAsStrict, resolveSurface, strictestMode } from './policies/surfaces.ts';
export { ensureWorkspace, isIgnoredByGit, workspaceOf } from './state/workspace.ts';
export type { Workspace } from './state/workspace.ts';
export { ConsoleReporter } from './reporters/console.ts';
