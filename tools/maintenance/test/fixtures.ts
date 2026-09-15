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
import type {
  ArchitectureException,
  ArchitecturePolicy,
  PolicySet,
  ProtectedSurface,
} from '../core/types.ts';

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
      start: { requireClean: false, requireGreen: false },
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

/**
 * Действующее исключение: то же правило, что у находки-заготовки с `policy: 'soft-rule'`, та же
 * маска и срок пересмотра позже дня прогона в тестах.
 *
 * Дата задана явно, а не «через год от сегодня»: исключение с плавающим сроком проверяло бы в
 * тесте сегодняшнее число, а не отбор, и тест о просрочке однажды позеленел бы сам.
 */
export function exceptionFixture(
  overrides: Partial<ArchitectureException> = {},
): ArchitectureException {
  return {
    id: 'E1',
    policy: 'soft-rule',
    paths: ['apps/api/src/**'],
    reason: 'здесь правило нарушено осознанно',
    approvedBy: 'человек',
    since: '2026-01-01',
    reviewBy: '2026-12-31',
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
