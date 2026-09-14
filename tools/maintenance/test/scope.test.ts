/**
 * Граница инкрементальной области: докуда расширяться и чем при этом ограничиться.
 *
 * Проверяется не «работает ли обход», а ровно те два решения, ошибка в каждом из которых стоит
 * прогона. Недобор — правка в общем месте уходит ревьюеру без единого потребителя, и нарушенная
 * договорённость соседа остаётся невидимой. Перебор — в контекст агента уезжает дерево, и ответ
 * теряет связь с правкой. Поэтому здесь испытываются обе стороны соседства, обрыв по глубине,
 * обрыв по потолку (и то, что обрывается именно дальнее), подбор правил по всей области, судьба
 * файла вне графа и независимость ответа от порядка входа.
 *
 * Граф собирается литералом, а не разбором файлов: предмет проверки — рассуждение об области, и
 * заготовка на диске добавила бы к нему разбор импортов, который проверяется отдельно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIncrementalScope } from '../core/scope.ts';
import type { ArchitecturePolicy, Domain } from '../core/types.ts';

const MONEY = 'apps/web/src/shared/lib/money.ts';
const MODEL = 'apps/web/src/entities/order/model.ts';
const PAGE = 'apps/web/src/pages/OrderPage.tsx';
const FAR = 'apps/web/src/pages/ReportPage.tsx';

/** Цепочка: страница → сущность → общая библиотека, плюс вторая страница на конце цепочки. */
function chain(): Map<string, readonly string[]> {
  return new Map<string, readonly string[]>([
    [PAGE, [MODEL]],
    [FAR, [PAGE]],
    [MODEL, [MONEY]],
    [MONEY, []],
  ]);
}

const DOMAINS: Domain[] = [
  { id: 'заказ', title: 'Заказ', paths: ['apps/web/src/entities/order'], adr: ['adr/0001.md'] },
  { id: 'общее', title: 'Общее', paths: ['apps/web/src/shared'], adr: ['adr/0002.md'] },
  { id: 'страницы', title: 'Страницы', paths: ['apps/web/src/pages'], adr: ['adr/0003.md'] },
];

const POLICIES: ArchitecturePolicy[] = [
  {
    id: 'entities-no-pages',
    title: 'сущность не знает страниц',
    status: 'active',
    severity: 'hard',
    scope: ['apps/web/src/entities/**'],
    enforcedBy: 'eslint',
    adr: ['adr/0010.md'],
    autofix: false,
    rule: 'нижний слой не импортирует верхний',
    exceptionsRequireReason: true,
  },
  {
    id: 'retired-rule',
    title: 'снятое правило',
    status: 'retired',
    severity: 'soft',
    scope: ['apps/web/src/entities/**'],
    enforcedBy: 'eslint',
    adr: ['adr/0011.md'],
    autofix: false,
    rule: 'уже не действует',
    exceptionsRequireReason: false,
  },
  {
    id: 'everywhere',
    title: 'правило без области',
    status: 'active',
    severity: 'soft',
    scope: [],
    enforcedBy: 'human',
    adr: ['adr/0012.md'],
    autofix: false,
    rule: 'действует везде',
    exceptionsRequireReason: false,
  },
];

function scopeOf(
  changedFiles: readonly string[],
  neighbourDepth: number,
  maxFiles = 100,
  graph: ReadonlyMap<string, readonly string[]> = chain(),
) {
  return resolveIncrementalScope({
    changedFiles,
    graph,
    domains: DOMAINS,
    policies: POLICIES,
    neighbourDepth,
    maxFiles,
  });
}

test('сосед считается в обе стороны: и кого файл зовёт, и кто зовёт его', () => {
  const scope = scopeOf([MODEL], 1);
  // Вниз — то, чем сущность пользуется; вверх — страница, которая сломается от правки. Именно
  // верхнего соседа не видно по рёбрам графа, и без него правка выглядит безопасной.
  assert.deepEqual(scope.files, [MONEY, MODEL, PAGE].sort());
  assert.deepEqual(scope.seeds, [MODEL]);
});

test('потребители общего модуля попадают в область, хотя он на них не ссылается', () => {
  const scope = scopeOf([MONEY], 1);
  assert.ok(scope.files.includes(MODEL));
  assert.ok(!scope.files.includes(PAGE));
});

test('глубина 1 не тянет соседей соседей и говорит, что обрезала именно глубина', () => {
  const near = scopeOf([MONEY], 1);
  assert.ok(!near.files.includes(PAGE));
  assert.equal(near.limitedBy, 'depth');

  const deeper = scopeOf([MONEY], 2);
  assert.ok(deeper.files.includes(PAGE));
  assert.equal(deeper.limitedBy, 'depth');

  const whole = scopeOf([MONEY], 3);
  assert.deepEqual(whole.files, [FAR, MODEL, MONEY, PAGE].sort());
  // Связного остатка больше нет: область полна, и ограничивать её было нечем.
  assert.equal(whole.limitedBy, null);
});

test('глубина 0 оставляет только изменённое', () => {
  const scope = scopeOf([MODEL], 0);
  assert.deepEqual(scope.files, [MODEL]);
  assert.equal(scope.limitedBy, 'depth');
});

test('потолок обрезает дальних соседей, а ближние остаются', () => {
  // Потолка хватает на изменённый файл и оба его прямых соседа; второй шаг не помещается.
  const scope = scopeOf([MODEL], 3, 3);
  assert.deepEqual(scope.files, [MONEY, MODEL, PAGE].sort());
  assert.ok(!scope.files.includes(FAR));
  assert.equal(scope.limitedBy, 'maxFiles');
});

test('изменённые файлы не приносятся в жертву потолку', () => {
  // Потолок ограничивает расширение, а не саму правку: выброси систему изменённый файл — и
  // ревьюер не увидит того, что его позвали смотреть.
  const scope = scopeOf([MODEL, PAGE, MONEY], 1, 2);
  assert.deepEqual(scope.files, [MONEY, MODEL, PAGE].sort());
  assert.equal(scope.limitedBy, 'maxFiles');
});

test('правила и решения подбираются по всей области, а не по изменённым файлам', () => {
  const scope = scopeOf([MONEY], 1);
  // Домен соседа взят вместе с его решениями: договорённость, которую ломает правка, записана
  // именно у него.
  assert.deepEqual(scope.domains, ['заказ', 'общее']);
  assert.ok(!scope.domains.includes('страницы'));
  assert.deepEqual(scope.policies, ['entities-no-pages', 'everywhere']);
  assert.deepEqual(scope.adr, ['adr/0001.md', 'adr/0002.md', 'adr/0010.md', 'adr/0012.md']);
});

test('снятое правило в область не попадает', () => {
  const scope = scopeOf([MODEL], 0);
  assert.ok(!scope.policies.includes('retired-rule'));
  assert.ok(!scope.adr.includes('adr/0011.md'));
});

test('изменённый файл вне графа не теряется', () => {
  const scope = scopeOf(['docs/maintenance-framework-plan.md', MODEL], 1);
  // В затравки он не идёт — расширять от него нечего, — но в области остаётся: правка разметки
  // или конфига такая же правка.
  assert.deepEqual(scope.seeds, [MODEL]);
  assert.ok(scope.files.includes('docs/maintenance-framework-plan.md'));
});

test('файл вне графа в одиночку даёт область из себя одного и ничем не ограничен', () => {
  const scope = scopeOf(['docs/plan.md'], 2);
  assert.deepEqual(scope.files, ['docs/plan.md']);
  assert.deepEqual(scope.seeds, []);
  assert.equal(scope.limitedBy, null);
});

test('ответ не зависит от порядка входа и от повторов', () => {
  const straight = resolveIncrementalScope({
    changedFiles: [MONEY, MODEL],
    graph: chain(),
    domains: DOMAINS,
    policies: POLICIES,
    neighbourDepth: 2,
    maxFiles: 100,
  });
  const shuffled = resolveIncrementalScope({
    changedFiles: [MODEL, MONEY, MODEL],
    graph: new Map<string, readonly string[]>([
      [MONEY, []],
      [MODEL, [MONEY]],
      [FAR, [PAGE]],
      [PAGE, [MODEL]],
    ]),
    domains: [...DOMAINS].reverse(),
    policies: [...POLICIES].reverse(),
    neighbourDepth: 2,
    maxFiles: 100,
  });
  assert.deepEqual(shuffled, straight);
});

test('обрезка потолком тоже повторяема при перестановке входа', () => {
  const straight = scopeOf([MODEL], 3, 3);
  const shuffled = scopeOf(
    [MODEL],
    3,
    3,
    new Map<string, readonly string[]>([
      [MODEL, [MONEY]],
      [MONEY, []],
      [FAR, [PAGE]],
      [PAGE, [MODEL]],
    ]),
  );
  assert.deepEqual(shuffled, straight);
});
