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
import type { RunState, RunStep, StopReason } from '../core/run-state.ts';
import type { Outcome } from '../verification/verifier.ts';

/**
 * Согласование существительного с числом.
 *
 * ЗАЧЕМ ОНА НУЖНА. Русский требует трёх форм — «1 находка», «2 находки», «5 находок», — и отчёт,
 * склеенный из числа и одной формы, читается машинным переводом: «взято в работу 2 находка».
 * Отчёт, которому не веришь на первой же строке, не читают дальше, а он здесь единственный
 * носитель итога прогона.
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
 * Второе предложение здесь не украшение. Одна и та же строка состояния означает для человека
 * совершенно разное: `noSelectedFindings` — это «работа кончилась», а `verificationFailedRepeatedly`
 * — «работа осталась, но система ей больше не доверяет». Без второй части отчёт не отвечает на
 * единственный вопрос читателя: надо ли что-то делать дальше.
 */
const STOP_TEXT: Record<StopReason, { readonly what: string; readonly means: string }> = {
  maxPassesReached: {
    what: 'израсходованы все проходы, отведённые прогону политикой',
    means:
      'работа не закончена — она упёрлась в лимит. Незакрытое осталось в находках; ' +
      'новый прогон начинает человек, а не система.',
  },
  noSelectedFindings: {
    what: 'очередной отбор не взял в работу ни одной находки',
    means:
      'это штатное завершение: в разрешённых границах чинить больше нечего. ' +
      'Отклонённое и отложенное никуда не делось — оно в таблице вердиктов.',
  },
  improvementBelowThreshold: {
    what: 'очередной проход дал улучшение меньше порога, ради которого стоит ходить дальше',
    means:
      'цикл сошёлся: следующие проходы стоили бы дороже того, что приносят. ' +
      'Останавливаться здесь — решение политики, а не признак сбоя.',
  },
  behaviorRegressionDetected: {
    what: 'проверка увидела изменение наблюдаемого поведения',
    means:
      'это стоп-сигнал, а не итог: правка тронула то, что обязана была сохранить. ' +
      'Партия откачена, дальше смотрит человек.',
  },
  changeBudgetExceeded: {
    what: 'исчерпан бюджет правки — по файлам или по строкам',
    means:
      'прогон остановлен намеренно: большая правка перестаёт быть обозримой и проверяемой. ' +
      'Остаток работы переносится в следующий прогон целиком.',
  },
  newSevereIssuesExceedResolved: {
    what: 'правки создают больше серьёзных проблем, чем закрывают',
    means:
      'цикл начал работать против себя, и продолжать его бессмысленно. ' +
      'Смотреть надо не на последнюю партию, а на задание: оно ведёт исполнителя не туда.',
  },
  verificationFailedRepeatedly: {
    what: 'проверка падала раз за разом',
    means:
      'система больше не считает свои правки доказанными. ' +
      'Возможная причина вне прогона — красное дерево рядом; проверьте ворота на чистом дереве.',
  },
  manualDecisionRequired: {
    what: 'дальше требуется решение человека',
    means:
      'система дошла до места, где выбор не её: защищённая область, риск для поведения ' +
      'или правило, которое запрещает автоматическую правку. Список решений — ниже.',
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
          String(pass.changedLines),
        ]),
      ),
    );

    /*
     * Пояснения даются только к непринятым проходам. У принятой партии причина — «проверка
     * пройдена», и повторять её строкой на каждый проход значит топить в шуме те две строки,
     * ради которых отчёт и открывают.
     */
    const explained = state.passes.filter(
      (pass) => pass.verificationReason !== null && pass.verification !== 'accept',
    );
    if (explained.length > 0) {
      say();
      say('Почему проход не принят:');
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
        `Серьёзных проблем закрыто — ${resolved}, создано — ${severe}: ` +
          'по этой паре чисел условие остановки и решает, работает ли цикл на пользу.',
      );
    }
  }
  say();

  say('## Итоги');
  say();
  say(
    `- изменено ${pluralize(state.totals.files, 'файл', 'файла', 'файлов')}, ` +
      `${pluralize(state.totals.lines, 'строка', 'строки', 'строк')}`,
  );
  say(`- принято ${pluralize(state.totals.accepted, 'партия', 'партии', 'партий')}`);
  say(`- откатов — ${state.totals.rollbacks}`);
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
