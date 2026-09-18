/**
 * Отчёт прогона в markdown: данные состояния — в текст, который читает человек.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ НИ ОДНОГО ОБРАЩЕНИЯ К ФАЙЛАМ. Отчёт — единственное, что человек увидит после
 * прогона, и он обязан быть проверяемым тестом, а не только глазами. Функция, которая сама решает,
 * куда писать, проверяется запуском всей системы; чистая функция «состояние → строка» проверяется
 * сравнением строк. Поэтому пути, каталоги и запись отданы вызывающей стороне (CLI), а сюда
 * приходят только данные.
 *
 * ВТОРОЕ ТРЕБОВАНИЕ — ОБЪЯСНЯТЬ, А НЕ НАЗЫВАТЬ. Строка `maxPassesReached` человеку не говорит
 * ничего: она не объясняет, закончилась работа или её остановили на середине. Поэтому у каждой
 * причины остановки здесь две части — что произошло и что это значит для того, кто читает отчёт.
 */
import type { Decision, Verdict } from '../core/selector.ts';
import type { TrackedFinding } from '../core/finding.ts';
import type { PassRecord, RunState, RunStep, StopReason } from '../core/run-state.ts';
import type { Outcome } from '../verification/verifier.ts';

/**
 * Согласование существительного с числом. Одно на всю систему обслуживания.
 *
 * ЗАЧЕМ ОНА НУЖНА. Русский требует трёх форм — «1 находка», «2 находки», «5 находок», — и текст,
 * склеенный из числа и одной формы, читается машинным переводом: «взято в работу 2 находка».
 * Отчёту, которому не веришь на первой же строке, не верят и дальше, а он здесь единственный
 * носитель итога прогона.
 *
 * ПОЧЕМУ ОНА ЖИВЁТ ЗДЕСЬ, а задание исполнителю (`work-packets/fixer.ts`) её импортирует: это
 * файл, который только превращает данные в русский текст, и правило согласования — ровно его
 * работа. Обратное направление заставило бы отчёт зависеть от сборщика заданий агенту. Двух
 * реализаций тут быть не может: они разойдутся на первом же слове, где кто-то одной из них
 * подправит форму под свой случай.
 *
 * Правило школьное и закрытое: последние две цифры от 11 до 14 всегда дают форму множества
 * («11 находок», а не «11 находка»), в остальных случаях решает последняя цифра.
 */
export function pluralize(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count));
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} ${many}`;
  const last = abs % 10;
  if (last === 1) return `${count} ${one}`;
  if (last >= 2 && last <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

const FINDINGS = ['находка', 'находки', 'находок'] as const;

/** Решения отбора словами человека: в таблице отчёта коды `selected`/`deferred` не читаются. */
const DECISION_TITLE: Record<Decision, string> = {
  selected: 'в работу',
  deferred: 'отложено',
  manual: 'человеку',
  rejected: 'отклонено',
};

/** Порядок колонок отбора задан явно: он отвечает ходу мысли «взяли — отдали — отложили — отвергли». */
const DECISION_ORDER: readonly Decision[] = ['selected', 'manual', 'deferred', 'rejected'];

const OUTCOME_TITLE: Record<Outcome, string> = {
  accept: 'принято',
  rollback: 'откачено',
  'manual-review': 'нужен человек',
};

const STEP_TITLE: Record<RunStep, string> = {
  'awaiting-review': 'ждёт ответа ревьюера',
  'awaiting-fix': 'ждёт правки исполнителя',
  finished: 'завершён',
};

/**
 * Причина остановки двумя предложениями: что случилось и что из этого следует.
 *
 * КАЖДАЯ СТРОКА ОПИСЫВАЕТ РОВНО ТО УСЛОВИЕ, КОТОРОЕ СЧИТАЕТ `evaluateStop` в
 * `core/convergence.ts`; условие выписано комментарием над строкой, чтобы расхождение было видно
 * глазами и ловилось тестом. Объяснение, описывающее не то условие, хуже отсутствия объяснения:
 * его читают вместо кода и по нему решают, что делать дальше.
 *
 * ИМЕНА ПРИЧИН МЕНЯТЬ НЕЛЬЗЯ: закрытый список ведёт человек в `maintenance.yaml`, по этим же
 * именам политика включает и выключает условия. Два имени при этом обещают не то, что считает
 * код: `improvementBelowThreshold` не меряет никакого порога, а `behaviorRegressionDetected` не
 * различает, чем вызван откат. Раз имя не исправить, расхождение сказано человеку прямо в тексте,
 * а не спрятано за удобной формулировкой.
 *
 * Второе предложение не украшение. Одна и та же строка состояния означает для человека
 * совершенно разное: «отбор ничего не взял» — это «работа кончилась», а «две партии откачены» —
 * «работа осталась, но система своим правкам больше не верит». Без второй части отчёт не
 * отвечает на единственный вопрос читателя: надо ли что-то делать дальше.
 */
const STOP_TEXT: Record<StopReason, { readonly what: string; readonly means: string }> = {
  // passes.length >= budget.maxPasses, либо passes.length >= budget.passes.length
  maxPassesReached: {
    what: 'проходов сделано столько, сколько их отпущено политикой',
    means:
      'этим условием закрываются два разных случая: описанный план выполнен целиком и прогон ' +
      'упёрся в потолок на середине. Какой именно — видно в строке подробности ниже. ' +
      'Незакрытое осталось в находках; новый прогон начинает человек, а не система.',
  },
  // последний проход: counts.selected === 0
  noSelectedFindings: {
    what: 'отбор последнего прохода не взял в работу ни одной находки',
    means:
      'штатное завершение, но не справка о здоровье кода: условие смотрит только на взятое в ' +
      'работу. Находки могли быть и уйти в отложенные, к человеку или в отклонённые — что с ними ' +
      'стало, видно в таблице вердиктов.',
  },
  // totals.accepted === 0 && passes.length >= 2
  improvementBelowThreshold: {
    what: 'сделано не меньше двух проходов, и ни одной партии с изменениями принять не удалось',
    means:
      'это не сходимость, а неудача: система дважды подряд не смогла дать правку, которую можно ' +
      'принять. Смотреть надо на исходы проходов в таблице выше — откатывали партию, отдавали ' +
      'человеку или отбор просто ничего не брал. Имя этого условия в политике обещает измеренный ' +
      'порог улучшения, но никакого порога код не считает: он считает принятые партии.',
  },
  // последний проход: verification === 'rollback' && он же последний в плане (стабилизация)
  behaviorRegressionDetected: {
    what: 'откачен последний проход плана — тот, что стоит в нём стабилизацией',
    means:
      'сломано лечение, а не отдельная партия: правки двух предыдущих проходов остались в ' +
      'дереве, а проход, который должен был убрать их последствия, проверку не прошёл. Имя ' +
      'условия говорит о регрессии поведения, но код не разбирает, чем вызван откат: красными ' +
      'воротами, линтом или типами. Чем именно — в строке этого прохода выше; дальше смотрит ' +
      'человек.',
  },
  // totals.files > budget.maxFilesChanged, либо totals.lines > budget.maxChangedLines
  changeBudgetExceeded: {
    what: 'прогон вышел за бюджет правки — по числу изменённых файлов или по числу строк',
    means:
      'проверяется это ПОСЛЕ прохода, поэтому вышедшая за предел партия уже в дереве и не ' +
      'откатывается: остановка бережёт следующий проход, а не этот. Сколько вышло и при каком ' +
      'пределе — в строке подробности; остаток работы переносится в следующий прогон целиком.',
  },
  // последний проход: newSevere > resolvedSevere
  newSevereIssuesExceedResolved: {
    what: 'последний проход создал серьёзных проблем больше, чем закрыл',
    means:
      'условие смотрит только на последний проход: одна такая партия останавливает прогон, даже ' +
      'если до неё он работал в плюс. Число созданных приходит из отчёта исполнителя, закрытые ' +
      'считаются по строгости находок самой партии, а не ' +
      'из измерения — поэтому смотреть надо на задание, по которому он работал: похоже, оно ' +
      'ведёт не туда.',
  },
  // totals.rollbacks >= 2 за прогон
  verificationFailedRepeatedly: {
    what: 'за прогон откачено не меньше двух партий',
    means:
      'откаты считаются за весь прогон и не обязаны идти подряд и быть похожими, так что это уже ' +
      'не невезение. Причина либо в задании, которое ведёт исполнителя не туда, либо вне прогона ' +
      '— красное дерево рядом; проверьте ворота на чистом дереве, прежде чем винить правку.',
  },
  // последний проход: verification === 'manual-review'
  manualDecisionRequired: {
    what: 'проверка последней партии кончилась исходом «нужен человек»',
    means:
      'система не приняла и не откатила её: так бывает, когда правка вышла за границы партии и ' +
      'откатывать нечего без потерь, когда ворота падают и без этой правки и когда не выполнился ' +
      'ни один уровень проверки. Партия осталась в дереве как есть, решение за человеком; ' +
      'точная причина — в строке этого прохода выше.',
  },
};

export interface RunReportOptions {
  readonly title?: string;
  /**
   * Пункты для человека, если их считает вызывающий.
   *
   * По умолчанию отчёт берёт из состояния то, что отбор прямо отдал человеку. Но список бывает
   * шире: находки прохода, который откатили и повторять не будут, тоже остаются несделанными, а
   * знает об этом правиле не отчёт, а тот, кто ведёт прогон. Передал список — значит он полный.
   */
  readonly decisionItems?: readonly TrackedFinding[];
}

export function renderRunReport(state: RunState, options: RunReportOptions = {}): string {
  const lines: string[] = [];
  const say = (text = '') => lines.push(text);

  say(`# ${options.title ?? 'Отчёт прогона обслуживания'}`);
  say();
  say(
    `Прогон \`${state.runId}\`, начат ${moment(state.startedAt)}. ` +
      `Сделано ${pluralize(state.passes.length, 'проход', 'прохода', 'проходов')}, ` +
      `ход прогона — ${STEP_TITLE[state.step]}.`,
  );
  say();

  say('## Проходы');
  say();
  if (state.passes.length === 0) {
    // Прогон без проходов — не ошибка: так выглядит остановка на пороге (например, отбор не дал
    // работы в самом первом круге). Отчёт обязан описать и этот случай, а не выдать пустую таблицу.
    say('Ни одного прохода не сделано: до работы с находками дело не дошло.');
  } else {
    lines.push(
      ...renderTable(
        [
          { title: 'Проход', align: 'left' },
          { title: 'В работу', align: 'right' },
          { title: 'Человеку', align: 'right' },
          { title: 'Отложено', align: 'right' },
          { title: 'Отклонено', align: 'right' },
          { title: 'Проверка', align: 'left' },
          { title: 'Файлов', align: 'right' },
          { title: 'Строк', align: 'right' },
        ],
        state.passes.map((pass, index) => [
          `${index + 1}. ${pass.passId}`,
          String(pass.counts.selected),
          String(pass.counts.manual),
          String(pass.counts.deferred),
          String(pass.counts.rejected),
          pass.verification === null ? 'не проверялся' : OUTCOME_TITLE[pass.verification],
          String(pass.changedFiles.length),
          linesCell(pass),
        ]),
      ),
    );

    say();
    say(
      'В колонках «Файлов» и «Строк» — то, что тронула партия этого прохода, откаченные в том ' +
        'числе. Один и тот же файл, поправленный дважды, посчитан в двух строках, поэтому сумма ' +
        'колонки законно больше итога ниже: итог считает разные файлы и не считает откаченное.',
    );
    if (state.passes.some((pass) => pass.changedLines === 0 && pass.changedFiles.length > 0)) {
      // Прочерк вместо нуля — не оформление. Ноль в колонке читается как измеренный ноль, а он
      // бывает и «не измерено»: строки считает контрольная точка партии, и в прогонах, начатых до
      // появления этого счётчика, числа в состоянии нет. Отчёт обязан сказать «не знаю», а не
      // показать правдоподобную цифру.
      say();
      say('Прочерк в колонке «Строк» значит «не измерено»: у этого прохода числа в состоянии нет.');
    }

    /*
     * Пояснения даются только там, где партия не принята: откат, «нужен человек» и непроверенный
     * проход. У принятой причина одна — «проверка пройдена», и повторять её строкой на каждый
     * проход значит топить в шуме те две строки, ради которых отчёт и открывают.
     */
    const explained = state.passes.filter(
      (pass) => pass.verificationReason !== null && pass.verification !== 'accept',
    );
    if (explained.length > 0) {
      say();
      say('Проходы, чью партию не приняли:');
      say();
      for (const pass of explained) {
        const outcome =
          pass.verification === null ? 'не проверялся' : OUTCOME_TITLE[pass.verification];
        say(`- \`${pass.passId}\` — ${outcome}: ${oneLine(pass.verificationReason ?? '')}`);
      }
    }

    const severe = state.passes.reduce((sum, pass) => sum + pass.newSevere, 0);
    const resolved = state.passes.reduce((sum, pass) => sum + pass.resolvedSevere, 0);
    if (severe > 0 || resolved > 0) {
      say();
      say(
        `За прогон исполнители сообщили: серьёзных проблем закрыто — ${resolved}, создано — ` +
          `${severe}. Это сумма по всем проходам, а условие остановки сравнивает такую же пару ` +
          'внутри одного прохода — последнего.',
      );
    }
  }
  say();

  say('## Итоги');
  say();
  say(`- изменено ${pluralize(state.totals.files, 'файл', 'файла', 'файлов')}`);
  /*
   * Про строки отчёт либо называет число, либо честно говорит, что его нет. Число приходит из
   * контрольной точки партии — там лежит содержимое «до», и разница по нему не зависит от
   * честности отчёта исполнителя. Ноль рядом с изменёнными файлами означает не «правка крошечная»,
   * а состояние прогона старше самого счётчика, и так это и печатается.
   */
  say(
    state.totals.lines === 0 && state.totals.files > 0
      ? '- объём правки в строках не измерен: прогон начат до того, как счётчик появился'
      : `- изменено ${pluralize(state.totals.lines, 'строка', 'строки', 'строк')}`,
  );
  say(`- принято ${pluralize(state.totals.accepted, 'партия', 'партии', 'партий')} с изменениями`);
  say(`- откатов — ${state.totals.rollbacks}`);
  say();
  say(
    'Файлы здесь считаются разные за весь прогон: поправленный в двух проходах засчитан один ' +
      'раз, а откаченные партии не засчитаны вовсе — поэтому сумма колонки «Файлов» бывает ' +
      'больше. Партией считается только принятая правка, в которой что-то изменилось: проход, ' +
      'где чинить было нечего, закрывается успехом, но партией не становится.',
  );
  say();

  say('## Почему прогон закончился');
  say();
  if (state.stop === null) {
    say(
      'Прогон не остановлен: он ещё идёт. ' +
        `Сейчас система ${STEP_TITLE[state.step]} — до этого шага итог прогона не подводится.`,
    );
  } else {
    const text = STOP_TEXT[state.stop.reason];
    say(`Цикл закончился, потому что ${text.what}.`);
    say();
    say(
      'Верными разом бывают несколько условий; названо первое по важности — то, ради которого ' +
        'отчёт и открывают.',
    );
    say();
    say(`Что это значит: ${text.means}`);
    const detail = state.stop.detail.trim();
    if (detail.length > 0) {
      say();
      say(`Подробность от системы: ${oneLine(detail)}`);
    }
  }
  say();

  say(renderDecisionItems(options.decisionItems ?? collectManual(state)));
  say();

  return `${lines.join('\n')}\n`;
}

/**
 * Пункты, по которым решает человек.
 *
 * Каждый пункт обязан быть проверяем без запуска системы: файлы, доказательство и предложенное
 * действие приводятся целиком. Отчёт, который говорит «нужно решение» и не показывает, по какому
 * поводу, перекладывает на человека ещё и поиск повода.
 */
export function renderDecisionItems(findings: readonly TrackedFinding[]): string {
  if (findings.length === 0) {
    // Заголовок без содержимого читается как потерянный раздел: человек ищет, что под ним должно
    // было быть. Одна честная строка отвечает на вопрос сразу.
    return 'Решений, требующих человека, нет: отбор ничего не отдал наверх.';
  }

  const lines: string[] = [];
  const say = (text = '') => lines.push(text);

  say('## Решения, требующие человека');
  say();
  say(
    `Здесь ${pluralize(findings.length, 'пункт', 'пункта', 'пунктов')}. ` +
      'Система их не трогала и не тронет: до решения человека они остаются как есть.',
  );
  say();

  for (const finding of findings) {
    say(`### ${finding.id} — ${oneLine(finding.title)}`);
    say();
    say(`- файлы: ${finding.files.map((file) => `\`${file}\``).join(', ') || '—'}`);
    say(`- доказательство: ${oneLine(finding.evidence)}`);
    say(`- предложенное действие: ${oneLine(finding.suggestedAction)}`);
    if (finding.policy !== undefined) say(`- правило: \`${finding.policy}\``);
    if (finding.relatedAdr !== undefined) say(`- решение: ${finding.relatedAdr}`);
    say();
  }

  return lines.join('\n').trimEnd();
}

/**
 * Таблица вердиктов отбора.
 *
 * Причина здесь важнее решения: на вопрос «а почему вот это не взяли» отвечает именно она, и
 * приводится она дословно, как её сформулировал отбор. Пересказ причины своими словами развёл бы
 * отчёт с кодом при первой же правке отбора.
 */
export function renderVerdictTable(verdicts: readonly Verdict[]): string {
  if (verdicts.length === 0) {
    return 'Отбор не рассматривал ни одной находки.';
  }

  const counts = new Map<Decision, number>();
  for (const verdict of verdicts)
    counts.set(verdict.decision, (counts.get(verdict.decision) ?? 0) + 1);
  const summary = DECISION_ORDER.filter((decision) => (counts.get(decision) ?? 0) > 0)
    .map((decision) => `${DECISION_TITLE[decision]} — ${counts.get(decision) ?? 0}`)
    .join(', ');

  const lines: string[] = [];
  lines.push(`Разобрано ${pluralize(verdicts.length, ...FINDINGS)}: ${summary}.`);
  lines.push('');
  lines.push(
    ...renderTable(
      [
        { title: 'Находка', align: 'left' },
        { title: 'Заголовок', align: 'left' },
        { title: 'Решение', align: 'left' },
        { title: 'Причина', align: 'left' },
      ],
      verdicts.map((verdict) => [
        verdict.finding.id,
        oneLine(verdict.finding.title),
        DECISION_TITLE[verdict.decision],
        oneLine(verdict.reason),
      ]),
    ),
  );
  return lines.join('\n');
}

/** Находки на решение со всех проходов, без повторов. */
function collectManual(state: RunState): readonly TrackedFinding[] {
  // Отпечаток, а не идентификатор: одна и та же проблема приходит в каждом проходе с новым
  // номером, и список решений иначе разбухал бы повторами одного и того же пункта.
  const seen = new Set<string>();
  const result: TrackedFinding[] = [];
  for (const pass of state.passes) {
    for (const finding of pass.manualFindings) {
      if (seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      result.push(finding);
    }
  }
  return result;
}

interface Column {
  readonly title: string;
  readonly align: 'left' | 'right';
}

/**
 * Таблица markdown с выравниванием колонок по ширине.
 *
 * Ширина выравнивается не ради красоты в отрендеренном виде — там её не видно, — а ради самого
 * файла: отчёт читают и правят в редакторе, и невыровненная таблица в diff'е меняется целиком при
 * правке одной ячейки.
 */
function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string[] {
  const cells = rows.map((row) => columns.map((_, index) => escapeCell(row[index] ?? '')));
  const widths = columns.map((column, index) =>
    Math.max(3, column.title.length, ...cells.map((row) => (row[index] ?? '').length)),
  );

  const pad = (text: string, index: number): string => {
    const width = widths[index] ?? text.length;
    return columns[index]?.align === 'right' ? text.padStart(width) : text.padEnd(width);
  };

  const lines: string[] = [];
  lines.push(`| ${columns.map((column, index) => pad(column.title, index)).join(' | ')} |`);
  lines.push(
    `| ${columns
      .map((column, index) => {
        const width = widths[index] ?? 3;
        return column.align === 'right' ? `${'-'.repeat(width - 1)}:` : '-'.repeat(width);
      })
      .join(' | ')} |`,
  );
  for (const row of cells) {
    lines.push(`| ${row.map((cell, index) => pad(cell, index)).join(' | ')} |`);
  }
  return lines;
}

/**
 * Число изменённых строк прохода либо прочерк.
 *
 * Ноль при тронутых файлах невозможен по смыслу: если партия правила файлы, строк в ней больше
 * нуля. Значит это не измерение, а его отсутствие, и показывать его цифрой нельзя — по цифрам
 * из отчёта человек судит об объёме правки.
 */
function linesCell(pass: PassRecord): string {
  if (pass.changedLines === 0 && pass.changedFiles.length > 0) return '—';
  return String(pass.changedLines);
}

/** Вертикальная черта внутри ячейки рвёт таблицу markdown, поэтому экранируется. */
function escapeCell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}

/** Многострочный текст в строке списка или ячейке ломает разметку: переносы сводятся в пробелы. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Метка времени без секунд и без часового пояса: в отчёте они только мешают читать. */
function moment(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16).replace('T', ' ') : iso;
}

/** Причины закрытия окна человеческим языком: код причины человеку ничего не говорит. */
const WINDOW_STOP_TITLE: Record<string, string> = {
  timeBudgetSpent: 'вышло время зоны, и продолжать не стали',
  maxBatchesReached: 'сделано столько партий, сколько разрешает политика',
  queueEmpty: 'очередь долга пуста: разбирать было нечего',
  zonesDone: 'все зоны пройдены',
  repeatedRollbacks: 'два отката подряд: окно остановилось само',
  regressionInStabilization: 'откат в зоне стабилизации — признак, что правки идут во вред',
  manualDecisionRequired: 'партия требует решения человека',
};

export interface WindowReportOptions {
  /** Заголовки находок по отпечаткам: сами находки живут в журнале, партия помнит лишь отпечаток. */
  readonly titles?: ReadonlyMap<string, string>;
  /** Что осталось в очереди долга: без этого отчёт не отвечает «а что не разобрано». */
  readonly queue?: readonly { readonly title: string; readonly score: number }[];
}

/**
 * Отчёт тяжёлого окна.
 *
 * ПОЧЕМУ ОН ОТДЕЛЬНЫЙ ОТ ОТЧЁТА ПРОГОНА. У окна другая единица работы: не проход по всему дереву, а
 * зона и малая партия внутри неё. Человек, открывающий этот отчёт, спрашивает не «сошлось ли», а
 * «куда ушли три часа и что из этого осталось в дереве», — и таблица проходов на такой вопрос не
 * отвечает.
 */
export function renderWindowReport(
  state: {
    readonly windowId: string;
    readonly startedAt: string;
    readonly deadline: string;
    readonly zoneIndex: number;
    readonly step: string;
    readonly batches: readonly {
      readonly zone: string;
      readonly startedAt: string;
      readonly findings: readonly string[];
      readonly outcome: Outcome | null;
      readonly reason: string | null;
      readonly changedFiles: readonly string[];
      readonly changedLines: number;
      readonly finishedAt: string | null;
    }[];
    readonly stop: { readonly reason: string; readonly detail: string } | null;
    readonly totals: {
      readonly files: number;
      readonly lines: number;
      readonly accepted: number;
      readonly rollbacks: number;
    };
  },
  options: WindowReportOptions = {},
): string {
  const lines: string[] = [];
  const say = (text = '') => lines.push(text);

  say(`# Отчёт тяжёлого окна`);
  say();
  say(
    `Окно \`${state.windowId}\`, начато ${moment(state.startedAt)}. ` +
      `Зон пройдено: ${state.zoneIndex + 1}. ` +
      `Партий: ${state.batches.length}, принято ${state.totals.accepted}, откачено ${state.totals.rollbacks}.`,
  );
  say();
  if (state.stop !== null) {
    say(`**Почему закрылось:** ${WINDOW_STOP_TITLE[state.stop.reason] ?? state.stop.reason}.`);
    say();
    say(`> ${state.stop.detail}`);
    say();
  }

  say('## Партии');
  say();
  if (state.batches.length === 0) {
    say('Ни одной партии не начато: до правок дело не дошло.');
  } else {
    lines.push(
      ...renderTable(
        [
          { title: '№', align: 'right' },
          { title: 'Зона', align: 'left' },
          { title: 'Исход', align: 'left' },
          { title: 'Файлов', align: 'right' },
          { title: 'Строк', align: 'right' },
          { title: 'Минут', align: 'right' },
        ],
        state.batches.map((batch, index) => [
          String(index + 1),
          batch.zone,
          batch.outcome === null ? 'не закончена' : OUTCOME_TITLE[batch.outcome],
          String(batch.changedFiles.length),
          String(batch.changedLines),
          minutesBetween(batch.startedAt, batch.finishedAt),
        ]),
      ),
    );
    say();

    for (const [index, batch] of state.batches.entries()) {
      say(`### Партия ${index + 1}: ${batch.zone}`);
      say();
      for (const fingerprint of batch.findings) {
        const title = options.titles?.get(fingerprint);
        say(`- ${title ?? `находка \`${fingerprint.slice(0, 8)}\``}`);
      }
      if (batch.findings.length === 0) say('- находки не записаны');
      say();
      if (batch.reason !== null) {
        // Исход уже назван в таблице выше, и повторять его словом перед причиной значит писать
        // «принято — принято: ворота падали и до правки». Здесь нужна причина, а не ярлык.
        say(`**Почему:** ${batch.reason}`);
        say();
      }
      if (batch.changedFiles.length > 0) {
        say('Файлы партии:');
        say();
        for (const file of batch.changedFiles) say(`- \`${file}\``);
        say();
      }
    }
  }

  const queue = options.queue ?? [];
  say('## Что осталось в очереди долга');
  say();
  if (queue.length === 0) {
    say('Очередь пуста.');
  } else {
    for (const item of queue.slice(0, 20)) say(`- ${item.title} (вес ${item.score.toFixed(2)})`);
    if (queue.length > 20) say(`- … и ещё ${queue.length - 20}`);
  }
  say();

  say('## Где подробности');
  say();
  say('- проверка каждой партии: `.maintenance/reports/<окно>-batch-N.json` — базовая линия,');
  say('  нарушения замка, вывод упавших шагов;');
  say('- решения по находкам: `.maintenance/state/ledger.json` и `maintain ledger`;');
  say('- ход окна поминутно: `.maintenance/logs/maintain.log`.');
  say();
  return lines.join('\n');
}

/** Сколько минут заняла партия. Прочерк — не закончена: ноль здесь читался бы как «мгновенно». */
function minutesBetween(from: string, to: string | null): string {
  if (to === null) return '—';
  const minutes = (Date.parse(to) - Date.parse(from)) / 60000;
  return Number.isFinite(minutes) ? String(Math.round(minutes)) : '—';
}
