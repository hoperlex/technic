/**
 * Снимок архитектуры: проверяется не хранение, а ЧЕСТНОСТЬ ОЦЕНКИ.
 *
 * Главный тест этапа — «нейтральная метрика не объявляется улучшением»: ради него снимок и
 * написан. Число файлов, строк и связей растёт вместе с продуктом, и отчёт, который называет такой
 * рост ухудшением (или падение — победой), заставляет людей отчитываться по метрике, которая
 * ничего не значит. Остальные тесты стерегут вторую беду — потерю истории: обрезку не с того
 * конца и молчаливое обнуление испорченного файла.
 *
 * Факты собираются заготовкой, а не реальным прогоном: тест обязан проверять перевод фактов в
 * снимок, а не сегодняшнее состояние репозитория.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import {
  JsonSnapshotStore,
  NOT_MEASURED,
  diffSnapshots,
  renderDelta,
  snapshotOf,
  type ArchitectureSnapshot,
} from '../state/snapshot.ts';
import type { DependencyViolation, FileMetrics, LintFacts, ProjectFacts } from '../core/facts.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

function ensureTmp(): string {
  // Заготовки живут в рабочем каталоге прогона, а не в системном временном: он вне истории, но
  // виден человеку, если тест упал и файл захотелось открыть.
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  return base;
}

function withTmpDir(body: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(ensureTmp(), 'snapshot-'));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function violation(
  kind: DependencyViolation['kind'],
  from: string,
  to: string,
): DependencyViolation {
  return { kind, from, to, files: [`${from}/x.ts`], severity: 'hard', detail: 'подробность' };
}

function lintFixture(over: Partial<LintFacts> = {}): LintFacts {
  return {
    ok: true,
    measured: true,
    durationMs: 10,
    summary: '0 ошибок, 3 предупреждений',
    errors: 0,
    warnings: 3,
    byRule: { 'no-unused-vars': 2, complexity: 1 },
    messages: [],
    ...over,
  };
}

function factsFixture(over: Partial<ProjectFacts> = {}): ProjectFacts {
  const largest: FileMetrics[] = Array.from({ length: 12 }, (_, index) => ({
    file: `apps/api/src/f${index}.ts`,
    lines: 500 - index,
    codeLines: 400 - index,
    commentLines: 100,
  }));
  return {
    collectedAt: '2026-09-14T10:00:00.000Z',
    root: '/repo',
    git: {
      head: 'a1b2c3d4e5f6a7b8c9d0',
      branch: 'main',
      clean: true,
      changedFiles: [],
      untrackedFiles: [],
    },
    lint: lintFixture(),
    typecheck: { ok: true, durationMs: 5, summary: 'типы сходятся' },
    tests: { ok: true, durationMs: 7, summary: 'зелено' },
    metrics: { files: 812, totalLines: 91_000, largest },
    dependencies: {
      ok: true,
      durationMs: 3,
      summary: 'граф собран',
      modules: 6,
      edges: 2100,
      violations: [
        violation('cycle', 'a', 'b'),
        violation('cycle', 'c', 'd'),
        violation('direction', 'web', 'api'),
        violation('unknown-package', 'x', 'y'),
      ],
    },
    relevance: { domains: [], policies: [], adr: [], surfaces: [] },
    scopeFiles: [],
    ...over,
  };
}

function snapshotFixture(over: Partial<ArchitectureSnapshot> = {}): ArchitectureSnapshot {
  return { ...snapshotOf(factsFixture(), { version: '0.1.82.0191' }), ...over };
}

test('снимок собирается из фактов: числа, вершина, версия и верхушка крупнейших файлов', () => {
  const snapshot = snapshotOf(factsFixture(), { version: '0.1.82.0191' });

  assert.equal(snapshot.takenAt, '2026-09-14T10:00:00.000Z');
  assert.equal(snapshot.head, 'a1b2c3d4e5f6a7b8c9d0');
  assert.equal(snapshot.version, '0.1.82.0191');
  assert.equal(snapshot.files, 812);
  assert.equal(snapshot.codeLines, 91_000);
  assert.equal(snapshot.edges, 2100);
  assert.equal(snapshot.lintErrors, 0);
  assert.equal(snapshot.lintWarnings, 3);
  assert.deepEqual(snapshot.warningsByRule, { 'no-unused-vars': 2, complexity: 1 });
  // Верхушка обрезана: снимок не каталог файлов, полный список лежит в фактах того прогона.
  assert.equal(snapshot.largestFiles.length, 10);
  assert.deepEqual(snapshot.largestFiles[0], { file: 'apps/api/src/f0.ts', codeLines: 400 });
});

test('циклы и нарушения направления считаются раздельно, поломка графа — ни туда ни сюда', () => {
  // `unknown-package` — свойство настройки графа, а не дерева: попав в любой из счётчиков, он
  // показал бы ухудшение архитектуры там, где сменился конфиг.
  const snapshot = snapshotOf(factsFixture(), { version: null });
  assert.equal(snapshot.cycles, 2);
  assert.equal(snapshot.directionViolations, 1);
  assert.equal(snapshot.version, null);
});

test('несработавший линт записывается как «не измерено», а не нулём', () => {
  // Ноль у несработавшего линта — это фальшивое улучшение ровно в тот прогон, когда сломалась
  // проверка. Самая дорогая ошибка снимка, потому что выглядит она как успех.
  const facts = factsFixture({
    lint: lintFixture({ ok: false, measured: false, errors: 0, warnings: 0, byRule: {} }),
  });
  const snapshot = snapshotOf(facts, { version: null });
  assert.equal(snapshot.lintErrors, NOT_MEASURED);
  assert.equal(snapshot.lintWarnings, NOT_MEASURED);
  assert.deepEqual(snapshot.warningsByRule, {});

  const delta = diffSnapshots(snapshotFixture({ lintErrors: 4, lintWarnings: 9 }), snapshot);
  const touched = delta.changes.filter((change) => change.metric.includes('линт'));
  assert.deepEqual(touched, []);
  // И разбивка по правилам тоже молчит: пустой набор правил не означает «всё починили».
  assert.deepEqual(
    delta.changes.filter((change) => change.metric.includes('правилу')),
    [],
  );
});

test('дельта считает направление у метрик, где оно есть', () => {
  const before = snapshotFixture({ cycles: 3, directionViolations: 1, lintErrors: 0 });
  const after = snapshotFixture({ cycles: 1, directionViolations: 4, lintErrors: 2 });
  const changes = new Map(diffSnapshots(before, after).changes.map((c) => [c.metric, c]));

  assert.equal(changes.get('циклов зависимостей')?.better, true);
  assert.equal(changes.get('циклов зависимостей')?.before, 3);
  assert.equal(changes.get('циклов зависимостей')?.after, 1);
  assert.equal(changes.get('нарушений направления')?.better, false);
  assert.equal(changes.get('ошибок линта')?.better, false);
});

test('рост циклов и нарушений — ухудшение, падение — улучшение, и наоборот тоже', () => {
  const grown = diffSnapshots(snapshotFixture({ cycles: 0 }), snapshotFixture({ cycles: 5 }));
  assert.equal(grown.changes[0]?.better, false);
  const cured = diffSnapshots(snapshotFixture({ cycles: 5 }), snapshotFixture({ cycles: 0 }));
  assert.equal(cured.changes[0]?.better, true);
});

test('нейтральные метрики не объявляются ни улучшением, ни ухудшением', () => {
  // Рост числа файлов, строк и связей — цена роста продукта; общее число предупреждений зависит
  // от набора включённых правил; размер крупнейшего файла оценивать запрещено правилами проекта.
  const before = snapshotFixture();
  const after = snapshotFixture({
    files: before.files + 40,
    codeLines: before.codeLines + 5000,
    edges: before.edges + 300,
    lintWarnings: before.lintWarnings + 12,
    largestFiles: [{ file: 'apps/api/src/f0.ts', codeLines: 900 }],
  });
  const changes = new Map(diffSnapshots(before, after).changes.map((c) => [c.metric, c]));

  for (const metric of [
    'файлов в дереве',
    'строк всего',
    'связей между файлами',
    'предупреждений линта, всего',
    'строк в самом большом файле',
  ]) {
    assert.ok(changes.has(metric), `метрика «${metric}» пропала из дельты`);
    assert.equal(changes.get(metric)?.better, null, `метрике «${metric}» приписали направление`);
  }
});

test('совпавшие метрики в дельту не попадают', () => {
  const delta = diffSnapshots(snapshotFixture(), snapshotFixture());
  assert.deepEqual(delta.changes, []);
});

test('по правилу линта направление есть только там, где правило действовало в обоих снимках', () => {
  const before = snapshotFixture({
    lintWarnings: 10,
    warningsByRule: { complexity: 4, 'no-unused-vars': 3, 'old-rule': 3 },
  });
  const after = snapshotFixture({
    lintWarnings: 12,
    warningsByRule: { complexity: 7, 'no-unused-vars': 1, 'fresh-rule': 4 },
  });
  const changes = new Map(diffSnapshots(before, after).changes.map((c) => [c.metric, c]));

  assert.equal(changes.get('замечаний по правилу complexity')?.better, false);
  assert.equal(changes.get('замечаний по правилу no-unused-vars')?.better, true);
  // Новое правило приносит замечания включением, а не порчей кода.
  assert.equal(changes.get('замечаний по правилу fresh-rule (правило новое)')?.better, null);
  // Исчезнувшее правило неотличимо от выключенного — записать его в победы нельзя.
  assert.equal(changes.get('замечаний по правилу old-rule (правило исчезло)')?.better, null);
  assert.equal(changes.get('замечаний по правилу old-rule (правило исчезло)')?.after, 0);
});

test(
  'история обрезается по лимиту, и обрезается старое',
  withTmpDir(async (dir) => {
    const file = path.join(dir, 'snapshots.json');
    const store = new JsonSnapshotStore(file, 3);
    for (let index = 0; index < 5; index += 1) {
      await store.append(snapshotFixture({ head: `head-${index}`, cycles: index }));
    }
    const history = await store.load();
    assert.equal(history.length, 3);
    // Ценность истории — в хвосте: последние прогоны отвечают на вопрос «стало лучше или хуже».
    assert.deepEqual(
      history.map((snapshot) => snapshot.head),
      ['head-2', 'head-3', 'head-4'],
    );
  }),
);

test(
  'снимок переживает запись и чтение, а запись не оставляет полуфайла',
  withTmpDir(async (dir) => {
    const file = path.join(dir, 'snapshots.json');
    const store = new JsonSnapshotStore(file);
    // Истории ещё нет — это первый прогон, а не сбой.
    assert.deepEqual(await store.load(), []);

    const snapshot = snapshotOf(factsFixture(), { version: '0.1.82.0191' });
    await store.append(snapshot);
    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], snapshot);
    // Временный файл переименован, а не оставлен рядом: иначе обрыв прогона копил бы мусор.
    assert.deepEqual(readdirSync(dir), ['snapshots.json']);
    assert.ok(!existsSync(`${file}.tmp`));

    // Второй прогон дописывает, а не затирает: ради этого снимок и заведён.
    await store.append(snapshotFixture({ head: 'b' + snapshot.head.slice(1), cycles: 0 }));
    const both = await store.load();
    assert.equal(both.length, 2);
    assert.equal(both[0]?.cycles, 2);
    assert.equal(both[1]?.cycles, 0);
  }),
);

test(
  'испорченный файл истории роняет загрузку и не затирается новым снимком',
  withTmpDir(async (dir) => {
    // Пустая история вместо испорченной — это стёртая память системы без единого сообщения, а
    // запись поверх нечитаемого файла закрыла бы поломку собой.
    const file = path.join(dir, 'snapshots.json');
    await writeFile(file, '[ это не json', 'utf8');
    const store = new JsonSnapshotStore(file);
    await assert.rejects(() => store.load(), /не читается как JSON/);
    await assert.rejects(() => store.append(snapshotFixture()), /не читается как JSON/);
    assert.equal(await readFile(file, 'utf8'), '[ это не json');
  }),
);

test(
  'история не массивом и снимок без числа называются по месту',
  withTmpDir(async (dir) => {
    const object = path.join(dir, 'object.json');
    await writeFile(object, '{"takenAt":"2026-09-14T10:00:00.000Z"}', 'utf8');
    await assert.rejects(() => new JsonSnapshotStore(object).load(), /должна быть массивом/);

    const broken = path.join(dir, 'broken.json');
    const snapshot = snapshotFixture();
    const { cycles: _cycles, ...withoutCycles } = snapshot;
    await writeFile(broken, JSON.stringify([withoutCycles]), 'utf8');
    await assert.rejects(
      () => new JsonSnapshotStore(broken).load(),
      /\[0\]\.cycles: ожидалось число/,
    );
  }),
);

test('предел истории меньше одного — ошибка, а не молчаливая свалка', () => {
  assert.throws(() => new JsonSnapshotStore('/repo/x.json', 0), /больше нуля/);
  assert.throws(() => new JsonSnapshotStore('/repo/x.json', 1.5), /больше нуля/);
});

test('renderDelta даёт читаемую таблицу, оценённое — выше неоценённого', () => {
  const before = snapshotFixture({ cycles: 3, files: 800 });
  const after = snapshotFixture({
    cycles: 1,
    files: 840,
    version: '0.1.83.0192',
    takenAt: '2026-09-15T10:00:00.000Z',
  });
  const text = renderDelta(diffSnapshots(before, after));

  assert.match(text, /## Дельта архитектуры/);
  assert.match(text, /версия 0\.1\.82\.0191/);
  assert.match(text, /версия 0\.1\.83\.0192/);
  assert.match(text, /Итог: лучше — 1, хуже — 0, без оценки — 1\./);
  assert.match(text, /\| циклов зависимостей \| 3 \| 1 \| -2 \| лучше \|/);
  assert.match(text, /\| файлов в дереве \| 800 \| 840 \| \+40 \| без оценки \|/);
  // Оценённая метрика идёт раньше неоценённой: читателю нужен ответ, а не список чисел.
  assert.ok(text.indexOf('циклов зависимостей') < text.indexOf('файлов в дереве'));
  assert.ok(text.endsWith('\n'));
});

test('renderDelta не падает, когда сравнивать нечего', () => {
  // Первый прогон сравнивает снимок сам с собой: истории ещё нет. Это ответ, а не пустой отчёт.
  const only = snapshotFixture({ version: null });
  const text = renderDelta(diffSnapshots(only, only));
  assert.match(text, /Изменений нет/);
  assert.match(text, /версия неизвестна/);
  assert.doesNotMatch(text, /\| Метрика \|/);
});
