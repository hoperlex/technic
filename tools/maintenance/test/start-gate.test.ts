/**
 * Ворота старта: что именно запрещает начинать прогон, а что только оговаривает.
 *
 * Проверяется не «работает ли функция», а те решения, ошибка в каждом из которых стоит прогона.
 * Слишком строгое правило (запрет на грязное дерево) делает систему неприменимой на общем дереве —
 * она не запустится ни разу, и это будет выглядеть как её поломка. Слишком мягкое пропускает старт
 * с красной вершины, и тогда откатываются все партии подряд, ни одна из них не виновата, а причину
 * ищут в системе. Поэтому здесь перебираются ВСЕ сочетания признаков против обоих флагов режима, а
 * не удобные случаи.
 *
 * Отдельно проверяется отсутствие тега выпуска: по политике версий теги ведутся только с
 * `0.1.83.0191` и задним числом не ставятся, так что «тега нет» — обычное состояние этого
 * репозитория, и запрет за него закрыл бы обслуживание целиком.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decideStart } from '../core/start-gate.ts';
import type { StartConditions, StartPolicy } from '../core/start-gate.ts';
import { anchorNamed, readReleaseAnchor } from '../project/release-anchor.ts';
import type { ReleaseAnchor } from '../project/release-anchor.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

/** Стартовое состояние мечты: от него отличают по одному признаку, и видно, что именно решило. */
function conditions(overrides: Partial<StartConditions> = {}): StartConditions {
  return {
    treeClean: true,
    gatesGreen: true,
    anchorNamed: true,
    foreignWorkInTree: 0,
    ...overrides,
  };
}

const SOFT: StartPolicy = { requireClean: false, requireGreen: false };
const RELEASE: StartPolicy = { requireClean: true, requireGreen: true };
const CLEAN_ONLY: StartPolicy = { requireClean: true, requireGreen: false };
const GREEN_ONLY: StartPolicy = { requireClean: false, requireGreen: true };
const MODES: readonly StartPolicy[] = [SOFT, RELEASE, CLEAN_ONLY, GREEN_ONLY];

/** Есть ли среди причин строка про это. Сверяется смысл ответа, а не его формулировка целиком. */
function mentions(reasons: readonly string[], fragment: string): boolean {
  return reasons.some((reason) => reason.includes(fragment));
}

test('«готово» выдаётся только когда сошлось всё: чисто, зелено, точка названа', () => {
  const decision = decideStart(conditions(), SOFT);
  assert.equal(decision.verdict, 'ready');
  assert.equal(decision.reasons.length, 1);
});

test('красная вершина запрещает старт в любом режиме: смягчать её режиму не дано', () => {
  for (const mode of MODES) {
    const decision = decideStart(conditions({ gatesGreen: false }), mode);
    assert.equal(decision.verdict, 'blocked');
    assert.ok(mentions(decision.reasons, 'красные'));
  }
});

test('непрогнанные ворота — незнание, а не красный цвет: запрет только в строгом режиме', () => {
  const soft = decideStart(conditions({ gatesGreen: null }), SOFT);
  assert.equal(soft.verdict, 'warn');
  assert.ok(mentions(soft.reasons, 'не прогонялись'));

  const strict = decideStart(conditions({ gatesGreen: null }), GREEN_ONLY);
  assert.equal(strict.verdict, 'blocked');
  assert.ok(mentions(strict.reasons, 'требует зелёного старта'));
});

test('грязное дерево предупреждает, а запрещает только там, где чистота затребована', () => {
  const soft = decideStart(conditions({ treeClean: false, foreignWorkInTree: 19 }), SOFT);
  assert.equal(soft.verdict, 'warn');
  // Число чужих файлов названо: человек должен видеть, чего система не тронет при откате.
  assert.ok(mentions(soft.reasons, '19'));

  const strict = decideStart(conditions({ treeClean: false, foreignWorkInTree: 19 }), CLEAN_ONLY);
  assert.equal(strict.verdict, 'blocked');
  assert.ok(mentions(strict.reasons, 'требует чистого дерева'));
});

test('чужая работа рядом сама по себе не запрещает старт', () => {
  const decision = decideStart(conditions({ treeClean: false, foreignWorkInTree: 40 }), GREEN_ONLY);
  assert.equal(decision.verdict, 'warn');
});

test('отрицательный счётчик чужих файлов не попадает в текст причины', () => {
  const decision = decideStart(conditions({ treeClean: false, foreignWorkInTree: -3 }), SOFT);
  assert.equal(decision.verdict, 'warn');
  assert.ok(!mentions(decision.reasons, '-3'));
});

test('«чисто» вместе с чужими файлами — рассогласование сбора, и о нём говорят вслух', () => {
  const decision = decideStart(conditions({ treeClean: true, foreignWorkInTree: 2 }), SOFT);
  assert.equal(decision.verdict, 'warn');
  assert.ok(mentions(decision.reasons, 'противоречат'));
});

test('не названная точка старта предупреждает, но не запрещает ни в одном режиме', () => {
  for (const mode of MODES) {
    const decision = decideStart(conditions({ anchorNamed: false }), mode);
    assert.notEqual(decision.verdict, 'blocked');
    assert.ok(mentions(decision.reasons, 'Стабильная точка не названа'));
  }
});

test('перебор всех сочетаний: запрет ровно там, где красная вершина или нарушен режим', () => {
  const clean = [true, false];
  const gates: readonly (boolean | null)[] = [true, false, null];
  const named = [true, false];
  const foreign = [0, 5];
  let checked = 0;
  for (const treeClean of clean) {
    for (const gatesGreen of gates) {
      for (const isNamed of named) {
        for (const foreignWorkInTree of foreign) {
          for (const mode of MODES) {
            const decision = decideStart(
              { treeClean, gatesGreen, anchorNamed: isNamed, foreignWorkInTree },
              mode,
            );
            const mustBlock =
              gatesGreen === false ||
              (mode.requireGreen && gatesGreen === null) ||
              (mode.requireClean && !treeClean);
            assert.equal(
              decision.verdict === 'blocked',
              mustBlock,
              `сочетание: чисто=${treeClean}, ворота=${String(gatesGreen)}, точка=${isNamed}, ` +
                `чужих=${foreignWorkInTree}, режим=${JSON.stringify(mode)}`,
            );
            // Пустой список причин означал бы вердикт без объяснения — в отчёте это тупик.
            assert.ok(decision.reasons.length > 0);
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 2 * 3 * 2 * 2 * 4);
});

test('«готово» невозможно, пока ворота не прогнаны: непроверенное не выдаётся за зелёное', () => {
  for (const mode of MODES) {
    assert.notEqual(decideStart(conditions({ gatesGreen: null }), mode).verdict, 'ready');
  }
});

/** Якорь без тега: ровно то состояние, в котором живут все выпуски до 0.1.83.0191. */
function anchorWithoutTag(): ReleaseAnchor {
  return {
    version: '0.1.83.0192',
    wellFormed: true,
    tag: null,
    tagOnHead: false,
    commitsSinceTag: null,
    problems: ['Выпуск 0.1.83.0192 ещё не помечен тегом v0.1.83.0192.'],
  };
}

test('отсутствие тега не мешает назвать точку и не запрещает старт', () => {
  const anchor = anchorWithoutTag();
  assert.equal(anchorNamed(anchor), true);
  for (const mode of MODES) {
    const decision = decideStart(conditions({ anchorNamed: anchorNamed(anchor) }), mode);
    assert.notEqual(decision.verdict, 'blocked');
    assert.ok(!mentions(decision.reasons, 'Стабильная точка не названа'));
  }
});

test('сломанная версия — вот что снимает имя с точки старта, а не отсутствие тега', () => {
  const broken: ReleaseAnchor = {
    version: 'мусор',
    wellFormed: false,
    tag: null,
    tagOnHead: false,
    commitsSinceTag: null,
    problems: ['VERSION не соответствует формату.'],
  };
  assert.equal(anchorNamed(broken), false);
  assert.equal(decideStart(conditions({ anchorNamed: false }), SOFT).verdict, 'warn');
});

test('на этом репозитории точка названа версией, и прогон ею не запрещается', () => {
  const anchor = readReleaseAnchor(REPO);
  assert.equal(anchor.wellFormed, true);
  assert.ok(anchor.version !== null);
  // Тег может появиться в любой день выката, поэтому утверждается не его наличие, а то, что
  // система в обоих случаях говорит о нём словами и не превращает его отсутствие в запрет.
  if (anchor.tag === null) assert.ok(mentions(anchor.problems, 'тег'));
  const decision = decideStart(
    conditions({ treeClean: false, anchorNamed: anchorNamed(anchor), foreignWorkInTree: 1 }),
    SOFT,
  );
  assert.notEqual(decision.verdict, 'blocked');
});
