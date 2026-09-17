/**
 * Передача принятой партии из цеха в историю.
 *
 * ЭТО САМОЕ ОПАСНОЕ МЕСТО СИСТЕМЫ: единственное, где она двигает ссылку ветки. Ошибка здесь не
 * «неверный отчёт», а потерянный чужой коммит — то, что не чинится перезапуском. Поэтому проверка
 * идёт на настоящем репозитории во временном каталоге, а не на заглушках: сравнение ссылки с
 * ожидаемым значением и перенос коммита — поведение git, и подделывать его бессмысленно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { run } from '../analyzers/run.ts';
import { handOff } from '../git/handoff.ts';

interface Bench {
  readonly root: string;
  readonly tree: string;
  readonly base: string;
  dispose(): void;
}

/** Репозиторий с одним коммитом и цехом от его вершины. */
function bench(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'handoff-'));
  run(root, ['git', 'init', '--initial-branch=main']);
  run(root, ['git', 'config', 'user.email', 'test@example.com']);
  run(root, ['git', 'config', 'user.name', 'Проверка']);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.ts'), 'было\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'b.ts'), 'сосед\n', 'utf8');
  run(root, ['git', 'add', '-A']);
  run(root, ['git', 'commit', '-m', 'первый']);
  const base = run(root, ['git', 'rev-parse', 'HEAD']).stdout.trim();

  // Дерево цеха лежит ВНЕ репозитория: внутри оно было бы неотслеживаемым каталогом и портило бы
  // чистоту рабочего дерева — ровно то, чем в бою занимается `.maintenance/` в `.gitignore`.
  const tree = mkdtempSync(path.join(tmpdir(), 'handoff-tree-'));
  rmSync(tree, { recursive: true, force: true });
  run(root, ['git', 'worktree', 'add', '--detach', tree, base]);
  return {
    root,
    tree,
    base,
    dispose: () => {
      rmSync(tree, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function headOf(root: string): string {
  return run(root, ['git', 'rev-parse', 'refs/heads/main']).stdout.trim();
}

test('принятая правка ложится коммитом, а чистый файл рабочего дерева подтягивается', () => {
  const box = bench();
  try {
    writeFileSync(path.join(box.tree, 'src', 'a.ts'), 'стало\n', 'utf8');
    const result = handOff({
      root: box.root,
      tree: box.tree,
      base: box.base,
      files: ['src/a.ts'],
      message: 'правка системы',
      keepRef: 'refs/maintenance/проба',
    });

    assert.equal(result.problem, null);
    assert.equal(result.branch, 'main');
    assert.equal(headOf(box.root), result.sha);
    // Рабочее дерево обязано совпасть с новой вершиной, иначе git покажет правку наоборот.
    assert.equal(readFileSync(path.join(box.root, 'src', 'a.ts'), 'utf8'), 'стало\n');
    assert.deepEqual([...result.synced], ['src/a.ts']);
    assert.equal(run(box.root, ['git', 'status', '--porcelain']).stdout.trim(), '');
    // Служебная ссылка снимается: коммит уже держит ветка.
    assert.notEqual(run(box.root, ['git', 'rev-parse', 'refs/maintenance/проба']).code, 0);
  } finally {
    box.dispose();
  }
});

test('файл, занятый чужой работой, не трогается и называется человеку', () => {
  const box = bench();
  try {
    // Чужая незакоммиченная правка в том же файле — обычное дело в общем дереве.
    writeFileSync(path.join(box.root, 'src', 'a.ts'), 'чужое\n', 'utf8');
    writeFileSync(path.join(box.tree, 'src', 'a.ts'), 'наше\n', 'utf8');

    const result = handOff({
      root: box.root,
      tree: box.tree,
      base: box.base,
      files: ['src/a.ts'],
      message: 'правка системы',
      keepRef: 'refs/maintenance/проба',
    });

    assert.equal(result.problem, null);
    assert.deepEqual([...result.busy], ['src/a.ts']);
    assert.deepEqual([...result.synced], []);
    // Главное: чужая строка осталась на месте, хотя коммит прошёл.
    assert.equal(readFileSync(path.join(box.root, 'src', 'a.ts'), 'utf8'), 'чужое\n');
  } finally {
    box.dispose();
  }
});

test('ушедшая вперёд ветка не затирается: коммит переносится на новую вершину', () => {
  const box = bench();
  try {
    writeFileSync(path.join(box.tree, 'src', 'a.ts'), 'наше\n', 'utf8');
    // Чужой коммит, случившийся ровно пока агент работал.
    writeFileSync(path.join(box.root, 'src', 'b.ts'), 'чужая работа\n', 'utf8');
    run(box.root, ['git', 'commit', '-am', 'чужой коммит']);
    const theirs = headOf(box.root);

    const result = handOff({
      root: box.root,
      tree: box.tree,
      base: box.base,
      files: ['src/a.ts'],
      message: 'правка системы',
      keepRef: 'refs/maintenance/проба',
    });

    assert.equal(result.problem, null);
    assert.equal(headOf(box.root), result.sha);
    // Чужой коммит обязан остаться предком нашего, а не исчезнуть.
    const ancestor = run(box.root, ['git', 'merge-base', '--is-ancestor', theirs, 'HEAD']);
    assert.equal(ancestor.code, 0);
    assert.equal(readFileSync(path.join(box.root, 'src', 'b.ts'), 'utf8'), 'чужая работа\n');
    assert.equal(readFileSync(path.join(box.root, 'src', 'a.ts'), 'utf8'), 'наше\n');
  } finally {
    box.dispose();
  }
});

test('удалённый партией файл исчезает и из рабочего дерева', () => {
  const box = bench();
  try {
    rmSync(path.join(box.tree, 'src', 'b.ts'));
    const result = handOff({
      root: box.root,
      tree: box.tree,
      base: box.base,
      files: ['src/b.ts'],
      message: 'снят мёртвый файл',
      keepRef: 'refs/maintenance/проба',
    });

    assert.equal(result.problem, null);
    assert.deepEqual([...result.synced], ['src/b.ts']);
    assert.equal(run(box.root, ['git', 'status', '--porcelain']).stdout.trim(), '');
  } finally {
    box.dispose();
  }
});
