/**
 * Отчёт: единственное, что человек увидит после прогона.
 *
 * Проверяется здесь не вёрстка, а то, ошибка в чём оставляет человека без ответа: названа ли
 * причина остановки смыслом, а не кодом; отвечает ли пустой список решений словами вместо
 * брошенного заголовка; попадают ли в таблицу все четыре вида решений отбора (пропавший вид — это
 * молча спрятанная от человека находка); и переживает ли отчёт прогон, в котором не было ни
 * одного прохода — именно так выглядит остановка на пороге.
 *
 * ОТДЕЛЬНО — СООТВЕТСТВИЕ ОБЪЯСНЕНИЙ УСЛОВИЯМ. Причина остановки приходит из `evaluateStop`, а
 * объясняет её текст в отчёте, и разойтись они могут молча: код останавливает прогон по одному
 * поводу, человек читает про другой и принимает решение по выдумке. Поэтому состояния для этих
 * тестов не помечаются причиной руками — причину им выдаёт настоящий `evaluateStop`, и только
 * потом проверяется, что отчёт объяснил именно её.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pluralize,
  renderDecisionItems,
  renderRunReport,
  renderVerdictTable,
} from '../reporters/markdown.ts';
import { evaluateStop } from '../core/convergence.ts';
import { fixerPacket } from '../work-packets/fixer.ts';
import type { Verdict } from '../core/selector.ts';
import type { PassRecord, RunState, StopReason } from '../core/run-state.ts';
import type { ConvergenceBudget } from '../core/types.ts';
import { findingFixture, policySetFixture } from './fixtures.ts';

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
  assert.match(withOne, /изменено 1 файл/);
  assert.match(withOne, /изменено 21 строка/);
  assert.match(withOne, /принято 1 партия/);

  const withMany = renderRunReport(
    stateFixture({
      passes: [passFixture(), passFixture(), passFixture(), passFixture(), passFixture()],
      totals: { files: 11, lines: 112, rollbacks: 2, accepted: 3 },
    }),
  );
  assert.match(withMany, /Сделано 5 проходов/);
  assert.match(withMany, /изменено 11 файлов/);
  assert.match(withMany, /изменено 112 строк/);
  assert.match(withMany, /принято 3 партии/);
});

/** Тот же бюджет, что в `maintenance.yaml`: три прохода, последний — стабилизация. */
function budgetFixture(): ConvergenceBudget {
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
  };
}

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

/**
 * Состояния, каждое из которых сегодняшний `evaluateStop` закрывает своей причиной.
 *
 * `expect` — не пометка «пусть будет эта причина», а утверждение о коде: сначала проверяется, что
 * автомат действительно остановился здесь и по этому поводу, и только потом — что отчёт объяснил
 * человеку то же самое. Изменится условие — тест упадёт на первом же шаге, а не тихо разрешит
 * отчёту рассказывать про несуществующий порог.
 */
const STOP_CASES: readonly {
  readonly expect: StopReason;
  readonly state: RunState;
  readonly says: readonly RegExp[];
  readonly silent?: readonly RegExp[];
}[] = [
  {
    expect: 'manualDecisionRequired',
    state: stateFixture({
      passes: [passFixture({ verification: 'manual-review', verificationReason: 'вне партии' })],
      totals: { files: 1, lines: 0, rollbacks: 0, accepted: 0 },
    }),
    says: [/не приняла и не откатила/, /решение за человеком/],
  },
  {
    expect: 'behaviorRegressionDetected',
    state: stateFixture({
      passes: [
        passFixture({ passId: 'structural' }),
        passFixture({ passId: 'maintainability' }),
        passFixture({ passId: 'stabilization', verification: 'rollback' }),
      ],
      totals: { files: 1, lines: 0, rollbacks: 1, accepted: 2 },
    }),
    says: [/стабилизацией/, /код не разбирает, чем вызван откат/],
  },
  {
    expect: 'newSevereIssuesExceedResolved',
    state: stateFixture({
      passes: [passFixture({ newSevere: 2, resolvedSevere: 0 })],
      totals: { files: 1, lines: 0, rollbacks: 0, accepted: 1 },
    }),
    // Условие читает ТОЛЬКО последний проход: отчёт обязан сказать это, иначе человек ищет
    // причину в сумме по прогону и не находит.
    says: [/последний проход создал серьёзных проблем больше/, /только на последний проход/],
  },
  {
    expect: 'verificationFailedRepeatedly',
    state: stateFixture({
      passes: [
        passFixture({ passId: 'structural', verification: 'rollback' }),
        passFixture({ passId: 'maintainability', verification: 'rollback' }),
      ],
      totals: { files: 0, lines: 0, rollbacks: 2, accepted: 0 },
    }),
    says: [/откачено не меньше двух партий/, /не обязаны идти подряд/],
  },
  {
    expect: 'changeBudgetExceeded',
    state: stateFixture({
      passes: [passFixture()],
      totals: { files: 26, lines: 0, rollbacks: 0, accepted: 1 },
    }),
    // Бюджет проверяется после прохода, и вышедшая за предел партия остаётся в дереве. Обещание
    // отката здесь было бы опаснее молчания: человек не пошёл бы смотреть, что уже изменено.
    says: [/вышел за бюджет правки/, /уже в дереве и не откатывается/],
  },
  {
    expect: 'noSelectedFindings',
    state: stateFixture({
      passes: [passFixture({ counts: { selected: 0, deferred: 3, manual: 1, rejected: 2 } })],
      totals: { files: 0, lines: 0, rollbacks: 0, accepted: 0 },
    }),
    says: [/не взял в работу ни одной находки/, /только на взятое в работу/],
  },
  {
    expect: 'improvementBelowThreshold',
    state: stateFixture({
      passes: [
        passFixture({ passId: 'structural', changedFiles: [], changedLines: 0 }),
        passFixture({ passId: 'maintainability', changedFiles: [], changedLines: 0 }),
      ],
      totals: { files: 0, lines: 0, rollbacks: 0, accepted: 0 },
    }),
    says: [/ни одной партии с изменениями принять не удалось/, /дважды подряд не смогла/],
    // Прежний текст объявлял два провалившихся прохода успешной сходимостью. Запрет на эти слова
    // и есть тест: вернётся формулировка — упадёт.
    silent: [/сошёлся/, /стоили бы дороже/, /не признак сбоя/],
  },
  {
    expect: 'maxPassesReached',
    state: stateFixture({
      passes: [
        passFixture({ passId: 'structural' }),
        passFixture({ passId: 'maintainability' }),
        passFixture({ passId: 'stabilization' }),
      ],
      totals: { files: 1, lines: 0, rollbacks: 0, accepted: 3 },
    }),
    says: [/план выполнен целиком/, /упёрся в потолок/],
  },
];

test('объяснение причины остановки описывает то условие, по которому код останавливает прогон', () => {
  for (const item of STOP_CASES) {
    const stop = evaluateStop(item.state, budgetFixture(), ALL_CONDITIONS);
    assert.ok(stop !== null, item.expect);
    assert.equal(stop.reason, item.expect, item.expect);

    const report = renderRunReport({ ...item.state, step: 'finished', stop });
    for (const says of item.says) assert.match(report, says, `${item.expect}: ${String(says)}`);
    for (const silent of item.silent ?? [])
      assert.doesNotMatch(report, silent, `${item.expect}: ${String(silent)}`);
  }
});

test('остановка по двум проходам без принятой партии не выдаётся за успешную сходимость', () => {
  const state = stateFixture({
    passes: [
      passFixture({ passId: 'structural', verification: 'rollback', changedFiles: [] }),
      passFixture({ passId: 'maintainability', verification: 'rollback', changedFiles: [] }),
    ],
    totals: { files: 0, lines: 0, rollbacks: 0, accepted: 0 },
  });
  const stop = evaluateStop(state, budgetFixture(), ['improvementBelowThreshold']);
  assert.equal(stop?.reason, 'improvementBelowThreshold');

  const report = renderRunReport({ ...state, stop });
  assert.match(report, /это не сходимость, а неудача/);
  // Имя причины в политике обещает измеренный порог. Порога в коде нет, и отчёт говорит об этом
  // прямо: иначе человек ищет в настройках число, которого не существует.
  assert.match(report, /никакого порога код не считает/);
});

test('объяснения не пересказывают друг друга: у каждой причины свой текст', () => {
  const reasons = ALL_CONDITIONS as readonly StopReason[];
  const texts = reasons.map((reason) => {
    const report = renderRunReport(stateFixture({ stop: { reason, detail: '' } }));
    const start = report.indexOf('Цикл закончился, потому что');
    return report.slice(start, report.indexOf('## ', start + 1));
  });
  assert.equal(new Set(texts).size, reasons.length);
});

test('объём правки в строках не выдумывается, когда его не измерили', () => {
  const noMeasure = renderRunReport(
    stateFixture({
      passes: [passFixture({ changedLines: 0 })],
      totals: { files: 3, lines: 0, rollbacks: 0, accepted: 1 },
    }),
  );
  // Ноль строк при изменённых файлах — не измерение, а его отсутствие: показать его цифрой
  // значит сказать человеку, что правка пустая.
  assert.match(noMeasure, /объём правки в строках не измерен/);
  assert.doesNotMatch(noMeasure, /изменено 0 строк/);
  assert.match(noMeasure, /Прочерк в колонке «Строк» значит «не измерено»/);

  const measured = renderRunReport(
    stateFixture({
      passes: [passFixture({ changedLines: 40 })],
      totals: { files: 3, lines: 40, rollbacks: 0, accepted: 1 },
    }),
  );
  // Тот же текст обязан стать числом сам, как только счётчик строк починят.
  assert.match(measured, /изменено 40 строк/);
  assert.doesNotMatch(measured, /не измерен/);
  assert.doesNotMatch(measured, /Прочерк в колонке/);
});

test('итоги не обещают больше, чем считают: разные файлы и партии с изменениями', () => {
  const report = renderRunReport(
    stateFixture({
      passes: [
        passFixture({ passId: 'p1', changedFiles: ['a.ts', 'b.ts'] }),
        passFixture({ passId: 'p2', changedFiles: ['a.ts'] }),
      ],
      totals: { files: 2, lines: 0, rollbacks: 0, accepted: 2 },
    }),
  );
  // Сумма колонки «Файлов» здесь 3, а итог 2: один файл правили дважды. Без пояснения читатель
  // считает расхождение ошибкой отчёта.
  assert.match(report, /сумма\s+колонки «Файлов» бывает\s+больше/);
  assert.match(report, /изменено 2 файла/);
  assert.match(report, /Файлы здесь считаются разные за весь прогон/);
  assert.match(report, /принято 2 партии с изменениями/);
});

test('согласование числительных в задании исполнителю берётся из той же функции', () => {
  const packet = (count: number) =>
    fixerPacket({
      findings: Array.from({ length: count }, (_, index) =>
        findingFixture({ id: `F${index}`, files: [`apps/api/src/f${index}.ts`] }),
      ),
      policies: policySetFixture(),
      budget: budgetFixture(),
      outputFile: 'fix.json',
      verification: ['ворота'],
    }).goal;

  assert.match(packet(1), /Исправить 1 утверждённую находку/);
  assert.match(packet(3), /Исправить 3 утверждённые находки/);
  assert.match(packet(5), /Исправить 5 утверждённых находок/);
  // Одиннадцать ловит обе реализации разом: правило про 11–14 расходится первым.
  assert.match(packet(11), /Исправить 11 утверждённых находок/);
});
