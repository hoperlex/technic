/**
 * Остановка тяжёлого окна: свойство, отсутствие которого нельзя заметить глазами.
 *
 * Окно, которое не умеет закончиться, выглядит работающим ровно до той минуты, когда у человека
 * кончается терпение, — и тем опаснее, чем оно длиннее: два часа «ещё немножко улучшим» стоят
 * дороже, чем неверно отобранная находка, которую видно в отчёте сразу. Поэтому здесь отдельно
 * проверяется КАЖДАЯ причина остановки, отдельно — их порядок, и отдельно — что бюджет времени
 * спрашивают ДО начала партии.
 *
 * Часы подменены намеренно: утверждать что-либо о сроках, взяв время из системных часов,
 * невозможно, а окно обязано быть воспроизводимым.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceWindow,
  beginBatch,
  evaluateWindowStop,
  minutesLeft,
  recordBatchOutcome,
  startWindow,
  type BatchOutcomeEntry,
  type WindowState,
} from '../core/deep-window.ts';
import { pickChoice } from '../cli/ask.ts';
import type { DeepMaintenanceBudget } from '../core/types.ts';

const START = new Date('2026-09-15T09:00:00.000Z');

/** Момент через `minutes` минут после открытия окна: тесты говорят о минутах, а не о метках. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * 60_000);
}

/** Три зоны в том же порядке, что в `maintenance.yaml`: последняя — стабилизация, и это важно. */
function policyFixture(overrides: Partial<DeepMaintenanceBudget> = {}): DeepMaintenanceBudget {
  return {
    enabled: true,
    zoneMinutes: 120,
    maxRepairBatches: 6,
    maxFindingsPerBatch: 3,
    maxFilesPerBatch: 8,
    maxChangedLinesPerBatch: 400,
    fullScan: 'allowed',
    zones: [
      { id: 'architecture', looksFor: ['cycles'], mayChange: ['imports'], mustNotChange: [] },
      { id: 'cleanup', looksFor: ['dead-code'], mayChange: ['deletions'], mustNotChange: [] },
      { id: 'stabilization', looksFor: ['regressions'], mayChange: ['defects'], mustNotChange: [] },
    ],
    ...overrides,
  };
}

const policy = policyFixture();

function accepted(overrides: Partial<BatchOutcomeEntry> = {}): BatchOutcomeEntry {
  return {
    outcome: 'accept',
    reason: 'ворота зелёные',
    changedFiles: ['apps/api/src/a.ts'],
    changedLines: 40,
    ...overrides,
  };
}

/** Партия целиком: открыли, отдали исполнителю, записали исход. */
function wholeBatch(
  state: WindowState,
  zone: string,
  entry: BatchOutcomeEntry,
  began = 0,
  ended = 10,
): WindowState {
  const opened = beginBatch(state, zone, ['fp-1', 'fp-2'], at(began));
  return recordBatchOutcome(opened, entry, at(ended));
}

function fresh(from: DeepMaintenanceBudget = policy): WindowState {
  return startWindow(from, START);
}

test('окно открывается со сроком, посчитанным один раз от политики', () => {
  const state = fresh();
  assert.equal(state.windowId, 'window-20260915T090000Z');
  assert.equal(state.startedAt, START.toISOString());
  assert.equal(state.deadline, at(120).toISOString());
  assert.equal(state.zoneIndex, 0);
  assert.equal(state.step, 'awaiting-review');
  assert.deepEqual(state.batches, []);
  assert.equal(state.stop, null);
  assert.deepEqual(state.totals, { files: 0, lines: 0, rollbacks: 0, accepted: 0 });
});

test('рубильник политики автомат не читает: его дело — команда', () => {
  // `enabled` решает, созывается ли окно без подтверждения, и у него есть обход флагом команды.
  // Проверка здесь запретила бы обход, ничего не гарантировав.
  const off = startWindow(policyFixture({ enabled: false }), START);
  assert.equal(off.step, 'awaiting-review');
});

test('окно без зон и окно нулевой длины не открываются', () => {
  assert.throws(() => startWindow(policyFixture({ zones: [] }), START), /ни одной зоны/);
  assert.throws(() => startWindow(policyFixture({ zoneMinutes: 0 }), START), /ни на одну партию/);
});

test('функции окна не трогают переданное состояние', () => {
  const state = fresh();
  const snapshot = structuredClone(state);

  const opened = beginBatch(state, 'architecture', ['fp-1'], at(1));
  assert.deepStrictEqual(state, snapshot);

  const openedSnapshot = structuredClone(opened);
  const closed = recordBatchOutcome(opened, accepted(), at(9));
  assert.deepStrictEqual(opened, openedSnapshot);

  const closedSnapshot = structuredClone(closed);
  advanceWindow(closed, policy, at(10), 5);
  assert.deepStrictEqual(closed, closedSnapshot);
  assert.notEqual(closed, state);
});

test('партия с находками уходит исполнителю, пустая — нет', () => {
  assert.equal(beginBatch(fresh(), 'architecture', ['fp-1'], at(1)).step, 'awaiting-fix');
  assert.equal(beginBatch(fresh(), 'architecture', [], at(1)).step, 'awaiting-review');
});

test('откат не тратит бюджет изменений, но считается откатом', () => {
  const rolled = wholeBatch(
    fresh(),
    'architecture',
    accepted({ outcome: 'rollback', reason: 'ворота красные', changedLines: 380 }),
  );
  assert.deepEqual(rolled.totals, { files: 0, lines: 0, rollbacks: 1, accepted: 0 });
  assert.equal(rolled.batches.at(-1)?.changedLines, 380);
  assert.equal(rolled.batches.at(-1)?.finishedAt, at(10).toISOString());
});

test('откат не отменяет учёт предыдущих партий и не добавляет своего', () => {
  const kept = wholeBatch(fresh(), 'architecture', accepted({ changedLines: 25 }), 0, 10);
  const rolled = wholeBatch(
    kept,
    'cleanup',
    accepted({
      outcome: 'rollback',
      changedFiles: ['apps/api/src/b.ts', 'apps/api/src/c.ts'],
      changedLines: 300,
    }),
    12,
    22,
  );
  // В дереве после отката остались только файлы первой партии: бюджет обязан считать дерево.
  assert.deepEqual(rolled.totals, { files: 1, lines: 25, rollbacks: 1, accepted: 1 });
});

test('итог по файлам считает разные файлы, а не сумму по партиям', () => {
  const first = wholeBatch(fresh(), 'architecture', accepted({ changedLines: 30 }), 0, 10);
  const second = wholeBatch(
    first,
    'cleanup',
    accepted({ changedFiles: ['apps/api/src/a.ts', 'apps/api/src/b.ts'], changedLines: 20 }),
    12,
    22,
  );
  assert.deepEqual(second.totals, { files: 2, lines: 50, rollbacks: 0, accepted: 2 });
});

test('зелёная проверка без изменений принятой партией не считается', () => {
  const empty = wholeBatch(fresh(), 'cleanup', accepted({ changedFiles: [], changedLines: 0 }));
  assert.equal(empty.totals.accepted, 0);
});

test('бюджет времени спрашивают до партии: на остатке меньше оценки окно закрывается', () => {
  const state = fresh();
  // План политики: 120 минут на 6 партий — партия рассчитана на 20 минут.
  assert.equal(evaluateWindowStop(state, policy, at(100), 9), null);
  const stop = evaluateWindowStop(state, policy, at(105), 9);
  assert.equal(stop?.reason, 'timeBudgetSpent');
  assert.match(stop?.detail ?? '', /15 мин.*20 мин/);
});

test('длинная партия поднимает оценку следующей выше плана политики', () => {
  const long = wholeBatch(fresh(), 'architecture', accepted(), 0, 40);
  // Остатка в 35 минут хватило бы по плану (20), но здешние партии идут по 40.
  assert.equal(evaluateWindowStop(long, policy, at(85), 9)?.reason, 'timeBudgetSpent');
  assert.equal(evaluateWindowStop(long, policy, at(80), 9), null);
});

test('незакрытая партия оценку не искажает', () => {
  const opened = beginBatch(fresh(), 'architecture', ['fp-1'], at(0));
  // У прерванной партии нет длительности: судить по ней о следующей не о чем.
  assert.equal(evaluateWindowStop(opened, policy, at(100), 9), null);
});

test('потолок ремонтных партий закрывает окно', () => {
  const small = policyFixture({ maxRepairBatches: 2 });
  const first = wholeBatch(fresh(small), 'architecture', accepted(), 0, 10);
  assert.equal(evaluateWindowStop(first, small, at(11), 9), null);
  const second = wholeBatch(first, 'cleanup', accepted(), 12, 22);
  assert.equal(evaluateWindowStop(second, small, at(23), 9)?.reason, 'maxBatchesReached');
});

test('пустая очередь зоны переводит окно к следующей зоне, а не закрывает его', () => {
  const moved = advanceWindow(fresh(), policy, at(1), 0);
  assert.equal(moved.zoneIndex, 1);
  assert.equal(moved.step, 'awaiting-review');
  assert.equal(moved.stop, null);
});

test('очередь не дала ни одной партии — окно закрывается как пустое', () => {
  let state = fresh();
  for (let step = 0; step < policy.zones.length; step += 1) {
    state = advanceWindow(state, policy, at(1 + step), 0);
  }
  assert.equal(state.step, 'finished');
  assert.equal(state.stop?.reason, 'queueEmpty');
  assert.equal(state.zoneIndex, policy.zones.length - 1);
});

test('зоны пройдены с работой — окно закрывается как отработавшее', () => {
  let state = wholeBatch(fresh(), 'architecture', accepted(), 0, 10);
  state = advanceWindow(state, policy, at(11), 0);
  assert.equal(state.zoneIndex, 1);
  state = advanceWindow(state, policy, at(12), 0);
  assert.equal(state.zoneIndex, 2);
  // Пустая очередь последней зоны закрывает окно: идти больше некуда.
  state = advanceWindow(state, policy, at(13), 0);
  assert.equal(state.step, 'finished');
  assert.equal(state.stop?.reason, 'zonesDone');
});

test('два отката за окно закрывают его', () => {
  const rollback = accepted({ outcome: 'rollback', reason: 'ворота красные' });
  const first = wholeBatch(fresh(), 'architecture', rollback, 0, 10);
  assert.equal(evaluateWindowStop(first, policy, at(11), 9), null);
  const second = wholeBatch(first, 'cleanup', rollback, 12, 22);
  const stop = evaluateWindowStop(second, policy, at(23), 9);
  assert.equal(stop?.reason, 'repeatedRollbacks');
  assert.equal(second.totals.rollbacks, 2);
});

test('откат в зоне стабилизации закрывает окно первым же разом', () => {
  const state = wholeBatch(
    fresh(),
    'stabilization',
    accepted({ outcome: 'rollback', reason: 'поведение изменилось' }),
  );
  const stop = evaluateWindowStop(state, policy, at(11), 9);
  assert.equal(stop?.reason, 'regressionInStabilization');
  assert.match(stop?.detail ?? '', /поведение изменилось/);
});

test('решение человека важнее счёта откатов', () => {
  const rollback = accepted({ outcome: 'rollback', reason: 'ворота красные' });
  let state = wholeBatch(fresh(), 'architecture', rollback, 0, 10);
  state = wholeBatch(state, 'cleanup', rollback, 12, 22);
  state = wholeBatch(
    state,
    'cleanup',
    accepted({ outcome: 'manual-review', reason: 'правка задела защищённую область' }),
    24,
    34,
  );
  assert.equal(evaluateWindowStop(state, policy, at(35), 9)?.reason, 'manualDecisionRequired');
});

test('регрессия стабилизации важнее двух откатов', () => {
  const rollback = accepted({ outcome: 'rollback', reason: 'ворота красные' });
  let state = wholeBatch(fresh(), 'cleanup', rollback, 0, 10);
  state = wholeBatch(state, 'stabilization', rollback, 12, 22);
  assert.equal(state.totals.rollbacks, 2);
  assert.equal(evaluateWindowStop(state, policy, at(23), 9)?.reason, 'regressionInStabilization');
});

test('нехватка времени важнее исчерпанного потолка партий', () => {
  let state = fresh();
  for (let index = 0; index < policy.maxRepairBatches; index += 1) {
    state = wholeBatch(state, 'cleanup', accepted(), index * 6, index * 6 + 5);
  }
  // Верны обе причины, но часы идут не по нашей воле: назвать их нашим же лимитом значит соврать.
  assert.equal(evaluateWindowStop(state, policy, at(119), 9)?.reason, 'timeBudgetSpent');
  assert.equal(evaluateWindowStop(state, policy, at(70), 9)?.reason, 'maxBatchesReached');
});

test('потолок партий сообщается раньше штатного «зоны пройдены»', () => {
  const single = policyFixture({
    maxRepairBatches: 2,
    zones: [{ id: 'stabilization', looksFor: [], mayChange: [], mustNotChange: [] }],
  });
  let state = wholeBatch(fresh(single), 'stabilization', accepted(), 0, 10);
  state = wholeBatch(state, 'stabilization', accepted(), 12, 22);
  assert.equal(evaluateWindowStop(state, single, at(25), 0)?.reason, 'maxBatchesReached');
});

test('остаток окна отрицателен после срока', () => {
  assert.equal(minutesLeft(fresh(), at(90)), 30);
  assert.equal(minutesLeft(fresh(), at(135)), -15);
});

test('остановка запоминается в состоянии, а не только печатается', () => {
  const state = advanceWindow(
    wholeBatch(fresh(), 'architecture', accepted({ outcome: 'manual-review' })),
    policy,
    at(11),
    9,
  );
  assert.equal(state.step, 'finished');
  assert.equal(state.stop?.reason, 'manualDecisionRequired');
  assert.equal(state.zoneIndex, 0);
});

test('закрытое окно повторным ходом не переписывается', () => {
  const closed = advanceWindow(fresh(), policy, at(119), 9);
  assert.equal(closed.stop?.reason, 'timeBudgetSpent');
  assert.equal(advanceWindow(closed, policy, at(1), 9), closed);
  assert.throws(() => beginBatch(closed, 'cleanup', ['fp-1'], at(2)), /закрыто/);
});

test('исход без открытой партии — ошибка порядка команд', () => {
  assert.throws(() => recordBatchOutcome(fresh(), accepted(), at(5)), /сначала beginBatch/);
});

/*
 * Бюджет отпускается ЗОНЕ, а не окну (решение заказчика 17.09.2026). Общий счётчик был ложной
 * мерой: ревьюер думает минутами, и съеденное им время отнималось у исполнителя — последняя зона
 * доставалась объедками, хотя разбирается в ней самое трудное.
 */
test('переход к следующей зоне отпускает ей своё время', () => {
  const policy = policyFixture();
  const opened = startWindow(policy, START);
  // Час прошёл, очередь зоны пуста: окно переходит к следующей зоне.
  const later = new Date(START.getTime() + 60 * 60 * 1000);
  const next = advanceWindow(opened, policy, later, 0);

  assert.equal(next.zoneIndex, opened.zoneIndex + 1);
  const left = (Date.parse(next.deadline) - later.getTime()) / 60000;
  assert.ok(
    Math.abs(left - policy.zoneMinutes) < 1,
    `у новой зоны ${left} мин вместо полного срока`,
  );
});

test('лестница ответов: буква, своё число, отказ', () => {
  const ladder = [
    { key: 'y', title: 'ещё', value: 180 },
    { key: '3', title: '60 мин', value: 60 },
    { key: 'n', title: 'закрыть', value: 0 },
  ];
  assert.equal(pickChoice('y', ladder), 180);
  assert.equal(pickChoice('3', ladder), 60);
  assert.equal(pickChoice('n', ladder), 0);
  // Пустой ответ — отказ: человек нажал Enter, и это «нет», а не «да».
  assert.equal(pickChoice('', ladder), null);
  assert.equal(pickChoice(null, ladder), null);
  // Своё число важнее лестницы: она подсказка, а не ограда.
  assert.equal(pickChoice('45', ladder), 45);
  assert.equal(pickChoice('ерунда', ladder), null);
});
