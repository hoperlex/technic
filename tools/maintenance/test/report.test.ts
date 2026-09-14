/**
 * Отчёт: единственное, что человек увидит после прогона.
 *
 * Проверяется здесь не вёрстка, а то, ошибка в чём оставляет человека без ответа: названа ли
 * причина остановки смыслом, а не кодом; отвечает ли пустой список решений словами вместо
 * брошенного заголовка; попадают ли в таблицу все четыре вида решений отбора (пропавший вид — это
 * молча спрятанная от человека находка); и переживает ли отчёт прогон, в котором не было ни
 * одного прохода — именно так выглядит остановка на пороге.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pluralize,
  renderDecisionItems,
  renderRunReport,
  renderVerdictTable,
} from '../reporters/markdown.ts';
import type { Verdict } from '../core/selector.ts';
import type { PassRecord, RunState } from '../core/run-state.ts';
import { findingFixture } from './fixtures.ts';

test('раздел решений печатается один раз и берёт переданный список', () => {
  const given = [findingFixture({ id: 'X1', title: 'переданная находка' })];
  const report = renderRunReport(stateFixture(), { decisionItems: given });
  const sections = report.split('## Решения, требующие человека').length - 1;
  // Раздел один: вызывающий передаёт список, а не дописывает второй такой же раздел следом.
  assert.equal(sections, 1);
  assert.match(report, /переданная находка/);
});

function passFixture(overrides: Partial<PassRecord> = {}): PassRecord {
  return {
    passId: 'structural',
    startedAt: '2026-09-14T10:00:00.000Z',
    counts: { selected: 2, deferred: 1, manual: 1, rejected: 0 },
    manualFindings: [],
    selectedFindings: [],
    verification: 'accept',
    verificationReason: 'проверка пройдена: ворота',
    changedFiles: ['apps/api/src/x.ts'],
    changedLines: 12,
    newSevere: 0,
    resolvedSevere: 0,
    finishedAt: '2026-09-14T10:07:00.000Z',
    ...overrides,
  };
}

function stateFixture(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-0001',
    startedAt: '2026-09-14T10:00:00.000Z',
    passIndex: 1,
    step: 'finished',
    passes: [passFixture()],
    stop: { reason: 'noSelectedFindings', detail: 'отбор вернул пустой список' },
    totals: { files: 1, lines: 12, rollbacks: 0, accepted: 1 },
    ...overrides,
  };
}

test('отчёт объясняет причину остановки словами, а не кодом состояния', () => {
  const report = renderRunReport(stateFixture());
  assert.match(report, /Цикл закончился, потому что/);
  assert.match(report, /не взял в работу ни одной находки/);
  assert.match(report, /Что это значит:/);
  // Код причины в отчёт попасть не должен: человеку он ничего не объясняет и оспорить его нечем.
  assert.doesNotMatch(report, /noSelectedFindings/);
});

test('каждая причина остановки имеет человеческое объяснение, а не только название', () => {
  const reasons = [
    'maxPassesReached',
    'noSelectedFindings',
    'improvementBelowThreshold',
    'behaviorRegressionDetected',
    'changeBudgetExceeded',
    'newSevereIssuesExceedResolved',
    'verificationFailedRepeatedly',
    'manualDecisionRequired',
  ] as const;
  for (const reason of reasons) {
    const report = renderRunReport(stateFixture({ stop: { reason, detail: '' } }));
    assert.match(report, /Цикл закончился, потому что/, reason);
    assert.match(report, /Что это значит:/, reason);
    assert.doesNotMatch(report, new RegExp(reason), reason);
  }
});

test('незаконченный прогон не выдумывает причину остановки', () => {
  const report = renderRunReport(stateFixture({ stop: null, step: 'awaiting-fix' }));
  assert.match(report, /Прогон не остановлен/);
  assert.match(report, /ждёт правки исполнителя/);
});

test('исход проверки каждого прохода виден в отчёте', () => {
  const report = renderRunReport(
    stateFixture({
      passes: [
        passFixture({ passId: 'p1', verification: 'accept' }),
        passFixture({
          passId: 'p2',
          verification: 'rollback',
          verificationReason: 'ошибок линта стало больше: было 0, стало 1',
        }),
        passFixture({ passId: 'p3', verification: null, verificationReason: null }),
      ],
    }),
  );
  assert.match(report, /принято/);
  assert.match(report, /откачено/);
  assert.match(report, /не проверялся/);
  // Причина отката приводится дословно: без неё отчёт сообщает факт и молчит о поводе.
  assert.match(report, /ошибок линта стало больше/);
});

test('отчёт не падает на прогоне без единого прохода и говорит об этом прямо', () => {
  const report = renderRunReport(
    stateFixture({
      passes: [],
      passIndex: 0,
      totals: { files: 0, lines: 0, rollbacks: 0, accepted: 0 },
    }),
  );
  assert.match(report, /Ни одного прохода не сделано/);
  assert.match(report, /изменено 0 файлов/);
  assert.doesNotMatch(report, /\| Проход/);
});

test('заголовок отчёта берётся из настроек, а по умолчанию есть свой', () => {
  assert.match(renderRunReport(stateFixture()), /^# Отчёт прогона обслуживания\n/);
  assert.match(renderRunReport(stateFixture(), { title: 'Ночной прогон' }), /^# Ночной прогон\n/);
});

test('пустой список решений даёт осмысленную строку, а не брошенный заголовок', () => {
  const text = renderDecisionItems([]);
  assert.equal(text, 'Решений, требующих человека, нет: отбор ничего не отдал наверх.');
  assert.doesNotMatch(text, /^#/m);
});

test('пункт решения приводит файлы, доказательство и предложенное действие', () => {
  const text = renderDecisionItems([
    findingFixture({
      id: 'F7',
      title: 'миграция правится вручную',
      files: ['apps/api/drizzle/0001.sql'],
      evidence: 'файл в защищённой области',
      suggestedAction: 'вынести в отдельную миграцию',
      policy: 'hard-rule',
      relatedAdr: 'ADR 0147',
    }),
  ]);
  assert.match(text, /## Решения, требующие человека/);
  assert.match(text, /### F7 — миграция правится вручную/);
  assert.match(text, /apps\/api\/drizzle\/0001\.sql/);
  assert.match(text, /файл в защищённой области/);
  assert.match(text, /вынести в отдельную миграцию/);
  assert.match(text, /hard-rule/);
  assert.match(text, /ADR 0147/);
});

test('неназванные правило и решение не превращаются в строки-пустышки', () => {
  const text = renderDecisionItems([findingFixture({ id: 'F8' })]);
  assert.doesNotMatch(text, /правило:/);
  assert.doesNotMatch(text, /решение:/);
  assert.doesNotMatch(text, /undefined/);
});

test('решения человеку попадают в отчёт прогона без повторов между проходами', () => {
  const finding = findingFixture({ id: 'F9', title: 'та же самая находка' });
  const report = renderRunReport(
    stateFixture({
      passes: [
        passFixture({ passId: 'p1', manualFindings: [finding] }),
        // Тот же отпечаток с другим номером: так одна и та же проблема приходит в каждом проходе.
        passFixture({ passId: 'p2', manualFindings: [findingFixture({ id: 'F10' })] }),
      ],
    }),
  );
  assert.equal(report.match(/та же самая находка/g)?.length, 1);
});

test('таблица вердиктов содержит все четыре вида решений отбора', () => {
  const verdicts: Verdict[] = [
    { finding: findingFixture({ id: 'A' }), decision: 'selected', reason: 'в пределах бюджета' },
    { finding: findingFixture({ id: 'B' }), decision: 'deferred', reason: 'лимит строк' },
    { finding: findingFixture({ id: 'C' }), decision: 'manual', reason: 'защищённая область' },
    { finding: findingFixture({ id: 'D' }), decision: 'rejected', reason: 'правило совещательное' },
  ];
  const table = renderVerdictTable(verdicts);
  for (const title of ['в работу', 'отложено', 'человеку', 'отклонено']) {
    assert.match(table, new RegExp(title), title);
  }
  for (const id of ['A', 'B', 'C', 'D']) assert.match(table, new RegExp(`\\| ${id} `), id);
  assert.match(table, /Разобрано 4 находки/);
  // Причины приводятся дословно: на вопрос «почему не взяли» отвечает именно колонка причины.
  assert.match(table, /защищённая область/);
});

test('черта внутри причины не разваливает таблицу вердиктов', () => {
  const table = renderVerdictTable([
    { finding: findingFixture({ id: 'A' }), decision: 'rejected', reason: 'a | b' },
  ]);
  const row = table.split('\n').find((line) => line.startsWith('| A '));
  assert.ok(row !== undefined);
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 5);
});

test('пустой отбор даёт строку, а не таблицу из одних заголовков', () => {
  assert.equal(renderVerdictTable([]), 'Отбор не рассматривал ни одной находки.');
});

test('числительные согласованы с существительным', () => {
  assert.equal(pluralize(1, 'находка', 'находки', 'находок'), '1 находка');
  assert.equal(pluralize(2, 'находка', 'находки', 'находок'), '2 находки');
  assert.equal(pluralize(5, 'находка', 'находки', 'находок'), '5 находок');
  // Одиннадцать — главная ловушка правила: последняя цифра единица, а форма множественная.
  assert.equal(pluralize(11, 'находка', 'находки', 'находок'), '11 находок');
  assert.equal(pluralize(21, 'находка', 'находки', 'находок'), '21 находка');
  assert.equal(pluralize(0, 'находка', 'находки', 'находок'), '0 находок');
});

test('согласование работает и в живом отчёте, а не только в отдельной функции', () => {
  const withOne = renderRunReport(
    stateFixture({ totals: { files: 1, lines: 21, rollbacks: 0, accepted: 1 } }),
  );
  assert.match(withOne, /изменено 1 файл, 21 строка/);
  assert.match(withOne, /принято 1 партия/);

  const withMany = renderRunReport(
    stateFixture({
      passes: [passFixture(), passFixture(), passFixture(), passFixture(), passFixture()],
      totals: { files: 11, lines: 112, rollbacks: 2, accepted: 3 },
    }),
  );
  assert.match(withMany, /Сделано 5 проходов/);
  assert.match(withMany, /изменено 11 файлов, 112 строк/);
  assert.match(withMany, /принято 3 партии/);
});
