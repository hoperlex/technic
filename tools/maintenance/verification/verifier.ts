/**
 * Проверка партии и решение о её судьбе.
 *
 * РЕШЕНИЙ РОВНО ТРИ, И ПРИНИМАЕТ ИХ КОД: принять, откатить, отдать человеку. Четвёртого —
 * «попробовать починить ещё раз» — здесь нет намеренно: один проваленный batch не должен
 * становиться началом свободного самоисправления. Новый круг начинается сверху, с анализа, и
 * только по решению оркестратора.
 */
import type { MaintenanceConfig } from '../core/config.ts';
import type { LintFacts, ToolRun } from '../core/facts.ts';
import type { PolicySet } from '../core/types.ts';
import { run, toolRun } from '../analyzers/run.ts';
import { collectLint, dropReport } from '../analyzers/lint.ts';
import { checkBehaviorLock, type BaselineSnapshot, type LockViolation } from './behavior-lock.ts';
import { createIsolatedTree } from '../git/worktree.ts';
import path from 'node:path';

export type Outcome = 'accept' | 'rollback' | 'manual-review';

export interface LevelResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly note: string;
  /**
   * Хвост вывода упавшего шага.
   *
   * Без него отчёт говорит «проверка не прошла» и замолкает — а человеку нужно знать, ЧТО именно
   * не прошло, и особенно в общем дереве: там красным может оказаться чужая работа, и тогда откат
   * верной правки объясняется не ею.
   */
  readonly output?: string;
  /** Следы падений: по ним сравнивают с базой. У зелёного шага пусто. */
  readonly marks?: readonly string[];
}

/**
 * Чем ворота кончились на голой базе.
 *
 * ЗАЧЕМ ПОМНИТЬ. Дерево живёт непрерывной разработкой, и зелёная вершина здесь — редкость: сейчас,
 * например, ворота фронта красны бюджетами файлов и необработанным отказом в чужом тесте. Пока
 * условием приёма была ЗЕЛЕНЬ, цикл не мог принять ничего и никогда: любая партия упиралась в
 * чужую красноту и уходила человеку. Поэтому судим по РАЗНИЦЕ — стало ли хуже, — а для разницы
 * нужна память о том, как было.
 *
 * Память снимается один раз на прогон: база прогона — фиксированный коммит, и второй замер дал бы
 * тот же ответ за те же семь минут.
 */
export interface LevelFacts {
  readonly id: string;
  readonly ok: boolean;
  /** Следы падений: строки вывода, по которым видно, ЧТО упало. Ими и сравнивают. */
  readonly marks: readonly string[];
}

export interface VerificationResult {
  readonly outcome: Outcome;
  readonly reason: string;
  readonly levels: readonly LevelResult[];
  readonly violations: readonly LockViolation[];
  readonly lintAfter: LintFacts;
  readonly typecheckAfter: ToolRun;
  /** Факты базы, если их пришлось снимать: вызывающий обязан их запомнить на весь прогон. */
  readonly baseGates?: readonly LevelFacts[];
}

export interface VerifyOptions {
  readonly config: MaintenanceConfig;
  readonly policies: PolicySet;
  readonly baseline: BaselineSnapshot;
  readonly allowed: readonly string[];
  /** Файлы, которые исполнитель назвал изменёнными: из его отчёта `fix.json`. */
  readonly claimed: readonly string[];
  /**
   * Согласие человека на то, что рядом идёт чужая работа.
   *
   * Без него чужие правки останавливают приём: система не вправе решать за человека, что
   * появившиеся в дереве файлы — не последствие её же партии. С ним — она их просто не трогает,
   * что и так верно: ни приём, ни откат за пределы партии не выходят.
   */
  readonly allowConcurrent: boolean;
  readonly tmpDir: string;
  /**
   * Куда рассказывать о ходе проверки.
   *
   * ПОЧЕМУ ЭТО ЧАСТЬ КОНТРАКТА, А НЕ УДОБСТВО. Проверка — самый долгий шаг цикла: она поднимает
   * отдельное дерево, гоняет линт по всему репозиторию, потом типы, потом ворота. Минуты
   * молчания после строки «агент ответил» неотличимы от зависания, и человек жмёт Ctrl-C —
   * ровно в тот момент, когда правка уже в дереве, а решение по ней ещё не принято. Хуже места
   * для обрыва в цикле нет.
   */
  readonly notify?: (text: string) => void;
  /**
   * Поднимать ли отдельное дерево под проверку. Умолчание берётся из конфига.
   *
   * Нужно ради цеха: там дерево уже отдельное и чужой работы в нём нет, а второе такое же стоило
   * бы минуты на каждую партию и не добавило бы ни грамма изоляции.
   */
  readonly isolate?: boolean;
  /**
   * Что ворота давали на голой базе. `null` — ещё не мерили; замерим и вернём в результате.
   */
  readonly baseGates?: readonly LevelFacts[] | null;
  /** Дополнительные уровни проверки сверх включённых по умолчанию. */
  readonly extraLevels: readonly string[];
}

/** Последние строки вывода: полный лог инструмента нечитаем, а хвост обычно и есть ответ. */
function tailOf(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n').trim();
}

/**
 * Где проверять партию.
 *
 * ОБЩЕЕ ДЕРЕВО ДЛЯ ЭТОГО НЕ ГОДИТСЯ. В нём всегда лежит чужая незавершённая работа, и ворота
 * краснеют по чужой причине: верная правка системы откатывается, а человек видит «проверка не
 * прошла» без объяснения. Проверено трижды на живых прогонах.
 *
 * Изолированное дерево отвечает ровно на тот вопрос, который и нужен: «зелено ли HEAD плюс эта
 * партия». Именно это и уедет в коммит — ни больше, ни меньше.
 *
 * Базовая линия снимается ТАМ ЖЕ, только без файлов партии. Сравнивать изолированный прогон с
 * замером на грязном дереве нельзя: разница тогда означала бы не «стало хуже от правки», а
 * «дерево другое».
 */
function measure(
  root: string,
  config: MaintenanceConfig,
  tmpDir: string,
  suffix: string,
  notify: (text: string) => void = () => {},
) {
  notify('линт');
  const lintReport = path.join(tmpDir, `lint-${suffix}.json`);
  const lint = collectLint({
    root,
    command: config.analysis.lintCommand,
    outFile: lintReport,
    keepMessages: 50,
    pulse: 'линт',
  });
  // Машинный отчёт нужен ровно до этой строки. На этом репозитории он весит восемнадцать
  // мегабайт, и каждая партия оставляла по два таких файла в рабочем каталоге.
  dropReport(lintReport);
  notify(`линт: ${lint.summary}`);
  notify('типы');
  const typecheckRun = run(root, config.analysis.typecheckCommand, { pulse: 'типы' });
  const typecheck = toolRun(
    typecheckRun,
    typecheckRun.code === 0 ? 'типы сходятся' : `типы не сходятся (код ${typecheckRun.code})`,
  );
  notify(typecheck.summary);
  return { lint, typecheck };
}

/**
 * Базовая линия «до правки».
 *
 * Снимается там же, где потом пойдёт проверка: в изолированном дереве — от `HEAD` без файлов
 * партии. Иначе сравнение вышло бы между разными деревьями, и «стало хуже» означало бы «дерево
 * другое». Без изоляции остаётся прежнее поведение: замер прямо в рабочем дереве.
 */
export function measureBaseline(
  config: MaintenanceConfig,
  tmpDir: string,
  notify: (text: string) => void = () => {},
  // Цех сам по себе — отдельное дерево, и на момент замера он ещё не тронут: второе дерево под
  // базу стоило бы минут и не добавило бы изоляции.
  isolate: boolean = config.analysis.isolateVerification === true,
): { lint: LintFacts; typecheck: ToolRun } {
  if (!isolate) {
    return measure(config.root, config, tmpDir, 'before', notify);
  }
  notify('отдельное дерево от HEAD');
  const tree = createIsolatedTree({
    root: config.root,
    home: path.join(tmpDir, 'trees'),
    files: [],
    linkPaths: config.analysis.linkPaths ?? [],
  });
  try {
    return measure(tree.path, config, tmpDir, 'before', notify);
  } finally {
    tree.dispose();
  }
}

/**
 * Виновата ли партия в падении шага.
 *
 * Ответ «нет» означает, что тот же шаг падает на голой базе. Проверяется только при изоляции: без
 * неё базы как отдельного дерева не существует, и отличить чужую красноту от своей нечем — там
 * остаётся прежнее поведение, откат.
 */
/**
 * Слова, по которым в чужом выводе опознаётся падение.
 *
 * Эвристика, и она честно названа эвристикой: система не знает, каким инструментом человек гоняет
 * ворота, и разбирать вывод каждого было бы обещанием, которого не сдержать. Зато «стало столько
 * же красного, сколько было» она отличает от «появилось новое красное» — а для решения о партии
 * нужно именно это.
 */
const FAILURE_WORDS = ['fail', 'падение', 'ошибка', 'error', '\u2717', '\u00d7', 'not ok'];

/** Сколько следов помнить: длинный вывод даёт сотни строк, а разницу видно и по первым. */
const MARKS_LIMIT = 40;

/**
 * Следы падений в выводе шага.
 *
 * Числа из строк вычищаются: длительности, номера попыток и счётчики меняются от прогона к
 * прогону, и без чистки любые два прогона выглядели бы разными.
 */
export function failureMarks(text: string): string[] {
  const marks = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (line === '') continue;
    if (!FAILURE_WORDS.some((word) => line.includes(word))) continue;
    marks.add(line.replace(/\d+/gu, '#').replace(/\s+/gu, ' ').slice(0, 200));
    if (marks.size >= MARKS_LIMIT) break;
  }
  return [...marks];
}

/**
 * Прогон ворот по дереву.
 *
 * Выключенные по умолчанию уровни идут только тем, кто назвал их явно: db-набору нужна своя свежая
 * база, и на общей он даёт ЛОЖНЫЕ падения — а ложное падение откатывает верную правку.
 */
function runLevels(
  where: string,
  config: MaintenanceConfig,
  extraLevels: readonly string[],
  notify: (text: string) => void,
): LevelResult[] {
  const levels: LevelResult[] = [];
  for (const level of config.verification) {
    if (!level.enabledByDefault && !extraLevels.includes(level.id)) continue;
    notify(level.title);
    const result = run(where, level.command, { pulse: level.title });
    const ok = result.code === 0;
    const seconds = Math.round(result.durationMs / 1000);
    notify(`${level.title}: ${ok ? 'зелено' : `код ${result.code}`} за ${seconds} с`);
    const whole = `${result.stdout}\n${result.stderr}`;
    levels.push({
      id: level.id,
      title: level.title,
      ok,
      durationMs: result.durationMs,
      note: ok ? 'зелено' : `код возврата ${result.code}`,
      output: ok ? undefined : tailOf(whole),
      marks: ok ? [] : failureMarks(whole),
    });
  }
  return levels;
}

/**
 * Чья это краснота: партии или базы.
 *
 * Вынесено из решения отдельной функцией не ради длины: здесь единственное место, где система
 * тратит минуты на замер базы, и оно обязано читаться целиком — вместе с условием, при котором
 * замера не будет.
 */
function blame(
  config: MaintenanceConfig,
  options: VerifyOptions,
  failed: readonly LevelResult[],
  notify: (text: string) => void,
): { guilty: LevelResult[]; baseGates: LevelFacts[] } {
  const known = options.baseGates ?? null;
  const missing = failed.filter((level) => !known?.some((fact) => fact.id === level.id));
  const measured = missing.length === 0 ? [] : measureBaseGates(config, options, missing, notify);
  const baseGates = [...(known ?? []), ...measured];
  const guilty = failed.filter((level) =>
    worseThanBase(
      level,
      baseGates.find((fact) => fact.id === level.id),
    ),
  );
  return { guilty, baseGates };
}

/** Появилось ли в партии красное, которого на базе не было. */
function worseThanBase(level: LevelResult, base: LevelFacts | undefined): boolean {
  // Шага нет в памяти базы или он там зелёный — краснота принесена партией.
  if (base === undefined || base.ok) return true;
  const known = new Set(base.marks);
  return (level.marks ?? []).some((mark) => !known.has(mark));
}

/**
 * Снять ворота на голой базе.
 *
 * Дерево собирается от той же вершины, без файлов партии: только так видно, что красное было
 * красным и до нас. Гоняются лишь названные шаги — прогонять зелёные второй раз значит платить
 * временем за известный ответ.
 */
function measureBaseGates(
  config: MaintenanceConfig,
  options: VerifyOptions,
  levels: readonly LevelResult[],
  notify: (text: string) => void,
): LevelFacts[] {
  const base = createIsolatedTree({
    root: config.root,
    home: path.join(options.tmpDir, 'trees'),
    files: [],
    linkPaths: config.analysis.linkPaths ?? [],
  });
  try {
    const facts: LevelFacts[] = [];
    for (const level of levels) {
      const command = config.verification.find((item) => item.id === level.id)?.command;
      /*
       * Промах по id здесь невозможен: список собран из тех же `config.verification`. Но если
       * конфигурация всё-таки разъедется, тихий пропуск опаснее падения: шаг не был бы проверен на
       * базе, а партия получила бы оправдание, которого никто не проверял.
       */
      if (command === undefined) {
        throw new Error(
          `уровень проверки ${level.id} исчез из конфигурации: перезапустить его на базе нечем`,
        );
      }
      notify(`${level.title} на базе`);
      const result = run(base.path, command, { pulse: `${level.title} на базе` });
      const whole = `${result.stdout}\n${result.stderr}`;
      notify(`${level.title} на базе: ${result.code === 0 ? 'зелено' : `код ${result.code}`}`);
      facts.push({
        id: level.id,
        ok: result.code === 0,
        marks: result.code === 0 ? [] : failureMarks(whole),
      });
    }
    return facts;
  } finally {
    base.dispose();
  }
}

export function verifyBatch(options: VerifyOptions): VerificationResult {
  const { config } = options;
  const notify = options.notify ?? (() => {});
  const isolate = options.isolate ?? config.analysis.isolateVerification === true;

  if (isolate) notify('отдельное дерево с правкой');
  const tree = isolate
    ? createIsolatedTree({
        root: config.root,
        home: path.join(options.tmpDir, 'trees'),
        files: options.allowed,
        linkPaths: config.analysis.linkPaths ?? [],
      })
    : null;
  const where = tree?.path ?? config.root;

  /*
   * ВСЁ ТЕЛО ПРОВЕРКИ — ВНУТРИ `try`, А СНОС ДЕРЕВА — В `finally`.
   *
   * Выходов отсюда много: нарушение границ, «стало хуже», красные ворота, приём. Пока снос
   * стоял на каждом выходе отдельно, он держался на том, что никто не добавит четвёртый и не
   * забудет его повторить, — а исключение в середине (упал линт, не запустился инструмент)
   * уносило управление мимо всех трёх вызовов сразу. Цена забытого сноса не абстрактная: в
   * `.git` остаётся запись worktree, на диске — копия репозитория на гигабайты, и следующий
   * прогон добавляет к ним ещё одну. `finally` снимает дерево на любом исходе, включая тот,
   * которого мы не предусмотрели.
   */
  try {
    const measured = measure(where, config, options.tmpDir, 'after', notify);
    const lintAfter = measured.lint;
    const typecheckAfter = measured.typecheck;

    // Замок поведения смотрит на ОСНОВНОЕ дерево: он отвечает не «зелено ли», а «что тронул
    // исполнитель», и ответ на это лежит там, где исполнитель работал.
    const violations = checkBehaviorLock({
      config,
      policies: options.policies,
      baseline: options.baseline,
      allowed: options.allowed,
      claimed: options.claimed,
      lintAfter,
      typecheckAfter,
    });

    /*
     * Замок поведения проверяется ДО прогона тестов, и это не оптимизация времени.
     * Вышедшая за границы партии правка делает любой исход тестов бессмысленным: зелено — значит
     * зелено вместе с тем, чего мы не разрешали и не сможем откатить.
     */
    const outOfControl = violations.filter(
      (violation) =>
        violation.kind === 'out-of-scope' ||
        violation.kind === 'evidence-touched' ||
        violation.kind === 'protected-touched' ||
        (violation.kind === 'concurrent-change' && !options.allowConcurrent),
    );
    if (outOfControl.length > 0) {
      return {
        // Не откат: файлы вне партии система не сохраняла и восстановить их не может, а откат
        // разрешённой половины оставил бы дерево в состоянии, которого не было никогда.
        outcome: 'manual-review',
        reason: outOfControl.map((violation) => violation.detail).join('; '),
        levels: [],
        violations,
        lintAfter,
        typecheckAfter,
      };
    }

    /*
     * «Стало хуже» решается ДО прогона тестов и без него.
     *
     * Если ошибок линта прибавилось или перестали сходиться типы, исход партии уже известен —
     * откат. Гонять ради этого шестиминутные ворота значит платить временем за ответ, который
     * получен минуту назад.
     */
    const worseBefore = violations.filter((violation) => violation.kind === 'worse-than-before');
    if (worseBefore.length > 0) {
      return {
        outcome: 'rollback',
        reason: worseBefore.map((violation) => violation.detail).join('; '),
        levels: [],
        violations,
        lintAfter,
        typecheckAfter,
      };
    }

    const levels = runLevels(where, config, options.extraLevels, notify);

    // Ворота отработали — дерево партии больше не нужно, а замер базы ниже поднимает своё.
    // Снимаем здесь, чтобы два дерева на гигабайты не лежали на диске одновременно; `finally`
    // это не отменяет: повторный `dispose` безопасен и остаётся страховкой на случай броска.
    tree?.dispose();
    const failed = levels.filter((level) => !level.ok);

    if (failed.length > 0) {
      /*
       * ПЕРЕД ОТКАТОМ СПРАШИВАЕМ, ЧЬЯ ЭТО КРАСНОТА.
       *
       * Упавший шаг ещё не значит «правка сломала»: база бывает красной сама по себе — сегодня,
       * например, `HEAD` этого репозитория не собирается, потому что коммит забрал файл портала, а
       * его контракты остались незакоммиченными. Откатить в такой ситуации верную правку значит
       * наказать её за чужую поломку и ничего не починить.
       *
       * Поэтому упавший шаг перезапускается на базе БЕЗ партии — и только он один: гонять ради
       * этого все ворота второй раз стоило бы ещё столько же времени.
       */
      /*
       * СУДИМ ПО РАЗНИЦЕ, А НЕ ПО ЗЕЛЕНИ.
       *
       * Упавший шаг ещё не значит «партия сломала»: в живом дереве база красна сама по себе —
       * сегодня это бюджеты фронта и необработанный отказ в чужом тесте. Требуй мы зелени, цикл не
       * принял бы ничего никогда, а каждая партия стоила бы двух прогонов ворот.
       *
       * Поэтому сравниваются следы падений: те же, что были на базе, — не наша беда; появившиеся —
       * наша, и это откат. Память о базе снимается один раз на прогон и приходит сюда готовой.
       */
      const { guilty, baseGates } = blame(config, options, failed, notify);
      if (guilty.length === 0) {
        return {
          outcome: 'accept',
          reason: `принято: ${failed.map((level) => level.title).join(', ')} падает и без этой правки, нового красного не прибавилось`,
          levels,
          violations,
          lintAfter,
          typecheckAfter,
          baseGates,
        };
      }
      return {
        outcome: 'rollback',
        reason: `проверка не прошла: ${guilty.map((level) => level.title).join(', ')}`,
        levels,
        violations,
        lintAfter,
        typecheckAfter,
        baseGates,
      };
    }
    if (levels.length === 0) {
      // Пустой список уровней — это не «всё хорошо», а «ничего не проверено». Принять партию на
      // этом основании значит объявить доказанным то, что никто не доказывал.
      return {
        outcome: 'manual-review',
        reason: 'ни один уровень проверки не выполнялся: подтверждать сохранение поведения нечем',
        levels,
        violations,
        lintAfter,
        typecheckAfter,
      };
    }

    return {
      outcome: 'accept',
      reason: `проверка пройдена: ${levels.map((level) => level.title).join(', ')}`,
      levels,
      violations,
      lintAfter,
      typecheckAfter,
    };
  } finally {
    tree?.dispose();
  }
}
