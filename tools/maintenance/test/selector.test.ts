/**
 * Отбор: главное место, где система говорит «нет».
 *
 * Каждая проверка здесь отвечает на вопрос «что защищает нас от правки, которой не должно быть»:
 * защищённая область, запрет автоправки у правила, риск для поведения, порог уверенности и три
 * лимита бюджета. Отдельно проверяется повторяемость: два одинаковых прогона обязаны дать один и
 * тот же выбор.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFindings } from '../core/selector.ts';
import { configFixture, findingFixture, policySetFixture } from './fixtures.ts';

const config = configFixture();
const policies = policySetFixture();
const budget = policies.maintenance.convergence;

function decide(findings: ReturnType<typeof findingFixture>[]) {
  return selectFindings({ config, policies, budget, findings });
}

test('обычная находка в пределах бюджета берётся в работу', () => {
  const selection = decide([findingFixture()]);
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.verdicts[0]?.decision, 'selected');
});

test('файл в запрещённой области уводит находку к человеку, а не в работу', () => {
  const selection = decide([findingFixture({ files: ['apps/api/drizzle/0001.sql'] })]);
  assert.equal(selection.selected.length, 0);
  assert.equal(selection.verdicts[0]?.decision, 'manual');
  assert.match(selection.verdicts[0]?.reason ?? '', /migrations/);
});

test('одного запрещённого файла в находке достаточно, чтобы её не взяли', () => {
  const selection = decide([
    findingFixture({ files: ['apps/api/src/x.ts', 'apps/api/test/x.test.ts'] }),
  ]);
  assert.equal(selection.verdicts[0]?.decision, 'manual');
});

test('правило с запретом автоправки не чинится автоматически даже при полной уверенности', () => {
  const selection = decide([findingFixture({ policy: 'hard-rule', confidence: 1 })]);
  assert.equal(selection.verdicts[0]?.decision, 'manual');
});

test('совещательное правило поводом к правке не является', () => {
  const selection = decide([findingFixture({ policy: 'advisory-rule' })]);
  assert.equal(selection.verdicts[0]?.decision, 'rejected');
});

test('ссылка на несуществующее правило означает человека, а не молчаливое согласие', () => {
  const selection = decide([findingFixture({ policy: 'выдуманное-правило' })]);
  assert.equal(selection.verdicts[0]?.decision, 'manual');
});

test('риск для поведения выше допустимого уводит находку к человеку', () => {
  const selection = decide([findingFixture({ behaviorRisk: 'medium' })]);
  assert.equal(selection.verdicts[0]?.decision, 'manual');
});

test('уверенность ниже порога откладывает находку, но не теряет её', () => {
  const selection = decide([findingFixture({ confidence: 0.5 })]);
  assert.equal(selection.verdicts[0]?.decision, 'deferred');
  assert.equal(selection.verdicts.length, 1);
});

test('лимит находок на проход соблюдается', () => {
  const selection = decide([
    findingFixture({ id: 'F1' }),
    findingFixture({ id: 'F2', files: ['apps/api/src/y.ts'] }),
    findingFixture({ id: 'F3', files: ['apps/api/src/z.ts'] }),
  ]);
  assert.equal(selection.selected.length, 2);
  assert.equal(selection.verdicts[2]?.decision, 'deferred');
});

test('лимит строк считается по оценке находок, а не по факту правки', () => {
  const selection = decide([
    findingFixture({ id: 'F1', estimatedLines: 90 }),
    findingFixture({ id: 'F2', estimatedLines: 90, files: ['apps/api/src/y.ts'] }),
  ]);
  assert.equal(selection.selected.length, 1);
  assert.match(selection.verdicts[1]?.reason ?? '', /строк/);
});

test('лимит файлов считается по объединению файлов партии', () => {
  const selection = decide([
    findingFixture({ id: 'F1', files: ['apps/api/src/a.ts', 'apps/api/src/b.ts'] }),
    findingFixture({ id: 'F2', files: ['apps/api/src/c.ts', 'apps/api/src/d.ts'] }),
  ]);
  assert.equal(selection.selected.length, 1);
  assert.match(selection.verdicts[1]?.reason ?? '', /файлов/);
});

test('порядок отбора не зависит от порядка прихода находок', () => {
  const high = findingFixture({ id: 'B', severity: 'high', files: ['apps/api/src/b.ts'] });
  const low = findingFixture({ id: 'A', severity: 'low', files: ['apps/api/src/a.ts'] });
  const forward = decide([high, low]).selected.map((finding) => finding.id);
  const backward = decide([low, high]).selected.map((finding) => finding.id);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ['B', 'A']);
});
