/**
 * Отбор: главное место, где система говорит «нет».
 *
 * Каждая проверка здесь отвечает на вопрос «что защищает нас от правки, которой не должно быть»:
 * защищённая область, запрет автоправки у правила, риск для поведения, порог уверенности и три
 * лимита бюджета. Отдельно проверяется повторяемость: два одинаковых прогона обязаны дать один и
 * тот же выбор.
 *
 * Отдельным блоком — реестр исключений: единственный законный способ сказать «здесь правило
 * нарушено осознанно». Проверяется и то, что он укрывает, и то, чего он не укрывает: исключение,
 * не действующее ни на что, и исключение, укрывающее лишнее, одинаково опасны — первое обманывает
 * человека, второе прячет от него настоящее нарушение.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFindings } from '../core/selector.ts';
import type { ArchitectureException } from '../core/types.ts';
import { configFixture, exceptionFixture, findingFixture, policySetFixture } from './fixtures.ts';

const config = configFixture();
const policies = policySetFixture();
const budget = policies.maintenance.convergence;

/** День прогона задан числом: срок исключения обязан решаться отбором, а не календарём машины. */
const TODAY = new Date('2026-09-15T12:00:00.000Z');

function decide(findings: ReturnType<typeof findingFixture>[]) {
  return selectFindings({ config, policies, budget, findings, now: TODAY });
}

function decideWith(
  exceptions: readonly ArchitectureException[],
  findings: ReturnType<typeof findingFixture>[],
) {
  return selectFindings({
    config,
    policies: policySetFixture({ exceptions }),
    budget,
    findings,
    now: TODAY,
  });
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

test('находка под действующим исключением узаконена: ни в работу, ни в проблемы', () => {
  const finding = findingFixture({ policy: 'soft-rule' });
  // Без реестра эта же находка берётся в работу — значит вердикт даёт именно исключение.
  assert.equal(decide([finding]).verdicts[0]?.decision, 'selected');

  const selection = decideWith([exceptionFixture()], [finding]);
  assert.equal(selection.selected.length, 0);
  assert.equal(selection.verdicts[0]?.decision, 'rejected');
  assert.match(selection.verdicts[0]?.reason ?? '', /узаконено исключением E1/);
});

test('исключение по другому правилу находку не укрывает', () => {
  const selection = decideWith(
    [exceptionFixture({ policy: 'hard-rule' })],
    [findingFixture({ policy: 'soft-rule' })],
  );
  assert.equal(selection.verdicts[0]?.decision, 'selected');
});

test('исключение по другой маске находку не укрывает', () => {
  const selection = decideWith(
    [exceptionFixture({ paths: ['apps/web/**'] })],
    [findingFixture({ policy: 'soft-rule' })],
  );
  assert.equal(selection.verdicts[0]?.decision, 'selected');
});

test('исключение не растягивается на файлы находки, которых в нём нет', () => {
  const selection = decideWith(
    [exceptionFixture()],
    [findingFixture({ policy: 'soft-rule', files: ['apps/api/src/x.ts', 'apps/web/src/y.ts'] })],
  );
  assert.equal(selection.verdicts[0]?.decision, 'selected');
});

test('в день пересмотра исключение ещё действует', () => {
  const selection = decideWith(
    [exceptionFixture({ reviewBy: '2026-09-15' })],
    [findingFixture({ policy: 'soft-rule' })],
  );
  assert.equal(selection.verdicts[0]?.decision, 'rejected');
});

test('просроченное исключение не укрывает находку, а показывает её человеку', () => {
  const selection = decideWith(
    [exceptionFixture({ reviewBy: '2026-09-14' })],
    [findingFixture({ policy: 'soft-rule' })],
  );
  assert.equal(selection.selected.length, 0);
  assert.equal(selection.verdicts[0]?.decision, 'manual');
  assert.match(selection.verdicts[0]?.reason ?? '', /E1/);
  assert.match(selection.verdicts[0]?.reason ?? '', /2026-09-14/);
});

test('исключение без даты пересмотра не укрывает: бессрочных исключений не бывает', () => {
  const selection = decideWith(
    [exceptionFixture({ reviewBy: undefined })],
    [findingFixture({ policy: 'soft-rule' })],
  );
  assert.equal(selection.verdicts[0]?.decision, 'manual');
  assert.match(selection.verdicts[0]?.reason ?? '', /не назначен/);
});

test('исключение не отменяет защищённую область', () => {
  const selection = decideWith(
    [exceptionFixture({ paths: ['apps/api/drizzle/**'] })],
    [findingFixture({ policy: 'soft-rule', files: ['apps/api/drizzle/0001.sql'] })],
  );
  assert.equal(selection.verdicts[0]?.decision, 'manual');
  assert.match(selection.verdicts[0]?.reason ?? '', /migrations/);
});

test('с исключениями отбор остаётся повторяемым', () => {
  const exceptions = [exceptionFixture(), exceptionFixture({ id: 'E2', reviewBy: '2026-09-14' })];
  const covered = findingFixture({ id: 'A', policy: 'soft-rule' });
  const plain = findingFixture({ id: 'B', policy: 'soft-rule', files: ['apps/web/src/y.ts'] });
  const forward = decideWith(exceptions, [covered, plain]).verdicts.map(
    (verdict) => `${verdict.finding.id}:${verdict.decision}`,
  );
  const backward = decideWith(exceptions, [plain, covered]).verdicts.map(
    (verdict) => `${verdict.finding.id}:${verdict.decision}`,
  );
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ['A:rejected', 'B:selected']);
});
