/**
 * Очередь долга: проверяется не «сортируется ли массив», а объяснимость порядка.
 *
 * Каждое слагаемое формулы проверяется ОТДЕЛЬНО — при прочих равных меняется ровно один сигнал, и
 * тест утверждает, куда от этого поедет находка. Слитная проверка «сложная находка оказалась
 * первой» прошла бы и при перепутанных весах, и при потерянном слагаемом.
 *
 * Второй предмет проверки — повторяемость: два прогона на одних и тех же данных обязаны дать одну
 * и ту же очередь независимо от порядка прихода находок, включая случай равных счетов. Очередь,
 * которая переставляется сама, не объяснима в принципе: человек не сможет спросить «почему эта
 * третья», потому что завтра она будет первой.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DEBT_WEIGHTS, rankDebt, zoneOf } from '../core/debt-queue.ts';
import type { DebtSignals, DebtWeights } from '../core/debt-queue.ts';
import type { Finding, TrackedFinding } from '../core/finding.ts';
import type { DeepMaintenanceZone } from '../core/types.ts';
import { findingFixture } from './fixtures.ts';

const zones: readonly DeepMaintenanceZone[] = [
  {
    id: 'architecture',
    looksFor: ['cycles', 'leakage'],
    mayChange: ['boundaries'],
    mustNotChange: [],
  },
  {
    id: 'cleanup',
    looksFor: ['dead-code', 'duplication'],
    mayChange: ['local-cleanup'],
    mustNotChange: [],
  },
];

const noSignals: DebtSignals = { hotness: new Map(), ageDays: new Map() };

function signals(parts: Partial<DebtSignals> = {}): DebtSignals {
  return { ...noSignals, ...parts };
}

function rank(
  findings: readonly TrackedFinding[],
  input: { signals?: DebtSignals; weights?: Partial<DebtWeights> } = {},
) {
  return rankDebt({
    findings,
    zones,
    signals: input.signals ?? noSignals,
    ...(input.weights === undefined ? {} : { weights: input.weights }),
  });
}

function order(findings: readonly TrackedFinding[], input: Parameters<typeof rank>[1] = {}) {
  return rank(findings, input).map((item) => item.finding.id);
}

/** Пара одинаковых находок, различающихся только файлом: нужен разный отпечаток при равном счёте. */
function pair(a: Partial<Finding> = {}, b: Partial<Finding> = a) {
  return [
    findingFixture({ id: 'A', files: ['apps/api/src/a.ts'], evidence: 'а', ...a }),
    findingFixture({ id: 'B', files: ['apps/api/src/b.ts'], evidence: 'б', ...b }),
  ] as const;
}

test('строгость поднимает находку выше', () => {
  const [low, high] = pair({ severity: 'low' }, { severity: 'high' });
  assert.deepEqual(order([low, high]), ['B', 'A']);
});

test('уверенность поднимает находку выше', () => {
  const [unsure, sure] = pair({ confidence: 0.4 }, { confidence: 1 });
  assert.deepEqual(order([unsure, sure]), ['B', 'A']);
});

test('горячий файл поднимает находку: долг в живом коде дороже долга в спящем', () => {
  const [cold, hot] = pair();
  const ranked = rank([cold, hot], {
    signals: signals({ hotness: new Map([['apps/api/src/b.ts', 20]]) }),
  });
  assert.deepEqual(
    ranked.map((item) => item.finding.id),
    ['B', 'A'],
  );
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test('залежавшаяся находка поднимается: повседневный цикл её уже не подобрал', () => {
  const [fresh, old] = pair();
  const ranked = rank([fresh, old], {
    signals: signals({ ageDays: new Map([[old.fingerprint, 180]]) }),
  });
  assert.deepEqual(
    ranked.map((item) => item.finding.id),
    ['B', 'A'],
  );
});

test('риск для поведения ПОНИЖАЕТ находку: тяжёлое окно не место для рискованных правок', () => {
  const [safe, risky] = pair({ behaviorRisk: 'low' }, { behaviorRisk: 'high' });
  const ranked = rank([risky, safe]);
  assert.deepEqual(
    ranked.map((item) => item.finding.id),
    ['A', 'B'],
  );
  assert.ok((ranked[1]?.score ?? 0) < (ranked[0]?.score ?? 0));
});

test('порядок не зависит от порядка прихода находок', () => {
  const findings = [
    findingFixture({ id: 'A', severity: 'low', files: ['apps/api/src/a.ts'], evidence: 'а' }),
    findingFixture({ id: 'B', severity: 'high', files: ['apps/api/src/b.ts'], evidence: 'б' }),
    findingFixture({ id: 'C', severity: 'medium', files: ['apps/api/src/c.ts'], evidence: 'в' }),
  ];
  const forward = order(findings);
  const backward = order([...findings].reverse());
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ['B', 'C', 'A']);
});

test('при равных счетах порядок решает отпечаток, а не порядок входа', () => {
  const [first, second] = pair();
  const ranked = rank([first, second]);
  const scores = ranked.map((item) => item.score);
  assert.equal(scores[0], scores[1]);

  const byFingerprint = [first, second]
    .map((finding) => finding.fingerprint)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(
    ranked.map((item) => item.finding.fingerprint),
    byFingerprint,
  );
  assert.deepEqual(
    rank([second, first]).map((item) => item.finding.fingerprint),
    byFingerprint,
  );
});

test('находка вне зон в очередь не попадает, и это не ошибка', () => {
  const stray = findingFixture({ id: 'X', category: 'наблюдение' });
  const ranked = rank([stray, findingFixture({ id: 'A' })]);
  assert.deepEqual(
    ranked.map((item) => item.finding.id),
    ['A'],
  );
  assert.equal(zoneOf(stray, zones), null);
});

test('зона определяется видом находки и берётся первая подходящая', () => {
  assert.equal(zoneOf(findingFixture({ category: 'cycles' }), zones), 'architecture');
  assert.equal(zoneOf(findingFixture({ category: 'dead-code' }), zones), 'cleanup');
  assert.equal(zoneOf(findingFixture({ category: ' Dead-Code ' }), zones), 'cleanup');
  assert.equal(rank([findingFixture({ category: 'duplication' })])[0]?.zone, 'cleanup');
});

test('reasons называет каждое слагаемое счёта', () => {
  const finding = findingFixture({ id: 'A', severity: 'high', behaviorRisk: 'medium' });
  const item = rank([finding], {
    signals: signals({
      hotness: new Map([['apps/api/src/x.ts', 5]]),
      ageDays: new Map([[finding.fingerprint, 90]]),
    }),
  })[0];
  const reasons = item?.reasons ?? [];
  assert.equal(reasons.length, 5);
  assert.match(reasons.join('\n'), /строгость \(high\): \+3\.00/);
  assert.match(reasons.join('\n'), /уверенность \(0\.95\): \+0\.95/);
  assert.match(reasons.join('\n'), /частота правок \(5 за окно наблюдения\): \+0\.75/);
  assert.match(reasons.join('\n'), /возраст находки \(90 дн\.\): \+0\.50/);
  // Риск — единственное слагаемое со знаком минус: по строке видно, что он вычитается.
  assert.match(reasons.join('\n'), /риск для поведения \(medium\): -1\.00/);
  assert.equal(item?.score, 3 + 0.95 + 0.75 + 0.5 - 1);
});

test('веса из настроек меняют порядок', () => {
  const findings = [
    findingFixture({
      id: 'A',
      severity: 'high',
      confidence: 0.5,
      files: ['apps/api/src/a.ts'],
      evidence: 'а',
    }),
    findingFixture({
      id: 'B',
      severity: 'low',
      confidence: 1,
      files: ['apps/api/src/b.ts'],
      evidence: 'б',
    }),
  ];
  assert.deepEqual(order(findings), ['A', 'B']);
  // Обнулённая строгость оставляет решать уверенности — и очередь переворачивается.
  assert.deepEqual(order(findings, { weights: { severity: 0 } }), ['B', 'A']);
  assert.equal(DEFAULT_DEBT_WEIGHTS.severity, 3);
});

test('нечисловой вес роняет прогон, а не подставляет умолчание', () => {
  assert.throws(
    () => rank([findingFixture()], { weights: { hotness: Number.NaN } }),
    /вес «hotness»/,
  );
});

test('пустой вход даёт пустую очередь, а не падение', () => {
  assert.deepEqual(rank([]), []);
  assert.deepEqual(rankDebt({ findings: [], zones: [], signals: noSignals }), []);
});
