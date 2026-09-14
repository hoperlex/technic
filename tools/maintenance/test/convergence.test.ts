/**
 * Остановка цикла: единственное свойство системы, отсутствие которого нельзя заметить глазами.
 *
 * Неверный отбор виден в отчёте, неверный откат — в дереве, а цикл, который не останавливается,
 * выглядит как работающий ровно до той минуты, когда кончается терпение человека. Поэтому каждое
 * условие остановки проверяется отдельно, и отдельно же — что выключенное политикой условие не
 * срабатывает: список причин ведёт человек, и код не вправе добавлять к нему своё.
 *
 * Часы подменены намеренно: прогон обязан быть воспроизводимым, а метка времени, взятая из
 * системных часов, делает невоспроизводимым любое утверждение о состоянии.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  beginPass,
  evaluateStop,
  recordSelection,
  recordVerification,
  startRun,
  type VerificationEntry,
} from '../core/convergence.ts';
import type { RunState } from '../core/run-state.ts';
import type { Decision, Selection, Verdict } from '../core/selector.ts';
import type { ConvergenceBudget } from '../core/types.ts';
import { findingFixture } from './fixtures.ts';

const clock = () => new Date('2026-09-14T10:00:00.000Z');

/** Все условия включены: так стоит в политике проекта сегодня. */
const ALL_CONDITIONS: readonly string[] = [
  'maxPassesReached',
  'noSelectedFindings',
  'improvementBelowThreshold',
  'behaviorRegressionDetected',
  'changeBudgetExceeded',
  'newSevereIssuesExceedResolved',
  'verificationFailedRepeatedly',
  'manualDecisionRequired',
];

/** Три РАЗНЫХ прохода, как в `maintenance.yaml`: последний — стабилизация, и это важно тестам. */
function budgetFixture(overrides: Partial<ConvergenceBudget> = {}): ConvergenceBudget {
  return {
    maxPasses: 3,
    maxFindingsPerPass: 5,
    maxFilesChanged: 25,
    maxChangedLines: 1500,
    minAutofixConfidence: 0.88,
    allowedRisk: 'low',
    behaviorChanges: 'forbidden',
    passes: [
      { id: 'structural', goal: 'структура', forbids: [] },
      { id: 'maintainability', goal: 'уборка', forbids: [] },
      { id: 'stabilization', goal: 'хвосты', forbids: [] },
    ],
    ...overrides,
  };
}

const budget = budgetFixture();

/** Отбор с заданными вердиктами: логика отбора проверена своим тестом, здесь важны только счётчики. */
function selectionOf(decisions: readonly Decision[]): Selection {
  const verdicts: Verdict[] = decisions.map((decision, index) => ({
    finding: findingFixture({ id: `F${index}`, files: [`apps/api/src/f${index}.ts`] }),
    decision,
    reason: 'вердикт для теста',
  }));
  const selected = verdicts.filter((verdict) => verdict.decision === 'selected');
  return {
    verdicts,
    selected: selected.map((verdict) => verdict.finding),
    files: selected.flatMap((verdict) => [...verdict.finding.files]),
    estimatedLines: selected.length * 10,
  };
}

function accepted(overrides: Partial<VerificationEntry> = {}): VerificationEntry {
  return {
    outcome: 'accept',
    reason: 'ворота зелёные',
    changedFiles: ['apps/api/src/f0.ts'],
    changedLines: 12,
    newSevere: 0,
    resolvedSevere: 1,
    ...overrides,
  };
}

/** Проход целиком: открыт, отбор записан, проверка записана. */
function wholePass(
  state: RunState,
  passId: string,
  entry: VerificationEntry,
  decisions: readonly Decision[] = ['selected'],
): RunState {
  const opened = beginPass(state, passId, clock);
  const chosen = recordSelection(opened, selectionOf(decisions));
  return recordVerification(chosen, entry, clock);
}

function fresh(): RunState {
  return startRun(budget.passes, clock);
}

test('прогон начинается с ожидания ревьюера и пустых итогов', () => {
  const state = fresh();
  assert.equal(state.step, 'awaiting-review');
  assert.equal(state.passIndex, 0);
  assert.equal(state.passes.length, 0);
  assert.equal(state.stop, null);
  assert.deepEqual(state.totals, { files: 0, lines: 0, rollbacks: 0, accepted: 0 });
  assert.equal(state.runId, 'run-20260914T100000Z');
});

test('прогон без описанных проходов не начинается', () => {
  assert.throws(() => startRun([], clock), /ни одного прохода/);
});

test('запись итогов до открытия прохода — ошибка порядка, а не пустой случай', () => {
  assert.throws(() => recordSelection(fresh(), selectionOf(['selected'])), /открытого прохода нет/);
});

test('исходное состояние не меняется ни одной из функций цикла', () => {
  const state = beginPass(fresh(), 'structural', clock);
  const before = structuredClone(state);

  const chosen = recordSelection(state, selectionOf(['selected', 'manual']));
  const verified = recordVerification(chosen, accepted(), clock);
  advance(verified, budget, ALL_CONDITIONS);

  assert.deepEqual(state, before);
  assert.notEqual(chosen.passes[0], state.passes[0]);
});

test('отбор записывает счётчики вердиктов и находки, отданные человеку', () => {
  const state = recordSelection(
    beginPass(fresh(), 'structural', clock),
    selectionOf(['selected', 'deferred', 'manual', 'manual', 'rejected']),
  );
  assert.deepEqual(state.passes[0]?.counts, {
    selected: 1,
    deferred: 1,
    manual: 2,
    rejected: 1,
  });
  assert.equal(state.passes[0]?.manualFindings.length, 2);
  assert.equal(state.step, 'awaiting-fix');
});

test('пустой отбор не переводит прогон в ожидание правки', () => {
  const state = recordSelection(
    beginPass(fresh(), 'structural', clock),
    selectionOf(['deferred', 'manual']),
  );
  assert.equal(state.step, 'awaiting-review');
});

test('принятая партия идёт в итоги изменений, откаченная — только в счётчик откатов', () => {
  const first = wholePass(fresh(), 'structural', accepted({ changedFiles: ['a.ts'] }));
  const second = wholePass(
    first,
    'maintainability',
    accepted({ outcome: 'rollback', changedFiles: ['b.ts', 'c.ts'], changedLines: 80 }),
  );
  assert.deepEqual(second.totals, { files: 1, lines: 12, rollbacks: 1, accepted: 1 });
});

test('после удачного прохода цикл переходит к следующему', () => {
  const next = advance(wholePass(fresh(), 'structural', accepted()), budget, ALL_CONDITIONS);
  assert.equal(next.step, 'awaiting-review');
  assert.equal(next.passIndex, 1);
  assert.equal(next.stop, null);
});

test('выработанные проходы останавливают прогон', () => {
  let state = fresh();
  for (const pass of budget.passes)
    state = advance(wholePass(state, pass.id, accepted()), budget, ALL_CONDITIONS);
  assert.equal(state.step, 'finished');
  assert.equal(state.stop?.reason, 'maxPassesReached');
});

test('проход без выбранных находок останавливает прогон', () => {
  const state = recordSelection(
    beginPass(fresh(), 'structural', clock),
    selectionOf(['deferred', 'rejected']),
  );
  assert.equal(evaluateStop(state, budget, ALL_CONDITIONS)?.reason, 'noSelectedFindings');
});

test('исход «нужен человек» останавливает прогон прежде любой другой причины', () => {
  const state = wholePass(
    fresh(),
    'structural',
    accepted({ outcome: 'manual-review', reason: 'правка вышла за партию', newSevere: 9 }),
  );
  const stop = evaluateStop(state, budget, ALL_CONDITIONS);
  assert.equal(stop?.reason, 'manualDecisionRequired');
  assert.match(stop?.detail ?? '', /вышла за партию/);
});

test('откат на проходе стабилизации — регрессия поведения', () => {
  const state = wholePass(fresh(), 'stabilization', accepted({ outcome: 'rollback' }));
  assert.equal(evaluateStop(state, budget, ALL_CONDITIONS)?.reason, 'behaviorRegressionDetected');
});

test('откат на обычном проходе прогон не останавливает: следующий проход про другое', () => {
  // Решение заказчика 14.09.2026: проходы разные по смыслу, и неудача структурной правки ничего
  // не говорит про чистку мёртвого кода. Повторять провалившийся проход при этом не будут — его
  // находки уходят человеку, — но дать двум другим начаться обязаны.
  const state = wholePass(fresh(), 'structural', accepted({ outcome: 'rollback' }));
  assert.equal(evaluateStop(state, budget, ALL_CONDITIONS), null);
});

test('два отката за прогон останавливают его', () => {
  const first = wholePass(fresh(), 'structural', accepted({ outcome: 'rollback' }));
  const second = wholePass(first, 'maintainability', accepted({ outcome: 'rollback' }));
  assert.equal(
    evaluateStop(second, budget, ALL_CONDITIONS)?.reason,
    'verificationFailedRepeatedly',
  );
});

test('превышение бюджета изменений останавливает прогон', () => {
  const files = Array.from({ length: 26 }, (_, index) => `apps/api/src/f${index}.ts`);
  const state = wholePass(fresh(), 'structural', accepted({ changedFiles: files }));
  const stop = evaluateStop(state, budget, ALL_CONDITIONS);
  assert.equal(stop?.reason, 'changeBudgetExceeded');
  assert.match(stop?.detail ?? '', /файлов 26/);
});

test('превышение бюджета строк считается наравне с файлами', () => {
  const state = wholePass(fresh(), 'structural', accepted({ changedLines: 1501 }));
  const stop = evaluateStop(state, budget, ALL_CONDITIONS);
  assert.equal(stop?.reason, 'changeBudgetExceeded');
  assert.match(stop?.detail ?? '', /строк 1501/);
});

test('созданных серьёзных проблем больше закрытых — прогон останавливается', () => {
  const state = wholePass(fresh(), 'structural', accepted({ newSevere: 2, resolvedSevere: 1 }));
  assert.equal(
    evaluateStop(state, budget, ALL_CONDITIONS)?.reason,
    'newSevereIssuesExceedResolved',
  );
});

test('откат не записывает закрытых проблем: закрывать было нечего', () => {
  const state = wholePass(
    fresh(),
    'structural',
    accepted({ outcome: 'rollback', resolvedSevere: 3, newSevere: 1 }),
  );
  assert.equal(state.passes.at(-1)?.resolvedSevere, 0);
  // Находки, о которых исполнитель сообщил, откатом не отменяются: они знание, а не правка.
  assert.equal(state.passes.at(-1)?.newSevere, 1);
});

test('проход без правок принятой партией не считается', () => {
  const state = wholePass(fresh(), 'structural', accepted({ changedFiles: [], changedLines: 0 }));
  assert.equal(state.passes.at(-1)?.verification, 'accept');
  // Чинить было нечего — это успех прохода, но отчитываться о «принятой партии» не о чем.
  assert.equal(state.totals.accepted, 0);
});

test('два прохода без единой принятой партии останавливают прогон', () => {
  /*
   * «Нет улучшения» — свойство прогона, а не прохода. Первый откат прогон не закрывает (проверено
   * выше), второй бесплодный проход — закрывает: система дважды подряд не смогла дать правку,
   * которую можно принять, и продолжать значит тратить время человека на третий такой же круг.
   *
   * Причина именно эта, а не «два отката»: здесь один откат и один проход, где отбор ничего не
   * взял, — отказ разный, итог одинаковый.
   */
  const first = wholePass(fresh(), 'structural', accepted({ outcome: 'rollback' }), [
    'selected',
    'deferred',
  ]);
  const second = wholePass(first, 'maintainability', accepted({ outcome: 'manual-review' }), [
    'manual',
  ]);
  const stop = evaluateStop(second, budget, ALL_CONDITIONS);
  assert.equal(stop?.reason, 'manualDecisionRequired');

  const third = wholePass(first, 'maintainability', accepted({ outcome: 'rollback' }), [
    'deferred',
  ]);
  const idle = evaluateStop(third, budget, ALL_CONDITIONS);
  // Два отката поймает более точная причина — она и важнее: это уже не «мало пользы», а
  // систематическая неспособность связки правил и агента.
  assert.equal(idle?.reason, 'verificationFailedRepeatedly');
});

test('бесплодный проход после принятой партии прогон не останавливает', () => {
  const first = wholePass(fresh(), 'structural', accepted({}));
  const second = wholePass(first, 'maintainability', accepted({ outcome: 'manual-review' }), [
    'deferred',
  ]);
  // Принятая партия была — значит прогон полезен, и «нет улучшения» тут неверно. Остановит его
  // другая причина: проверка второго прохода отдала решение человеку.
  assert.equal(evaluateStop(second, budget, ALL_CONDITIONS)?.reason, 'manualDecisionRequired');
});

test('условие, выключенное в политике, не применяется', () => {
  const without = ALL_CONDITIONS.filter((id) => id !== 'maxPassesReached');
  let state = fresh();
  for (const pass of budget.passes) state = wholePass(state, pass.id, accepted());
  assert.equal(evaluateStop(state, budget, ALL_CONDITIONS)?.reason, 'maxPassesReached');
  assert.equal(evaluateStop(state, budget, without), null);

  const next = advance(state, budget, without);
  assert.equal(next.step, 'awaiting-review');
  assert.equal(next.stop, null);
});

test('пустой список условий оставляет прогон без остановки вовсе', () => {
  const state = wholePass(fresh(), 'stabilization', accepted({ outcome: 'manual-review' }));
  assert.equal(evaluateStop(state, budget, []), null);
});

test('завершённый прогон не переписывается повторным ходом', () => {
  let state = fresh();
  for (const pass of budget.passes)
    state = advance(wholePass(state, pass.id, accepted()), budget, ALL_CONDITIONS);
  const again = advance(state, budget, ALL_CONDITIONS);
  assert.equal(again, state);
});

test('остановка запоминается в состоянии, а не только печатается', () => {
  const state = advance(
    wholePass(fresh(), 'structural', accepted({ outcome: 'manual-review' })),
    budget,
    ALL_CONDITIONS,
  );
  assert.equal(state.step, 'finished');
  assert.equal(state.stop?.reason, 'manualDecisionRequired');
  assert.equal(state.passIndex, 0);
});
