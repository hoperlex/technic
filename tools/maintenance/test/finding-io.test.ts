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
  // Сравниваются две записи ОДНОЙ проблемы, сделанные в разных прогонах: сменился номер находки,
  // регистр, лишний пробел и номер строки. Сама проблема та же — отпечаток обязан совпасть.
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

test('отпечаток меняется, когда меняется само доказательство', () => {
  assert.notEqual(
    fingerprintOf(GOOD),
    fingerprintOf({ ...GOOD, evidence: 'функция wrap вызывается только из теста' }),
  );
});

test('отпечаток меняется, когда меняется место проблемы', () => {
  assert.notEqual(
    fingerprintOf(GOOD),
    fingerprintOf({ ...GOOD, files: ['apps/api/src/other.ts'] }),
  );
});
