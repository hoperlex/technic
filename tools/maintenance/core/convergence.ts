/**
 * Автомат цикла сходимости: чем прогон живёт и почему он заканчивается.
 *
 * ЗДЕСЬ НЕТ НИ ОДНОГО ОБРАЩЕНИЯ К ДИСКУ, GIT ИЛИ ПРОЦЕССАМ — и это главное свойство файла, а не
 * его оформление. Правило остановки, которое нельзя проверить, не запуская ворота качества,
 * проверяться не будет: шесть минут прогона за один вопрос «а остановились бы мы здесь» никто не
 * заплатит. Отделённая от ввода-вывода логика проверяется тестом за миллисекунды, и потому
 * проверяется вся.
 *
 * ВСЕ ФУНКЦИИ ЧИСТЫЕ: принимают состояние, возвращают новое. Прогон переживает выход из процесса
 * (между проходами система ждёт человека), состояние ездит через файл — и правка на месте в такой
 * схеме означает, что записанное на диск и то, что в памяти, разошлись молча. Возврат нового
 * значения делает расхождение невозможным: на диск всегда ложится то, что вернула функция.
 *
 * Время приходит параметром `now` по той же причине: иначе ни один тест не может утверждать
 * ничего о метках времени, а прогон нельзя воспроизвести.
 */
import type { Decision, Selection } from './selector.ts';
import type { PassRecord, RunState, RunTotals, StopReason } from './run-state.ts';
import type { ConvergenceBudget, ConvergencePass } from './types.ts';
import type { Outcome } from '../verification/verifier.ts';

/** Часы прогона. Отдельный тип нужен только затем, чтобы не писать сигнатуру пять раз. */
export type Clock = () => Date;

const defaultClock: Clock = () => new Date();

/** Счётчики вердиктов «с нуля»: отсутствие ключа и ноль — разные вещи в отчёте. */
const EMPTY_COUNTS: Readonly<Record<Decision, number>> = {
  selected: 0,
  deferred: 0,
  manual: 0,
  rejected: 0,
};

/** Исход проверки партии вместе с тем, что она изменила. Из него растут три условия остановки. */
export interface VerificationEntry {
  readonly outcome: Outcome;
  readonly reason: string;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
  /** Сколько серьёзных проблем правка создала и сколько закрыла: счёт ведёт проверка, не модель. */
  readonly newSevere: number;
  readonly resolvedSevere: number;
}

/**
 * Начало прогона.
 *
 * Список проходов принимается, хотя в состоянии его нет: состояние помнит СДЕЛАННОЕ, а
 * задуманное живёт в политике и может быть перечитано. Нужен он здесь ради одной проверки —
 * прогон без единого описанного прохода не «завершится сразу», он бессмыслен, и сказать об этом
 * надо на первой команде, а не в отчёте о нулевой работе.
 */
export function startRun(passes: readonly ConvergencePass[], now: Clock = defaultClock): RunState {
  if (passes.length === 0) {
    throw new Error('в политике не описано ни одного прохода: сходиться нечем');
  }
  const startedAt = now().toISOString();
  return {
    runId: runIdOf(startedAt),
    startedAt,
    passIndex: 0,
    step: 'awaiting-review',
    passes: [],
    stop: null,
    totals: { files: 0, lines: 0, rollbacks: 0, accepted: 0 },
  };
}

/**
 * Открыть запись прохода.
 *
 * Шаг остаётся «ждём ревьюера»: проход начинается ровно тем, что человек уносит задание агенту.
 * Записать проход заранее нужно затем, чтобы прерванный на середине прогон было видно: запись без
 * `finishedAt` — это «ушли и не вернулись», и отличить её от «прохода не было» иначе нечем.
 */
export function beginPass(state: RunState, passId: string, now: Clock = defaultClock): RunState {
  const record: PassRecord = {
    passId,
    startedAt: now().toISOString(),
    counts: { ...EMPTY_COUNTS },
    manualFindings: [],
    selectedFindings: [],
    verification: null,
    verificationReason: null,
    changedFiles: [],
    changedLines: 0,
    newSevere: 0,
    resolvedSevere: 0,
    finishedAt: null,
  };
  return { ...state, step: 'awaiting-review', passes: [...state.passes, record] };
}

/**
 * Записать итог отбора.
 *
 * Из всей находки в состояние переносятся только счётчики и то, что отдано человеку. Остальное —
 * в отчёте отбора: дублировать сюда список выбранных находок значит завести второй ответ на
 * вопрос «что чинили», который разойдётся с первым при первой же ручной правке файла состояния.
 *
 * Шаг переключается на исполнителя только если ему есть что делать. Иначе прогон «ждал бы правку»,
 * которую никто не заказывал, и человек искал бы несуществующее задание.
 */
export function recordSelection(state: RunState, selection: Selection): RunState {
  const counts: Record<Decision, number> = { ...EMPTY_COUNTS };
  for (const verdict of selection.verdicts) counts[verdict.decision] += 1;

  const manualFindings = selection.verdicts
    .filter((verdict) => verdict.decision === 'manual')
    .map((verdict) => verdict.finding);

  const selectedFindings = [...selection.selected];

  return {
    ...patchLastPass(state, (record) => ({ ...record, counts, manualFindings, selectedFindings })),
    step: selection.selected.length > 0 ? 'awaiting-fix' : state.step,
  };
}

/**
 * Записать исход проверки и закрыть проход.
 *
 * ОТКАЧЕННОЕ В ИТОГИ ИЗМЕНЕНИЙ НЕ ИДЁТ, и это не мелочь учёта. Откат возвращает файлы партии байт
 * в байт — в дереве после него не изменено ничего, и засчитывать такие строки в бюджет значит
 * исчерпывать его работой, которой не осталось следа. Откат наказывается своим счётчиком
 * (`rollbacks`), а не чужим.
 *
 * Исход «нужен человек» в бюджет, наоборот, идёт: там система не трогает ничего, и правка
 * исполнителя остаётся в дереве. Бюджет должен считать то, что в дереве, а не то, что мы одобрили.
 */
export function recordVerification(
  state: RunState,
  entry: VerificationEntry,
  now: Clock = defaultClock,
): RunState {
  const counted = entry.outcome !== 'rollback';
  /*
   * Откат не закрывает ничего: правки в дереве не осталось, и «серьёзных проблем закрыто» по
   * откаченной партии — неправда, из-за которой условие «создаёт больше, чем чинит» читало бы
   * пользу там, где её нет.
   */
  const resolvedSevere = entry.outcome === 'rollback' ? 0 : entry.resolvedSevere;
  /*
   * Файлы считаются РАЗНЫМИ, а не суммой по проходам. Лимит «не больше 25 файлов за прогон»
   * говорит про объём затронутого кода, а не про число правок: второй проход, дочинивший тот же
   * файл, не делает дерево шире на файл. Суммирование исчерпывало бы бюджет на одном и том же
   * месте — и останавливало прогон тем раньше, чем аккуратнее он работает.
   */
  const touched = new Set<string>();
  for (const record of state.passes.slice(0, -1)) {
    if (record.verification === 'rollback') continue;
    for (const file of record.changedFiles) touched.add(file);
  }
  if (counted) for (const file of entry.changedFiles) touched.add(file);

  const totals: RunTotals = {
    files: touched.size,
    lines: state.totals.lines + (counted ? entry.changedLines : 0),
    rollbacks: state.totals.rollbacks + (entry.outcome === 'rollback' ? 1 : 0),
    /*
     * Принятой считается партия С ИЗМЕНЕНИЯМИ. Проход, где отбор ничего не взял, закрывается
     * успехом — чинить было нечего, — но объявлять его «принятой партией» значит отчитываться о
     * работе, которой не было.
     */
    accepted:
      state.totals.accepted + (entry.outcome === 'accept' && entry.changedFiles.length > 0 ? 1 : 0),
  };

  const withPass = patchLastPass(state, (record) => ({
    ...record,
    verification: entry.outcome,
    verificationReason: entry.reason,
    changedFiles: [...entry.changedFiles],
    changedLines: entry.changedLines,
    newSevere: entry.newSevere,
    resolvedSevere,
    finishedAt: now().toISOString(),
  }));

  return { ...withPass, totals };
}

/**
 * Причина остановки после завершённого прохода, либо `null` — «можно идти дальше».
 *
 * ПОРЯДОК ПРОВЕРКИ ЗДЕСЬ ЗНАЧИТ БОЛЬШЕ, ЧЕМ САМИ УСЛОВИЯ. Верными разом бывают несколько, а
 * человеку показывается одна — та, ради которой он открывает отчёт. Поэтому порядок такой:
 *
 * 1. `manualDecisionRequired` — система дошла до места, где решать не вправе. Любая другая
 *    причина поверх этой означала бы, что мы объяснили остановку бухгалтерией, спрятав вопрос,
 *    заданный человеку;
 * 2. `behaviorRegressionDetected` — откат на стабилизации: последний проход существует ровно
 *    затем, чтобы убрать хвосты, и если ломается он, сломано лечение, а не только эта партия;
 * 3. `newSevereIssuesExceedResolved` — прогон создаёт больше, чем чинит. Это отрицательная
 *    полезность, и назвать её «кончился бюджет» значит скрыть, что бюджет тут ни при чём;
 * 4. `verificationFailedRepeatedly` — два отката за прогон: не невезение, а систематическая
 *    неспособность этой связки правил и агента давать принимаемую правку;
 * 5. `changeBudgetExceeded` — штатный предел, но всё-таки авария объёма: дальше идти нельзя;
 * 6. `noSelectedFindings` — чинить нечего. Это лучший исход цикла, и он сообщается прежде, чем
 *    «кончились проходы»: сойтись за два прохода и упереться в потолок — разные новости;
 * 7. `improvementBelowThreshold` — находки были, принятого нет: круг вхолостую;
 * 8. `maxPassesReached` — последним намеренно: это не событие, а отсутствие событий. Если ни одна
 *    содержательная причина не сработала, прогон просто выработал отведённые проходы.
 *
 * `allowed` — включённые политикой условия. Выключенное не применяется вовсе: закрытый список
 * причин ведёт человек в `maintenance.yaml`, и код не вправе останавливать прогон по причине,
 * которую человек из списка убрал. Цена известна: выключив `maxPassesReached`, человек снимает
 * потолок числа проходов — это его решение, и видно оно в одной строке политики.
 */
export function evaluateStop(
  state: RunState,
  budget: ConvergenceBudget,
  allowed: readonly string[],
): { reason: StopReason; detail: string } | null {
  const last = state.passes.at(-1);
  if (last === undefined) return null;

  const seen = totalFindings(last);
  const stabilization = budget.passes.at(-1);
  const candidates: { reason: StopReason; detail: string }[] = [];

  if (last.verification === 'manual-review') {
    candidates.push({
      reason: 'manualDecisionRequired',
      detail: `проход ${last.passId}: решение за человеком — ${last.verificationReason ?? 'причина не записана'}`,
    });
  }

  if (last.verification === 'rollback' && stabilization?.id === last.passId) {
    candidates.push({
      reason: 'behaviorRegressionDetected',
      detail: `проход стабилизации ${last.passId} откачен — ${last.verificationReason ?? 'причина не записана'}`,
    });
  }

  if (last.newSevere > last.resolvedSevere) {
    candidates.push({
      reason: 'newSevereIssuesExceedResolved',
      detail: `проход ${last.passId}: создано серьёзных проблем ${last.newSevere}, закрыто ${last.resolvedSevere}`,
    });
  }

  if (state.totals.rollbacks >= 2) {
    candidates.push({
      reason: 'verificationFailedRepeatedly',
      detail: `откатов за прогон: ${state.totals.rollbacks}`,
    });
  }

  if (state.totals.files > budget.maxFilesChanged) {
    candidates.push({
      reason: 'changeBudgetExceeded',
      detail: `изменено файлов ${state.totals.files} при лимите ${budget.maxFilesChanged}`,
    });
  }
  if (state.totals.lines > budget.maxChangedLines) {
    candidates.push({
      reason: 'changeBudgetExceeded',
      detail: `изменено строк ${state.totals.lines} при лимите ${budget.maxChangedLines}`,
    });
  }

  if (last.counts.selected === 0) {
    candidates.push({
      reason: 'noSelectedFindings',
      detail:
        seen === 0
          ? `проход ${last.passId}: находок нет`
          : `проход ${last.passId}: из ${seen} находок отбор не взял ни одной`,
    });
  }

  /*
   * «Нет улучшения» — свойство ПРОГОНА, а не прохода (решение заказчика 14.09.2026). Проходы
   * разные по смыслу: откат структурной правки ничего не говорит про чистку мёртвого кода, и
   * закрывать прогон после первой неудачи значит не дать двум другим проходам даже начаться.
   *
   * Заодно это чинит мёртвое условие: пока один откат завершал прогон, «два отката подряд»
   * сработать не могло никогда — состояние с двумя откатами было недостижимо.
   */
  if (state.totals.accepted === 0 && state.passes.length >= 2) {
    candidates.push({
      reason: 'improvementBelowThreshold',
      detail: `проходов сделано ${state.passes.length}, принятых партий нет ни одной`,
    });
  }

  if (state.passes.length >= budget.maxPasses) {
    candidates.push({
      reason: 'maxPassesReached',
      detail: `пройдено проходов ${state.passes.length} при лимите ${budget.maxPasses}`,
    });
  } else if (state.passes.length >= budget.passes.length) {
    candidates.push({
      reason: 'maxPassesReached',
      detail: `описанные проходы кончились: их ${budget.passes.length}`,
    });
  }

  for (const candidate of candidates) {
    if (allowed.includes(candidate.reason)) return candidate;
  }
  return null;
}

/**
 * Перейти к следующему проходу либо завершить прогон.
 *
 * Повторный вызов на завершённом прогоне ничего не меняет: команда может быть запущена человеком
 * дважды, и второй запуск обязан застать тот же отчёт, а не переписать причину остановки более
 * поздней.
 */
export function advance(
  state: RunState,
  budget: ConvergenceBudget,
  allowed: readonly string[],
): RunState {
  if (state.step === 'finished') return state;

  const stop = evaluateStop(state, budget, allowed);
  if (stop !== null) return { ...state, step: 'finished', stop };

  return { ...state, passIndex: state.passIndex + 1, step: 'awaiting-review' };
}

/** Сколько находок проход вообще разобрал: сумма всех вердиктов, а не только взятых в работу. */
function totalFindings(record: PassRecord): number {
  return Object.values(record.counts).reduce((sum, value) => sum + value, 0);
}

/**
 * Заменить последнюю запись прохода новой.
 *
 * Открытого прохода нет — это ошибка порядка команд, а не пустой случай: записать отбор некуда, и
 * молча потерять его хуже, чем упасть. Человеку видно, какая команда пропущена.
 */
function patchLastPass(state: RunState, patch: (record: PassRecord) => PassRecord): RunState {
  const last = state.passes.at(-1);
  if (last === undefined) {
    throw new Error('открытого прохода нет: сначала beginPass, потом запись его итогов');
  }
  return { ...state, passes: [...state.passes.slice(0, -1), patch(last)] };
}

/** Имя прогона из его времени: читаемое человеком и повторяемое при тех же часах. */
function runIdOf(startedAt: string): string {
  return `run-${startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}
