/**
 * Инкрементальная область: от изменённых файлов к тем, кого правка может задеть.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Список изменённых файлов сам по себе лжёт в обе стороны. Он слишком
 * узок: правка в общем месте ломает не себя, а тех, кто ею пользуется, и ревьюер, видящий только
 * изменённый файл, договорённости соседа не нарушит разве что случайно. И он же слишком широк,
 * если соседей брать все подряд: связный граф портала утягивает в контекст половину дерева, а
 * агент с половиной дерева в контексте перестаёт отвечать по существу. Здесь проводится граница
 * между этими двумя бедами, и проводится она явно — числом шагов и потолком размера.
 *
 * СОСЕДСТВО СЧИТАЕТСЯ В ОБЕ СТОРОНЫ. Граф импортов направлен «кто кого зовёт», но поломка ходит
 * против этого направления: меняется общий модуль — падают его потребители, а по прямым рёбрам их
 * не видно вовсе. Поэтому обратные рёбра строятся здесь же из того же графа, и «сосед» означает
 * связь любой направленности.
 *
 * ЗДЕСЬ НЕТ НИ ДИСКА, НИ GIT, НИ КОНФИГА ЭТОГО РЕПОЗИТОРИЯ: граф, домены и правила приходят
 * аргументом. Иначе границу области нельзя было бы проверить, не собрав предварительно факты по
 * всему дереву, — то есть она бы не проверялась.
 */
import { matchesAny } from './paths.ts';
import type { ArchitecturePolicy, Domain } from './types.ts';

export interface ScopeInput {
  readonly changedFiles: readonly string[];
  /** Граф импортов: файл → файлы, которые он импортирует. */
  readonly graph: ReadonlyMap<string, readonly string[]>;
  readonly domains: readonly Domain[];
  readonly policies: readonly ArchitecturePolicy[];
  /** Сколько шагов по графу считать «соседством». 1 — прямые соседи. */
  readonly neighbourDepth: number;
  /** Потолок размера области: дальше расширять нельзя, иначе контекст агента раздувается. */
  readonly maxFiles: number;
}

export interface ResolvedScope {
  readonly seeds: readonly string[];
  readonly files: readonly string[];
  readonly domains: readonly string[];
  readonly adr: readonly string[];
  readonly policies: readonly string[];
  /** Чем ограничились и почему: для отчёта человеку. */
  readonly limitedBy: 'depth' | 'maxFiles' | null;
}

export function resolveIncrementalScope(input: ScopeInput): ResolvedScope {
  // Вход приводится к упорядоченному множеству до всякой работы: тот же набор файлов, поданный в
  // другом порядке или с повтором, обязан дать тот же ответ — иначе два прогона на одном дереве
  // спорят друг с другом, и объяснить разницу человеку нечем.
  const changed = [...new Set(input.changedFiles)].sort();
  const { forward, backward, nodes } = buildEdges(input.graph);

  const seeds = changed.filter((file) => nodes.has(file));

  // Изменённый файл входит в область всегда, даже если графа он не знает: новый файл, разметка,
  // конфиг. Потерять его значит скрыть от ревьюера саму правку, ради которой прогон и затеян,
  // поэтому потолок ограничивает расширение, а не сам факт изменения.
  const files = new Set<string>(changed);
  const visited = new Set<string>(changed);
  let limitedBy: ResolvedScope['limitedBy'] = files.size > input.maxFiles ? 'maxFiles' : null;

  /*
   * Обход идёт слоями, и это единственный способ выполнить требование «ближние соседи важнее
   * дальних» без отдельной сортировки по важности: слой шага N целиком укладывается в область
   * раньше, чем начинается слой N+1. Потолок поэтому режет всегда самый дальний из достигнутых
   * слоёв и никогда — ближний. Внутри одного слоя все файлы равноудалены, различить их нечем, и
   * ничья разрешается именем: произвольно, зато одинаково от запуска к запуску.
   */
  let frontier = seeds;
  for (let step = 0; step < input.neighbourDepth && limitedBy === null; step += 1) {
    const next = neighboursOf(frontier, forward, backward, visited);
    if (next.length === 0) break;
    const accepted: string[] = [];
    for (const file of next) {
      if (files.size >= input.maxFiles) {
        limitedBy = 'maxFiles';
        break;
      }
      files.add(file);
      visited.add(file);
      accepted.push(file);
    }
    frontier = accepted;
  }

  // Разница между «взяли всё, что связано» и «упёрлись в глубину» видна только по остатку: если
  // за последним слоем кто-то ещё есть, область неполна, и человек должен знать, что её обрезала
  // именно глубина, а не потолок.
  if (limitedBy === null && neighboursOf(frontier, forward, backward, visited).length > 0) {
    limitedBy = 'depth';
  }

  const scopeFiles = [...files].sort();
  return {
    seeds,
    files: scopeFiles,
    ...relevanceOfScope(scopeFiles, input.domains, input.policies),
    limitedBy,
  };
}

interface Edges {
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly backward: ReadonlyMap<string, readonly string[]>;
  readonly nodes: ReadonlySet<string>;
}

/**
 * Обратные рёбра строятся здесь, а не хранятся рядом с графом.
 *
 * Граф импортов собирается разбором файлов и живёт в фактах одним направлением; второе — его
 * следствие, а не независимые данные. Хранить оба значило бы завести две версии одной правды,
 * которые разойдутся при первой же неполной перезаписи.
 */
function buildEdges(graph: ReadonlyMap<string, readonly string[]>): Edges {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const [from, targets] of graph) {
    nodes.add(from);
    for (const to of targets) {
      nodes.add(to);
      push(forward, from, to);
      push(backward, to, from);
    }
  }
  return { forward, backward, nodes };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const known = map.get(key);
  if (known === undefined) map.set(key, [value]);
  else if (!known.includes(value)) known.push(value);
}

/** Ещё не взятые соседи слоя, в обе стороны и по именам. */
function neighboursOf(
  frontier: readonly string[],
  forward: ReadonlyMap<string, readonly string[]>,
  backward: ReadonlyMap<string, readonly string[]>,
  visited: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  for (const file of frontier) {
    for (const edges of [forward.get(file), backward.get(file)]) {
      for (const neighbour of edges ?? []) {
        if (!visited.has(neighbour)) found.add(neighbour);
      }
    }
  }
  return [...found].sort();
}

/**
 * Правила и решения подбираются по ВСЕЙ области, а не по изменённым файлам.
 *
 * В этом и смысл расширения: договорённость, которую ломает правка, записана у соседа. Взять его
 * файл в контекст и не взять его ADR значило бы показать ревьюеру код без правил, по которым он
 * написан, — то есть предложить ему додумать их заново.
 */
function relevanceOfScope(
  files: readonly string[],
  domains: readonly Domain[],
  policies: readonly ArchitecturePolicy[],
): Pick<ResolvedScope, 'domains' | 'adr' | 'policies'> {
  const domainIds = new Set<string>();
  const policyIds = new Set<string>();
  const adr = new Set<string>();

  for (const file of files) {
    for (const domain of domains) {
      if (!domain.paths.some((item) => file === item || file.startsWith(`${item}/`))) continue;
      domainIds.add(domain.id);
      for (const link of domain.adr) adr.add(link);
    }
    for (const policy of policies) {
      if (policy.status !== 'active') continue;
      // Пустая область у правила — не промах, а «действует везде»: так записаны правила, которые
      // не привязаны к путям вовсе.
      if (policy.scope.length > 0 && !matchesAny(file, policy.scope)) continue;
      policyIds.add(policy.id);
      for (const link of policy.adr) adr.add(link);
    }
  }

  return {
    domains: [...domainIds].sort(),
    adr: [...adr].sort(),
    policies: [...policyIds].sort(),
  };
}
