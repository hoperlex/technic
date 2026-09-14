/**
 * Сборщик фактов: один проход, один файл, одна картина мира.
 *
 * ПОЧЕМУ СБОРЩИК ОДИН. Иначе каждая команда собирала бы факты по-своему, и отчёт отбора перестал
 * бы сходиться с заданием агенту: в одном 26 предупреждений, в другом 24, и объяснить разницу
 * нечем. Здесь же набор файлов, порядок и срез времени — общие для всех.
 *
 * ЧЕГО СБОРЩИК НЕ ДЕЛАЕТ. Он не судит: ни одна находка тут не рождается. Его дело — измеримое:
 * что изменено, что говорит линт и компилятор, где нарушены направления, какие правила и решения
 * относятся к затронутым файлам.
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { MaintenanceConfig } from '../core/config.ts';
import type { ProjectFacts, RelevanceFacts, SurfaceFact, ToolRun } from '../core/facts.ts';
import type { PolicySet } from '../core/types.ts';
import { listFiles } from '../core/files.ts';
import { matchesAny, normalizePath } from '../core/paths.ts';
import { resolveSurface } from '../policies/surfaces.ts';
import type { Workspace } from '../state/workspace.ts';
import { collectDependencies } from './dependencies.ts';
import { collectGit } from './git.ts';
import { collectLint, dropReport } from './lint.ts';
import { collectMetrics } from './metrics.ts';
import { run, skipped, toolRun } from './run.ts';

export interface CollectOptions {
  readonly config: MaintenanceConfig;
  readonly policies: PolicySet;
  readonly workspace: Workspace;
  /** Прогонять ли тесты: они дороги, и сборщик по умолчанию их не трогает. */
  readonly withTests: boolean;
  /** Ограничить область изменёнными файлами. Пусто — всё дерево. */
  readonly scopeFiles: readonly string[];
}

export function collectFacts(options: CollectOptions): ProjectFacts {
  const { config, policies, workspace } = options;
  const git = collectGit(config.root);

  const sourceFiles = listFiles({
    root: config.root,
    scope: config.scope,
    extensions: [...config.analysis.sourceExtensions],
  });

  const lintReport = path.join(workspace.tmp, 'lint.json');
  const lint = collectLint({
    root: config.root,
    command: config.analysis.lintCommand,
    outFile: lintReport,
    keepMessages: config.analysis.keepLintMessages ?? 200,
  });
  dropReport(lintReport);

  const typecheckRun = run(config.root, config.analysis.typecheckCommand);
  const typecheck: ToolRun = toolRun(
    typecheckRun,
    typecheckRun.code === 0 ? 'типы сходятся' : `типы не сходятся (код ${typecheckRun.code})`,
  );

  const tests = options.withTests ? runTests(config) : skipped('запрошен сбор без тестов');

  const metrics = collectMetrics(config.root, sourceFiles, config.analysis.keepLargestFiles ?? 30);
  const dependencies = collectDependencies({
    root: config.root,
    files: sourceFiles,
    packages: policies.moduleMap.packages,
    aliases: config.analysis.aliases,
    maxCycles: config.analysis.maxCycles ?? 20,
  });

  const scopeFiles = options.scopeFiles.map((file) => normalizePath(config.root, file)).sort();
  const relevance = relevanceOf(
    config,
    policies,
    scopeFiles.length > 0 ? scopeFiles : git.changedFiles,
  );

  return {
    collectedAt: new Date().toISOString(),
    root: config.root,
    git,
    lint,
    typecheck,
    tests,
    metrics,
    dependencies,
    relevance,
    scopeFiles,
  };
}

/**
 * Тесты идут теми же уровнями проверки, что и подтверждение поведения.
 *
 * Второго способа звать тесты в системе нет намеренно: набор, которым доказывают сохранение
 * поведения, и набор, который смотрит сборщик фактов, обязаны совпадать. Разойдись они — и
 * «зелёные факты» перестали бы что-либо значить для решения об откате.
 */
function runTests(config: MaintenanceConfig): ToolRun {
  const levels = config.verification.filter((level) => level.enabledByDefault);
  if (levels.length === 0) return skipped('ни один уровень проверки не включён');
  let durationMs = 0;
  const parts: string[] = [];
  let ok = true;
  for (const level of levels) {
    const result = run(config.root, level.command);
    durationMs += result.durationMs;
    ok = ok && result.code === 0;
    parts.push(`${level.id}: ${result.code === 0 ? 'зелено' : `код ${result.code}`}`);
  }
  return { ok, durationMs, summary: parts.join('; ') };
}

/**
 * Что относится к затронутым файлам: домены, правила, решения, защищённые области.
 *
 * Это и есть удешевление прогона: агент получает не весь свод правил проекта, а те, что
 * действуют в затронутых местах. Неизменённые области в контекст не попадают.
 */
export function relevanceOf(
  config: MaintenanceConfig,
  policies: PolicySet,
  files: readonly string[],
): RelevanceFacts {
  const domains = new Set<string>();
  const rules = new Set<string>();
  const adr = new Set<string>();
  const surfaces: SurfaceFact[] = [];

  for (const file of files) {
    const relative = normalizePath(config.root, file);

    for (const domain of policies.moduleMap.domains) {
      if (domain.paths.some((item) => relative === item || relative.startsWith(`${item}/`))) {
        domains.add(domain.id);
        for (const link of domain.adr) adr.add(link);
      }
    }

    for (const policy of policies.policies) {
      if (policy.status !== 'active') continue;
      if (policy.scope.length > 0 && !matchesAny(relative, policy.scope)) continue;
      rules.add(policy.id);
      for (const link of policy.adr) adr.add(link);
    }

    const verdict = resolveSurface(
      config.root,
      policies.surfaces,
      policies.surfaceDefault,
      relative,
    );
    // В факты идут только ограничения: перечислять «можно» для каждого файла значит утопить
    // единственное, что важно, — места, где нельзя.
    if (verdict.mode !== 'allowed' && verdict.surface !== null) {
      surfaces.push({ file: relative, mode: verdict.mode, surface: verdict.surface.id });
    }
  }

  return {
    domains: [...domains].sort(),
    policies: [...rules].sort(),
    adr: [...adr].sort(),
    surfaces,
  };
}

/** Факты кладутся в рабочий каталог: это производное состояние, и в истории ему не место. */
export function saveFacts(workspace: Workspace, facts: ProjectFacts): string {
  const file = path.join(workspace.context, 'project-facts.json');
  writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`, 'utf8');
  return file;
}
