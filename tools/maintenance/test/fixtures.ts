/**
 * Заготовки для тестов: минимальные конфиг и свод правил.
 *
 * Собраны руками, а не прочитаны из `architecture/**` намеренно. Тест отбора обязан проверять
 * отбор, а не сегодняшнее содержимое политик проекта: иначе правка порога в YAML красила бы тесты,
 * ничего не сломав.
 */
import type { MaintenanceConfig } from '../core/config.ts';
import type { Finding, TrackedFinding } from '../core/finding.ts';
import { trackFinding } from '../core/finding.ts';
import type { ArchitecturePolicy, PolicySet, ProtectedSurface } from '../core/types.ts';

export const ROOT = '/repo';

export function configFixture(): MaintenanceConfig {
  return {
    root: ROOT,
    architectureDir: `${ROOT}/architecture`,
    runtimeDir: `${ROOT}/.maintenance`,
    files: {
      modules: '',
      policies: '',
      protectedSurfaces: '',
      exceptions: '',
      maintenance: '',
    },
    domains: null,
    verification: [{ id: 'gates', title: 'ворота', command: ['true'], enabledByDefault: true }],
    scope: { include: ['apps/**'], exclude: [] },
    analysis: {
      lintCommand: ['true'],
      typecheckCommand: ['true'],
      aliases: [],
      sourceExtensions: ['.ts'],
    },
  };
}

export function policySetFixture(overrides: Partial<PolicySet> = {}): PolicySet {
  const policies: ArchitecturePolicy[] = [
    {
      id: 'hard-rule',
      title: 'Жёсткое правило без автоправки',
      status: 'active',
      severity: 'hard',
      scope: ['apps/**'],
      enforcedBy: 'ai-review',
      adr: [],
      autofix: false,
      rule: 'правило',
      exceptionsRequireReason: true,
    },
    {
      id: 'soft-rule',
      title: 'Мягкое правило с разрешённой автоправкой',
      status: 'active',
      severity: 'soft',
      scope: ['apps/**'],
      enforcedBy: 'ai-review',
      adr: [],
      autofix: true,
      rule: 'правило',
      exceptionsRequireReason: true,
    },
    {
      id: 'advisory-rule',
      title: 'Совещательное правило',
      status: 'active',
      severity: 'advisory',
      scope: ['apps/**'],
      enforcedBy: 'human',
      adr: [],
      autofix: false,
      rule: 'правило',
      exceptionsRequireReason: true,
    },
  ];
  const surfaces: ProtectedSurface[] = [
    { id: 'migrations', mode: 'forbidden', paths: ['apps/api/drizzle/**'], why: '', see: [] },
    { id: 'tests', mode: 'manual-review', paths: ['apps/*/test/**'], why: '', see: [] },
  ];
  return {
    policies,
    surfaces,
    surfaceDefault: 'allowed',
    exceptions: [],
    maintenance: {
      runtimeHome: '.maintenance',
      convergence: {
        maxPasses: 3,
        maxFindingsPerPass: 2,
        maxFilesChanged: 3,
        maxChangedLines: 100,
        minAutofixConfidence: 0.8,
        allowedRisk: 'low',
        behaviorChanges: 'forbidden',
        passes: [{ id: 'structural', goal: 'цель', forbids: [] }],
      },
      deepMaintenance: {
        enabled: false,
        windowMinutes: 120,
        maxRepairBatches: 6,
        maxFindingsPerBatch: 3,
        maxFilesPerBatch: 8,
        maxChangedLinesPerBatch: 400,
        fullScan: 'allowed',
        zones: [],
      },
      ledger: {
        reopenOnCodeChange: true,
        reopenOnPolicyChange: true,
        deferredReviewDays: 90,
        falsePositiveReviewDays: 180,
      },
      stopConditions: ['maxPassesReached'],
    },
    moduleMap: { packages: [], layers: [], shared: [], domains: [] },
    ...overrides,
  };
}

/** Находка «всё в порядке»: её берут в работу, если ничего не мешает. */
export function findingFixture(overrides: Partial<Finding> = {}): TrackedFinding {
  return trackFinding({
    id: 'F1',
    category: 'dead-code',
    title: 'находка',
    severity: 'medium',
    confidence: 0.95,
    files: ['apps/api/src/x.ts'],
    evidence: 'доказательство',
    behaviorRisk: 'low',
    suggestedAction: 'действие',
    estimatedLines: 10,
    ...overrides,
  });
}
