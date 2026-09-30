/**
 * Разбор ответа агента.
 *
 * Каждый случай здесь — не гипотетический: модель оборачивает объект пояснением, ставит
 * уверенность словом, забывает файлы, повторяет идентификатор. Проверяется главное свойство
 * разбора: кривая находка отбрасывается ПОИМЕННО и не уносит с собой остальные.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFindings } from '../core/finding-io.ts';
import { fingerprintOf, type Finding } from '../core/finding.ts';

const GOOD: Finding = {
  id: 'F1',
  category: 'dead-code',
  title: 'Неиспользуемая обёртка',
  subject: 'function wrap',
  severity: 'medium',
  confidence: 0.9,
  files: ['apps/api/src/x.ts'],
  evidence: 'функция wrap не вызывается ни из одного файла',
  behaviorRisk: 'low',
  suggestedAction: 'удалить wrap',
};

test('объект вынимается из ответа, обёрнутого пояснением и кавычками', () => {
  const answer = [
    'Вот результат:',
    '```json',
    JSON.stringify({ findings: [GOOD] }),
    '```',
    'Готово.',
  ].join('\n');
  const parsed = parseFindings(answer, 'ответ');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.problems.length, 0);
});

test('находка без файлов отбрасывается с называнием причины', () => {
  const parsed = parseFindings(JSON.stringify({ findings: [{ ...GOOD, files: [] }] }), 'ответ');
  assert.equal(parsed.findings.length, 0);
  assert.match(parsed.problems.join(' '), /не назван ни один файл/);
});

test('уверенность словом — промах формы, а не синоним', () => {
  const parsed = parseFindings(
    JSON.stringify({ findings: [{ ...GOOD, confidence: 'высокая' }] }),
    'ответ',
  );
  assert.equal(parsed.findings.length, 0);
  assert.match(parsed.problems.join(' '), /уверенность/);
});

test('одна кривая находка не уносит остальные', () => {
  const parsed = parseFindings(
    JSON.stringify({
      findings: [
        { ...GOOD, severity: 'критическая' },
        { ...GOOD, id: 'F2' },
      ],
    }),
    'ответ',
  );
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.id, 'F2');
  assert.equal(parsed.problems.length, 1);
});

test('повторный идентификатор отбрасывается: по нему адресуется задание исполнителю', () => {
  const parsed = parseFindings(
    JSON.stringify({ findings: [GOOD, { ...GOOD, title: 'другое' }] }),
    'ответ',
  );
  assert.equal(parsed.findings.length, 1);
  assert.match(parsed.problems.join(' '), /дважды/);
});

test('ответ без объекта JSON не роняет разбор, а называет проблему', () => {
  const parsed = parseFindings('Я посмотрел код и ничего не нашёл.', 'ответ');
  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.problems.length, 1);
});

test('отпечаток не зависит от номера находки, номеров строк и регистра', () => {
  // These are two reports of the same subject; run-local ids and evidence wording may differ.
  const a = fingerprintOf({
    ...GOOD,
    evidence: 'функция wrap не вызывается ни из одного файла (строка 120)',
  });
  const b = fingerprintOf({
    ...GOOD,
    id: 'F99',
    evidence: 'Функция WRAP  не вызывается ни из одного файла (строка 340)',
  });
  assert.equal(a, b);
});

test('перефразированное доказательство не создаёт новую находку', () => {
  assert.equal(
    fingerprintOf(GOOD),
    fingerprintOf({ ...GOOD, evidence: 'функция wrap вызывается только из теста' }),
  );
});

test('дублирование pathOf узнаётся после смены заголовка, доказательства и правила', () => {
  const files = [
    'packages/contracts/src/client-contract.ts',
    'tools/maintenance/core/maintenance.ts',
  ];
  const subject = 'duplicate pathOf helper between client-contract and maintenance';
  const before = fingerprintOf({
    ...GOOD,
    category: 'duplication',
    files,
    subject,
    title: 'Повторяется pathOf',
    evidence: 'Обе стороны содержат функцию pathOf с одинаковым телом',
    policy: 'old-policy',
  });
  const after = fingerprintOf({
    ...GOOD,
    category: 'duplication',
    files: [...files].reverse(),
    subject,
    title: 'Два локальных преобразователя пути',
    evidence: 'В двух файлах независимо нормализуется относительный путь',
    policy: 'new-policy',
  });
  assert.equal(before, after);
});

test('отпечаток меняется, когда меняется стабильный предмет проблемы', () => {
  assert.notEqual(fingerprintOf(GOOD), fingerprintOf({ ...GOOD, subject: 'function unwrap' }));
});

test('отпечаток меняется, когда меняется место проблемы', () => {
  assert.notEqual(
    fingerprintOf(GOOD),
    fingerprintOf({ ...GOOD, files: ['apps/api/src/other.ts'] }),
  );
});
