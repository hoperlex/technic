/**
 * Снимок архитектурного состояния: память системы о ФОРМЕ дерева между стабильными точками.
 *
 * ЗАЧЕМ ОН ЕСТЬ. Факты прогона (`context/project-facts.json`) перезаписываются каждым запуском:
 * они отвечают на вопрос «как сейчас». Единственный вопрос эксплуатации они при этом не
 * закрывают — «за пять прогонов стало лучше или хуже». Ответить на него можно только сравнением,
 * а сравнивать не с чем, если прошлое стирается. Снимок хранит из фактов ровно те величины,
 * которые имеет смысл сравнивать между двумя разными деревьями, и хранит их подряд, историей.
 *
 * ЧЕГО СНИМОК НЕ ДЕЛАЕТ. Он не судит о качестве кода и не заводит находок. Его дело —
 * зафиксировать числа и честно сказать, у каких из них есть направление, а у каких нет. Метрика,
 * которой приписали ложное направление, хуже отсутствующей: по ней начнут отчитываться, и система
 * станет поощрять то, чего никто не хотел (см. `better: null` ниже).
 *
 * ПОЧЕМУ ХРАНИЛИЩЕ — ИНТЕРФЕЙС, а запись атомарна: ровно по тем же причинам, что и у журнала
 * находок (`ledger.ts`). История прогонов накапливается месяцами и восстановлению не подлежит:
 * оборванная запись или молча проглоченный испорченный файл стоили бы не прогона, а всей памяти
 * системы о том, куда двигался проект.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFacts } from '../core/facts.ts';

/**
 * Значение метрики, которую инструмент не смог измерить.
 *
 * Отдельное значение, а не ноль, и это главная защита снимка от вранья. Несработавший линт отдаёт
 * `errors: 0, warnings: 0` при `measured: false` — записав такой ноль как число, история показала
 * бы блестящее улучшение ровно в тот прогон, когда проверка сломалась. Поле объявлено как
 * `number` контрактом, поэтому признак «не измерено» живёт в самом значении; сравнение такие
 * метрики пропускает.
 */
export const NOT_MEASURED = -1;

/**
 * Сколько крупнейших файлов кладётся в снимок.
 *
 * Снимок — не каталог файлов: полный список уже лежит в фактах того прогона. Здесь верхушка
 * нужна затем, чтобы человек, увидев сдвиг в числах, сразу знал, куда смотреть. Десяти строк на
 * это хватает, а история из сотни снимков остаётся файлом, который открывается глазами.
 */
const KEEP_LARGEST = 10;

/**
 * Сколько снимков хранится по умолчанию.
 *
 * Снимок снимается не на каждый коммит, а на стабильной точке — выпуск или окно обслуживания, то
 * есть единицы раз в неделю. Полсотни снимков — это примерно полгода такой истории: достаточно,
 * чтобы увидеть тренд, и достаточно мало, чтобы файл оставался читаемым (порядка десятков
 * килобайт). Более старое сравнивать уже не с чем: дерево за полгода переписывается настолько,
 * что «стало лучше» перестаёт означать одно и то же. Безграничная история превратила бы
 * рантайм-файл в свалку, которую никто не открывает, — а значит, в отсутствие истории.
 */
const DEFAULT_LIMIT = 50;

export interface ArchitectureSnapshot {
  readonly takenAt: string;
  readonly head: string;
  readonly version: string | null;
  readonly files: number;
  readonly codeLines: number;
  readonly edges: number;
  readonly cycles: number;
  readonly directionViolations: number;
  readonly lintErrors: number;
  readonly lintWarnings: number;
  readonly warningsByRule: Readonly<Record<string, number>>;
  readonly largestFiles: readonly { readonly file: string; readonly codeLines: number }[];
}

/** Хранилище истории. Интерфейс, а не класс: JSON здесь такой же временный жилец, как в журнале. */
export interface SnapshotStore {
  load(): Promise<readonly ArchitectureSnapshot[]>;
  append(snapshot: ArchitectureSnapshot): Promise<void>;
}

/**
 * История снимков в одном файле JSON.
 *
 * Порядок — хронологический, как пришли: снимки читают лентой и спрашивают «а до этого?».
 * Сортировать их по чему-либо ещё нельзя, иначе обрезка перестанет отрезать старое.
 */
export class JsonSnapshotStore implements SnapshotStore {
  private readonly file: string;
  private readonly limit: number;

  constructor(file: string, limit: number = DEFAULT_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `предел истории снимков должен быть целым числом больше нуля, получено ${limit}`,
      );
    }
    this.file = file;
    this.limit = limit;
  }

  async load(): Promise<readonly ArchitectureSnapshot[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      // Истории ещё нет — это первый прогон, а не сбой. Всё остальное (права, каталог вместо
      // файла) остаётся видимым: принять такую беду за пустую историю значит стереть память.
      if (isMissingFile(error)) return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${this.file}: история снимков не читается как JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${this.file}: история снимков должна быть массивом`);
    }
    return parsed.map((item, index) => parseSnapshot(item, `${this.file}[${index}]`));
  }

  /**
   * Добавление снимка.
   *
   * Сначала читается вся история — и если файл испорчен, чтение падает, а новый снимок НЕ
   * записывается. Это намеренно: запись поверх нечитаемого файла закрыла бы поломку собой, и
   * человек узнал бы о потере истории тогда, когда её уже нечем восстановить.
   */
  async append(snapshot: ArchitectureSnapshot): Promise<void> {
    const history = await this.load();
    // Отрезается СТАРОЕ: ценность истории — в хвосте. Именно последние прогоны отвечают на вопрос
    // «стало лучше или хуже», а снимок годичной давности описывает другой проект.
    const kept = [...history, snapshot].slice(-this.limit);
    await mkdir(path.dirname(this.file), { recursive: true });
    // Запись через временный файл и переименование: прогон могут прервать на середине, а
    // полуфайл здесь означает потерю всей истории, а не одного снимка.
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}

/**
 * Снимок из фактов прогона.
 *
 * Время берётся из фактов, а не у часов: снимок описывает состояние дерева на момент сбора, и
 * задержка между сбором и записью не должна сдвигать историю.
 *
 * Версия приходит аргументом и здесь не читается с диска: файл версии — знание о конкретном
 * репозитории, а ядру обслуживания знать его запрещено (`tooling-core-is-portable`). Не удалось
 * прочитать — `null`, и это честнее выдуманной строки.
 */
export function snapshotOf(
  facts: ProjectFacts,
  extras: { readonly version: string | null },
): ArchitectureSnapshot {
  let cycles = 0;
  let directionViolations = 0;
  for (const violation of facts.dependencies.violations) {
    if (violation.kind === 'cycle') cycles += 1;
    // `unknown-package` не считается ни тем, ни другим: это поломка настройки графа, а не свойство
    // дерева, и сравнивать её между прогонами значило бы мерить точность конфига, а не код.
    if (violation.kind === 'direction') directionViolations += 1;
  }

  const measured = facts.lint.measured;
  return {
    takenAt: facts.collectedAt,
    head: facts.git.head,
    version: extras.version,
    files: facts.metrics.files,
    /*
     * Сборщик фактов сегодня отдаёт только сумму физических строк (`totalLines`); отдельной суммы
     * строк кода по всему дереву у него нет. Берётся то, что есть: для сравнения важна не
     * абсолютная точность, а одинаковая мерка в обоих снимках. Когда в `MetricFacts` появится
     * сумма строк кода, менять надо ровно эту строку. Направления у метрики всё равно нет (см.
     * `METRICS`), так что неточность не влияет на вывод «лучше/хуже».
     */
    codeLines: facts.metrics.totalLines,
    edges: facts.dependencies.edges,
    cycles,
    directionViolations,
    lintErrors: measured ? facts.lint.errors : NOT_MEASURED,
    lintWarnings: measured ? facts.lint.warnings : NOT_MEASURED,
    /*
     * Разбивка приходит из фактов как есть. Сборщик считает по правилам ВСЕ сообщения, включая
     * ошибки, — пересчитывать её по списку `messages` нельзя: он обрезан до `keepMessages`, и
     * пересчёт молча занижал бы числа. Занижение здесь опаснее смешения: ошибки видны отдельной
     * метрикой, а недосчитанные предупреждения выглядели бы как их исчезновение.
     */
    warningsByRule: measured ? { ...facts.lint.byRule } : {},
    largestFiles: facts.metrics.largest
      .slice(0, KEEP_LARGEST)
      .map((item) => ({ file: item.file, codeLines: item.codeLines })),
  };
}

export interface SnapshotDelta {
  readonly from: ArchitectureSnapshot;
  readonly to: ArchitectureSnapshot;
  readonly changes: readonly {
    readonly metric: string;
    readonly before: number;
    readonly after: number;
    /** `true` — стало лучше, `false` — хуже, `null` — у метрики нет направления. */
    readonly better: boolean | null;
  }[];
}

interface MetricSpec {
  readonly metric: string;
  readonly of: (snapshot: ArchitectureSnapshot) => number;
  /** `null` — направление неочевидно, и выдумывать его нельзя. */
  readonly lowerIsBetter: boolean | null;
  /** Метрика приходит от инструмента, который мог не сработать: значение `NOT_MEASURED`. */
  readonly fromTool?: boolean;
}

/**
 * Что считается улучшением, а что — просто изменением.
 *
 * ПРАВИЛО ЧЕСТНОСТИ. Направление проставлено только там, где рост величины означает дефект при
 * ЛЮБОМ размере проекта. Везде, где рост объясняется и ростом продукта, и ухудшением структуры,
 * стоит `null` — «изменилось, оценки нет». Это не осторожность ради осторожности: метрика с
 * выдуманным направлением попадает в отчёт как цель, а целью здесь может быть только то, что
 * человек согласился считать долгом.
 */
const METRICS: readonly MetricSpec[] = [
  /*
   * Файлов стало больше — проект вырос, а не испортился. Дробление большого модуля на несколько
   * файлов тоже увеличивает счётчик, и это ровно то, чего система добивается. Направления нет.
   */
  { metric: 'файлов в дереве', of: (s) => s.files, lowerIsBetter: null },
  /*
   * Строк стало больше — чаще всего появились возможности продукта; меньше — могли убрать
   * мёртвый код, а могли и потерять функциональность. Ни то ни другое не следует из числа.
   */
  { metric: 'строк всего', of: (s) => s.codeLines, lowerIsBetter: null },
  /*
   * Связей между файлами больше — сама по себе это цена роста: сто новых файлов приносят связи,
   * не ухудшая структуры. Ухудшение показала бы плотность связей на файл, а не их число; пока
   * такой метрики нет, направления у этой не будет.
   */
  { metric: 'связей между файлами', of: (s) => s.edges, lowerIsBetter: null },
  /*
   * Цикл зависимостей — дефект при любом размере проекта: он ломает порядок сборки, мешает
   * выносить модули и не объясняется ростом. Здесь направление есть, и оно однозначно.
   */
  { metric: 'циклов зависимостей', of: (s) => s.cycles, lowerIsBetter: true },
  /*
   * Нарушение направления — прямое расхождение с описанной картой модулей. Растущий проект не
   * обязан нарушать собственные правила, поэтому рост здесь всегда ухудшение.
   */
  { metric: 'нарушений направления', of: (s) => s.directionViolations, lowerIsBetter: true },
  /*
   * Ошибки линта обязаны быть нулём: на них стоят ворота. Любой рост — ухудшение.
   */
  { metric: 'ошибок линта', of: (s) => s.lintErrors, lowerIsBetter: true, fromTool: true },
  /*
   * Предупреждений стало больше — «смотря каких»: включили новое правило (код не изменился),
   * выросло дерево, или действительно накопился долг. По общему числу это неразличимо, поэтому
   * направление даёт только разбивка по правилам ниже, где мерка в обоих снимках одна.
   */
  {
    metric: 'предупреждений линта, всего',
    of: (s) => s.lintWarnings,
    lowerIsBetter: null,
    fromTool: true,
  },
  /*
   * Самый большой файл. Направления нет намеренно: размер файла — мягкий сигнал «посмотреть, не
   * смешаны ли ответственности», а объявив его рост ухудшением, система начала бы поощрять
   * дробление ради числа — то самое, что правилами прямо запрещено.
   */
  {
    metric: 'строк в самом большом файле',
    of: (s) => s.largestFiles[0]?.codeLines ?? 0,
    lowerIsBetter: null,
  },
];

/**
 * Разница между двумя снимками.
 *
 * В `changes` попадает только то, что ИЗМЕНИЛОСЬ: совпавшие числа читатель не разглядывает, а
 * таблица из двадцати строк «без изменений» прячет три важные. Пустой список изменений — это
 * полноценный ответ «дерево по этим метрикам осталось прежним», и `renderDelta` так его и
 * печатает.
 */
export function diffSnapshots(
  before: ArchitectureSnapshot,
  after: ArchitectureSnapshot,
): SnapshotDelta {
  const changes: { metric: string; before: number; after: number; better: boolean | null }[] = [];

  for (const spec of METRICS) {
    const was = spec.of(before);
    const now = spec.of(after);
    // Метрика, которую инструмент не измерил хотя бы в одном снимке, из сравнения выпадает
    // целиком: «не измерено» не означает ни нуля, ни улучшения.
    if (spec.fromTool && (was === NOT_MEASURED || now === NOT_MEASURED)) continue;
    if (was === now) continue;
    changes.push({ metric: spec.metric, before: was, after: now, better: verdict(spec, was, now) });
  }

  changes.push(...ruleChanges(before, after));
  return { from: before, to: after, changes };
}

function verdict(spec: MetricSpec, was: number, now: number): boolean | null {
  if (spec.lowerIsBetter === null) return null;
  return spec.lowerIsBetter ? now < was : now > was;
}

/**
 * Изменения по отдельным правилам линта.
 *
 * ЗДЕСЬ НАПРАВЛЕНИЕ ПОЯВЛЯЕТСЯ — но только у правил, которые действовали В ОБОИХ снимках: мерка
 * одна, значит рост числа замечаний по правилу и есть накопленный долг по нему.
 *
 * Правило, которого раньше не было, оценке не подлежит: его замечания появились от включения
 * правила, а не от порчи кода. Исчезнувшее правило — тоже: по числу не отличить «починили всё» от
 * «правило выключили», а выключенное правило, записанное в улучшения, — худший вид отчёта.
 */
function ruleChanges(
  before: ArchitectureSnapshot,
  after: ArchitectureSnapshot,
): readonly { metric: string; before: number; after: number; better: boolean | null }[] {
  // Линт не измерялся — сравнивать нечего: пустая разбивка означала бы «все замечания исчезли».
  if (before.lintWarnings === NOT_MEASURED || after.lintWarnings === NOT_MEASURED) return [];

  const rules = [
    ...new Set([...Object.keys(before.warningsByRule), ...Object.keys(after.warningsByRule)]),
  ].sort();
  const changes: { metric: string; before: number; after: number; better: boolean | null }[] = [];
  for (const rule of rules) {
    const was = before.warningsByRule[rule] ?? 0;
    const now = after.warningsByRule[rule] ?? 0;
    if (was === now) continue;
    const known = rule in before.warningsByRule && rule in after.warningsByRule;
    const note = known
      ? ''
      : rule in after.warningsByRule
        ? ' (правило новое)'
        : ' (правило исчезло)';
    changes.push({
      metric: `замечаний по правилу ${rule}${note}`,
      before: was,
      after: now,
      better: known ? now < was : null,
    });
  }
  return changes;
}

const VERDICT_TITLE = { better: 'лучше', worse: 'хуже', unknown: 'без оценки' } as const;

/**
 * Дельта человеческим текстом.
 *
 * Чистая функция «данные → строка», как и отчёт прогона: куда её писать, решает вызывающий.
 *
 * Оценённые метрики идут первыми, неоценённые — после: читателю нужен ответ на вопрос «стало
 * лучше или хуже», а числа без направления он смотрит вторым заходом. Строка итога называет
 * количество неоценённых прямо — иначе «1 лучше, 0 хуже» читается как полный успех, хотя половина
 * изменений просто не поддаётся оценке.
 */
export function renderDelta(delta: SnapshotDelta): string {
  const lines: string[] = ['## Дельта архитектуры', ''];
  lines.push(`- было: ${describe(delta.from)}`);
  lines.push(`- стало: ${describe(delta.to)}`);
  lines.push('');

  if (delta.changes.length === 0) {
    // Отдельный текст, а не пустая таблица: «ничего не изменилось» — это ответ, и он должен
    // читаться как ответ, а не как несработавший отчёт.
    lines.push('Изменений нет: сравниваемые метрики совпали.');
    return `${lines.join('\n')}\n`;
  }

  const judged = delta.changes.filter((change) => change.better !== null);
  const rest = delta.changes.filter((change) => change.better === null);
  const better = judged.filter((change) => change.better === true).length;
  const worse = judged.length - better;
  lines.push(`Итог: лучше — ${better}, хуже — ${worse}, без оценки — ${rest.length}.`);
  lines.push('');
  lines.push('| Метрика | Было | Стало | Изменение | Оценка |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const change of [...judged, ...rest]) {
    const shift = change.after - change.before;
    const title =
      change.better === null
        ? VERDICT_TITLE.unknown
        : change.better
          ? VERDICT_TITLE.better
          : VERDICT_TITLE.worse;
    lines.push(
      `| ${change.metric} | ${change.before} | ${change.after} | ${shift > 0 ? `+${shift}` : shift} | ${title} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function describe(snapshot: ArchitectureSnapshot): string {
  const version = snapshot.version === null ? 'версия неизвестна' : `версия ${snapshot.version}`;
  return `${snapshot.takenAt}, вершина ${snapshot.head.slice(0, 12)}, ${version}`;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Разбор одного снимка из файла.
 *
 * Проверяется каждое поле: файл лежит в рантайме, его переживают обрывы прогонов и чужие руки, а
 * снимок с пропущенным числом дал бы `undefined` в вычитании и `NaN` в отчёте — то есть тихую
 * бессмыслицу вместо ошибки.
 */
function parseSnapshot(value: unknown, where: string): ArchitectureSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${where}: снимок должен быть объектом`);
  }
  const raw: Record<string, unknown> = { ...value };
  return {
    takenAt: requireString(raw.takenAt, `${where}.takenAt`),
    head: requireString(raw.head, `${where}.head`),
    version: typeof raw.version === 'string' ? raw.version : null,
    files: requireNumber(raw.files, `${where}.files`),
    codeLines: requireNumber(raw.codeLines, `${where}.codeLines`),
    edges: requireNumber(raw.edges, `${where}.edges`),
    cycles: requireNumber(raw.cycles, `${where}.cycles`),
    directionViolations: requireNumber(raw.directionViolations, `${where}.directionViolations`),
    lintErrors: requireNumber(raw.lintErrors, `${where}.lintErrors`),
    lintWarnings: requireNumber(raw.lintWarnings, `${where}.lintWarnings`),
    warningsByRule: requireCounts(raw.warningsByRule, `${where}.warningsByRule`),
    largestFiles: requireLargest(raw.largestFiles, `${where}.largestFiles`),
  };
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: ожидалась непустая строка`);
  }
  return value;
}

function requireNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where}: ожидалось число`);
  }
  return value;
}

function requireCounts(value: unknown, where: string): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: ожидался объект «правило → число»`);
  }
  const counts: Record<string, number> = {};
  for (const [rule, count] of Object.entries(value)) {
    counts[rule] = requireNumber(count, `${where}.${rule}`);
  }
  return counts;
}

function requireLargest(
  value: unknown,
  where: string,
): readonly { readonly file: string; readonly codeLines: number }[] {
  if (!Array.isArray(value)) throw new Error(`${where}: ожидался список файлов`);
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${where}[${index}]: ожидался объект`);
    }
    const raw: Record<string, unknown> = { ...item };
    return {
      file: requireString(raw.file, `${where}[${index}].file`),
      codeLines: requireNumber(raw.codeLines, `${where}[${index}].codeLines`),
    };
  });
}
