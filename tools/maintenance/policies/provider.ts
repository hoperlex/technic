/**
 * Поставщик правил по умолчанию: читает машинный слой архитектуры из YAML.
 *
 * Переносимая часть. Он знает форму файлов, но не знает ни их содержимого, ни репозитория: пути
 * приходят конфигом, домены — отдельным поставщиком.
 */
import path from 'node:path';
import type { DomainProvider, PolicyProvider } from '../core/contracts.ts';
import type { MaintenanceConfig } from '../core/config.ts';
import { MaintenanceConfigError } from '../core/errors.ts';
import type {
  ArchitectureException,
  ArchitecturePolicy,
  ConvergencePass,
  DeepMaintenanceZone,
  Domain,
  Enforcer,
  LayerModel,
  ModuleMap,
  ModulePackage,
  PolicySet,
  PolicyStatus,
  ProtectedSurface,
  Severity,
  SurfaceMode,
} from '../core/types.ts';
import {
  asNode,
  bool,
  nodeList,
  num,
  oneOf,
  optionalStr,
  readYaml,
  str,
  strList,
  type Node,
  type Where,
} from './read.ts';

const SEVERITIES: readonly Severity[] = ['hard', 'soft', 'advisory'];
const STATUSES: readonly PolicyStatus[] = ['active', 'draft', 'retired'];
const ENFORCERS: readonly Enforcer[] = [
  'eslint',
  'check-docs',
  'quality-budget',
  'tests',
  'ai-review',
  'human',
];
const MODES: readonly SurfaceMode[] = ['allowed', 'manual-review', 'forbidden'];

export class YamlPolicyProvider implements PolicyProvider {
  readonly #config: MaintenanceConfig;
  readonly #domains: DomainProvider | null;

  constructor(config: MaintenanceConfig) {
    this.#config = config;
    this.#domains = config.domains;
  }

  async load(): Promise<PolicySet> {
    const shortName = (file: string) => path.relative(this.#config.root, file);
    const policies = this.#readPolicies(
      this.#config.files.policies,
      shortName(this.#config.files.policies),
    );
    const surfacesFile = readYaml(
      this.#config.files.protectedSurfaces,
      shortName(this.#config.files.protectedSurfaces),
    );
    const surfacesWhere: Where = {
      file: shortName(this.#config.files.protectedSurfaces),
      at: 'surfaces',
    };
    const surfaces = nodeList(surfacesWhere, surfacesFile['surfaces']).map((node, index) =>
      readSurface({ file: surfacesWhere.file, at: `surfaces[${index}]` }, node),
    );
    const surfaceDefault = oneOf(surfacesWhere, surfacesFile, 'default', MODES, 'allowed');

    const exceptions = this.#readExceptions(policies);
    const maintenance = this.#readMaintenance();
    const moduleMap = await this.#readModuleMap();

    return { policies, surfaces, surfaceDefault, exceptions, maintenance, moduleMap };
  }

  #readPolicies(file: string, shortName: string): ArchitecturePolicy[] {
    const root = readYaml(file, shortName);
    const seen = new Set<string>();
    return nodeList({ file: shortName, at: 'policies' }, root['policies']).map((node, index) => {
      const where: Where = { file: shortName, at: `policies[${index}]` };
      const id = str(where, node, 'id');
      // Задвоенный идентификатор — не придирка: правила адресуются по нему из исключений и из
      // находок, и вторая запись молча перекрыла бы первую.
      if (seen.has(id))
        throw new MaintenanceConfigError(shortName, `правило ${id} объявлено дважды`);
      seen.add(id);
      const exceptionsNode = node['exceptions'];
      const requireReason =
        exceptionsNode === undefined || exceptionsNode === null
          ? true
          : bool(
              { file: shortName, at: `${where.at}.exceptions` },
              asNode(where, exceptionsNode),
              'requireReason',
              true,
            );
      return {
        id,
        title: str(where, node, 'title'),
        status: oneOf(where, node, 'status', STATUSES, 'active'),
        severity: oneOf(where, node, 'severity', SEVERITIES),
        scope: strList(where, node, 'scope'),
        enforcedBy: oneOf(where, node, 'enforcedBy', ENFORCERS),
        source: optionalStr(where, node, 'source'),
        adr: strList(where, node, 'adr'),
        autofix: bool(where, node, 'autofix', false),
        rule: str(where, node, 'rule'),
        detect: optionalStr(where, node, 'detect'),
        notes: optionalStr(where, node, 'notes'),
        exceptionsRequireReason: requireReason,
      } satisfies ArchitecturePolicy;
    });
  }

  #readExceptions(policies: readonly ArchitecturePolicy[]): ArchitectureException[] {
    const shortName = path.relative(this.#config.root, this.#config.files.exceptions);
    const root = readYaml(this.#config.files.exceptions, shortName);
    const known = new Set(policies.map((policy) => policy.id));
    return nodeList({ file: shortName, at: 'exceptions' }, root['exceptions'], {
      optional: true,
    }).map((node, index) => {
      const where: Where = { file: shortName, at: `exceptions[${index}]` };
      const policy = str(where, node, 'policy');
      // Исключение из несуществующего правила — след переименования: правило ушло, разрешение
      // осталось и теперь не действует ни на что, продолжая выглядеть действующим.
      if (!known.has(policy)) {
        throw new MaintenanceConfigError(
          shortName,
          `${where.at}: правила ${policy} нет в architecture.yaml`,
        );
      }
      return {
        id: str(where, node, 'id'),
        policy,
        paths: strList(where, node, 'paths', { optional: false }),
        reason: str(where, node, 'reason'),
        approvedBy: optionalStr(where, node, 'approvedBy'),
        since: optionalStr(where, node, 'since'),
        reviewBy: optionalStr(where, node, 'reviewBy'),
      } satisfies ArchitectureException;
    });
  }

  #readMaintenance() {
    const shortName = path.relative(this.#config.root, this.#config.files.maintenance);
    const root = readYaml(this.#config.files.maintenance, shortName);
    const where: Where = { file: shortName, at: 'convergence' };
    const runtime = asNode({ file: shortName, at: 'runtime' }, root['runtime']);
    const convergence = asNode(where, root['convergence']);
    const deep = asNode({ file: shortName, at: 'deepMaintenance' }, root['deepMaintenance']);
    const ledger = asNode({ file: shortName, at: 'ledger' }, root['ledger']);

    const passes: ConvergencePass[] = nodeList(
      { file: shortName, at: 'convergence.passes' },
      convergence['passes'],
    ).map((node, index) => {
      const at: Where = { file: shortName, at: `convergence.passes[${index}]` };
      return {
        id: str(at, node, 'id'),
        goal: str(at, node, 'goal'),
        forbids: strList(at, node, 'forbids'),
      };
    });
    // Проходов не может быть больше, чем разрешено проходов: иначе лимит описывает не то, что
    // исполняется, и «три прохода» в политике означали бы пять в прогоне.
    const maxPasses = num(where, convergence, 'maxPasses');
    if (passes.length > maxPasses) {
      throw new MaintenanceConfigError(
        shortName,
        `описано ${passes.length} проходов при maxPasses=${maxPasses}`,
      );
    }

    const zones: DeepMaintenanceZone[] = nodeList(
      { file: shortName, at: 'deepMaintenance.zones' },
      deep['zones'],
      { optional: true },
    ).map((node, index) => {
      const at: Where = { file: shortName, at: `deepMaintenance.zones[${index}]` };
      return {
        id: str(at, node, 'id'),
        looksFor: strList(at, node, 'looksFor'),
        mayChange: strList(at, node, 'mayChange'),
        mustNotChange: strList(at, node, 'mustNotChange'),
      };
    });

    /*
     * Условия старта необязательны в файле: политика, написанная до появления F12, обязана
     * читаться дальше. Умолчание — мягкое (только предупреждать): строгий режим меняет не
     * настройку, а право прогона вообще начаться, и включать его молча за человека нельзя.
     */
    const startNode = root['start'];
    const start =
      startNode === undefined || startNode === null
        ? { requireClean: false, requireGreen: false }
        : {
            requireClean: bool(
              { file: shortName, at: 'start' },
              asNode(where, startNode),
              'requireClean',
              false,
            ),
            requireGreen: bool(
              { file: shortName, at: 'start' },
              asNode(where, startNode),
              'requireGreen',
              false,
            ),
          };

    return {
      runtimeHome: str({ file: shortName, at: 'runtime' }, runtime, 'home'),
      start,
      convergence: {
        maxPasses,
        maxFindingsPerPass: num(where, convergence, 'maxFindingsPerPass'),
        maxFilesChanged: num(where, convergence, 'maxFilesChanged'),
        maxChangedLines: num(where, convergence, 'maxChangedLines'),
        minAutofixConfidence: num(where, convergence, 'minAutofixConfidence'),
        allowedRisk: oneOf(
          where,
          convergence,
          'allowedRisk',
          ['low', 'medium', 'high'] as const,
          'low',
        ),
        behaviorChanges: oneOf(
          where,
          convergence,
          'behaviorChanges',
          ['forbidden', 'allowed'] as const,
          'forbidden',
        ),
        passes,
      },
      deepMaintenance: {
        enabled: bool({ file: shortName, at: 'deepMaintenance' }, deep, 'enabled', false),
        zoneMinutes: num({ file: shortName, at: 'deepMaintenance' }, deep, 'zoneMinutes'),
        maxRepairBatches: num({ file: shortName, at: 'deepMaintenance' }, deep, 'maxRepairBatches'),
        maxFindingsPerBatch: num(
          { file: shortName, at: 'deepMaintenance' },
          deep,
          'maxFindingsPerBatch',
        ),
        maxFilesPerBatch: num({ file: shortName, at: 'deepMaintenance' }, deep, 'maxFilesPerBatch'),
        maxChangedLinesPerBatch: num(
          { file: shortName, at: 'deepMaintenance' },
          deep,
          'maxChangedLinesPerBatch',
        ),
        fullScan: oneOf(
          { file: shortName, at: 'deepMaintenance' },
          deep,
          'fullScan',
          ['allowed', 'forbidden'] as const,
          'forbidden',
        ),
        zones,
      },
      ledger: {
        reopenOnCodeChange: bool(
          { file: shortName, at: 'ledger' },
          ledger,
          'reopenOnCodeChange',
          true,
        ),
        reopenOnPolicyChange: bool(
          { file: shortName, at: 'ledger' },
          ledger,
          'reopenOnPolicyChange',
          true,
        ),
        deferredReviewDays: num({ file: shortName, at: 'ledger' }, ledger, 'deferredReviewDays'),
        falsePositiveReviewDays: num(
          { file: shortName, at: 'ledger' },
          ledger,
          'falsePositiveReviewDays',
        ),
      },
      stopConditions: strList({ file: shortName, at: 'stopConditions' }, root, 'stopConditions', {
        optional: false,
      }),
    };
  }

  async #readModuleMap(): Promise<ModuleMap> {
    const shortName = path.relative(this.#config.root, this.#config.files.modules);
    const root = readYaml(this.#config.files.modules, shortName);
    const packages: ModulePackage[] = nodeList(
      { file: shortName, at: 'packages' },
      root['packages'],
    ).map((node, index) => {
      const where: Where = { file: shortName, at: `packages[${index}]` };
      return {
        id: str(where, node, 'id'),
        path: str(where, node, 'path'),
        role: str(where, node, 'role'),
        publicApi: optionalStr(where, node, 'publicApi'),
        mayDependOn: strList(where, node, 'mayDependOn'),
        notes: optionalStr(where, node, 'notes'),
      };
    });
    const ids = new Set(packages.map((item) => item.id));
    for (const item of packages) {
      for (const dependency of item.mayDependOn) {
        if (!ids.has(dependency)) {
          throw new MaintenanceConfigError(
            shortName,
            `пакет ${item.id} ссылается на неизвестный ${dependency}`,
          );
        }
      }
    }

    const layers: LayerModel[] = nodeList({ file: shortName, at: 'layers' }, root['layers'], {
      optional: true,
    }).map((node, index) => {
      const where: Where = { file: shortName, at: `layers[${index}]` };
      return {
        id: str(where, node, 'id'),
        scope: str(where, node, 'scope'),
        enforcedBy: oneOf(where, node, 'enforcedBy', ENFORCERS),
        source: optionalStr(where, node, 'source'),
        order: strList(where, node, 'order'),
        entry: optionalStr(where, node, 'entry'),
        notes: optionalStr(where, node, 'notes'),
      };
    });

    const domains: readonly Domain[] = this.#domains
      ? await this.#domains.load(this.#config.root)
      : [];
    return {
      packages,
      layers,
      shared: strList({ file: shortName, at: 'shared' }, root, 'shared'),
      domains,
    };
  }
}

function readSurface(where: Where, node: Node): ProtectedSurface {
  return {
    id: str(where, node, 'id'),
    mode: oneOf(where, node, 'mode', MODES),
    paths: strList(where, node, 'paths', { optional: false }),
    why: str(where, node, 'why'),
    see: strList(where, node, 'see'),
  };
}
