/**
 * Изоляция проверки в отдельном дереве git.
 *
 * Главное свойство, которое здесь проверяется: в изолированном дереве видна база плюс файлы
 * партии — и НИЧЕГО больше. Чужая незавершённая работа, лежащая рядом в общем дереве, туда не
 * попадает: именно из-за неё ворота краснели по чужой причине и откатывали верную правку.
 *
 * Второе свойство, не менее важное: ни один тест здесь не имеет права тронуть основное дерево.
 * Поэтому каждый работает во временном репозитории, а проверка «основное дерево цело» вынесена в
 * отдельный тест — на живом прогоне цена ошибки здесь равна чужому рабочему дню.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createIsolatedTree } from '../git/worktree.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const TMP = path.join(REPO, '.maintenance', 'tmp');

function git(dir: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { encoding: 'utf8' },
  );
  return result.stdout ?? '';
}

function makeRepo(files: Record<string, string>): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, 'wt-repo-'));
  for (const [name, body] of Object.entries(files)) write(dir, name, body);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'начало');
  return dir;
}

function write(dir: string, file: string, body: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
}

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

function home(dir: string): string {
  return path.join(dir, '.maintenance', 'trees');
}

test('дерево собирается от указанного sha, а не от текущего HEAD', () => {
  const dir = makeRepo({ 'a.ts': 'первая версия\n' });
  try {
    const first = git(dir, 'rev-parse', 'HEAD').trim();
    write(dir, 'a.ts', 'вторая версия\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'вторая');

    const tree = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: [],
      linkPaths: [],
      baseRef: first,
    });
    try {
      assert.equal(tree.base, first);
      assert.equal(read(tree.path, 'a.ts'), 'первая версия\n');
    } finally {
      tree.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл партии виден в версии партии, а не в версии базы', () => {
  const dir = makeRepo({ 'a.ts': 'в коммите\n' });
  try {
    write(dir, 'a.ts', 'правка партии\n');
    const tree = createIsolatedTree({ root: dir, home: home(dir), files: ['a.ts'], linkPaths: [] });
    try {
      assert.equal(read(tree.path, 'a.ts'), 'правка партии\n');
    } finally {
      tree.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл, которого в базе не было, в изолированном дереве появляется', () => {
  const dir = makeRepo({ 'a.ts': 'в коммите\n' });
  try {
    // Так выглядит правка, создающая новую сущность: в HEAD файла нет вовсе.
    write(dir, 'src/новый.ts', 'создан партией\n');
    const tree = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: ['src/новый.ts'],
      linkPaths: [],
    });
    try {
      assert.equal(read(tree.path, 'src/новый.ts'), 'создан партией\n');
    } finally {
      tree.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('удалённый партией файл в изолированном дереве исчезает', () => {
  const dir = makeRepo({ 'a.ts': 'остаётся\n', 'лишний.ts': 'удаляется партией\n' });
  try {
    rmSync(path.join(dir, 'лишний.ts'));
    const tree = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: ['лишний.ts'],
      linkPaths: [],
    });
    try {
      // Иначе ворота судили бы код, который партия как раз и убрала, — и краснели бы на нём.
      assert.equal(existsSync(path.join(tree.path, 'лишний.ts')), false);
      assert.equal(read(tree.path, 'a.ts'), 'остаётся\n');
    } finally {
      tree.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('чужая правка основного дерева в изолированное не попадает', () => {
  const dir = makeRepo({ 'a.ts': 'в коммите\n', 'чужое.ts': 'в коммите\n' });
  try {
    write(dir, 'a.ts', 'правка партии\n');
    // Параллельная работа человека: файл изменён, но партия его не называла. Раньше именно такая
    // правка красила ворота и откатывала верную работу системы.
    write(dir, 'чужое.ts', 'чужая незавершённая работа, ломающая сборку\n');
    write(dir, 'чужое-новое.ts', 'чужой черновик\n');

    const tree = createIsolatedTree({ root: dir, home: home(dir), files: ['a.ts'], linkPaths: [] });
    try {
      assert.equal(read(tree.path, 'a.ts'), 'правка партии\n');
      assert.equal(read(tree.path, 'чужое.ts'), 'в коммите\n');
      assert.equal(existsSync(path.join(tree.path, 'чужое-новое.ts')), false);
    } finally {
      tree.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('подложенный каталог остаётся ссылкой, а ссылка на свой пакет ведёт внутрь изолированного дерева', () => {
  const dir = makeRepo({ 'packages/pkg/index.ts': 'в коммите\n', 'a.ts': 'a\n' });
  try {
    // Слепок того, как pnpm раскладывает зависимости: чужой пакет телом, свой — относительной
    // ссылкой. Именно эта ссылка и утаскивала проверку обратно в грязное основное дерево.
    write(dir, 'node_modules/чужой/index.js', 'тело зависимости\n');
    mkdirSync(path.join(dir, 'node_modules', '@scope'), { recursive: true });
    symlinkSync('../../packages/pkg', path.join(dir, 'node_modules', '@scope', 'pkg'));
    write(dir, 'packages/pkg/index.ts', 'грязная правка основного дерева\n');

    const tree = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: [],
      linkPaths: ['node_modules'],
    });
    try {
      const dependency = path.join(tree.path, 'node_modules', 'чужой');
      assert.equal(lstatSync(dependency).isSymbolicLink(), true, 'чужой пакет копировать незачем');

      const own = path.join(tree.path, 'node_modules', '@scope', 'pkg');
      assert.equal(realpathSync(own), realpathSync(path.join(tree.path, 'packages', 'pkg')));
      assert.equal(readFileSync(path.join(own, 'index.ts'), 'utf8'), 'в коммите\n');
    } finally {
      tree.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose убирает дерево и не трогает основное', () => {
  const dir = makeRepo({ 'a.ts': 'в коммите\n', 'чужое.ts': 'в коммите\n' });
  try {
    write(dir, 'a.ts', 'правка партии\n');
    write(dir, 'чужое.ts', 'чужая работа\n');
    const before = git(dir, 'status', '--porcelain');

    const tree = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: ['a.ts'],
      linkPaths: [],
    });
    tree.dispose();
    tree.dispose(); // Повторный вызов не должен ни падать, ни сносить чужое дерево.

    assert.equal(existsSync(tree.path), false);
    assert.equal(git(dir, 'worktree', 'list').includes(tree.path), false);
    // Главное: незакоммиченная работа в основном дереве осталась ровно такой, какой была.
    assert.equal(read(dir, 'a.ts'), 'правка партии\n');
    assert.equal(read(dir, 'чужое.ts'), 'чужая работа\n');
    assert.equal(git(dir, 'status', '--porcelain'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('забытое дерево упавшего прогона не мешает создать новое', () => {
  const dir = makeRepo({ 'a.ts': 'в коммите\n' });
  try {
    const abandoned = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: [],
      linkPaths: [],
    });
    // Так выглядит прогон, убитый по Ctrl+C: каталога нет, запись git о дереве осталась.
    rmSync(abandoned.path, { recursive: true, force: true });
    assert.ok(git(dir, 'worktree', 'list').includes(abandoned.path));

    const next = createIsolatedTree({ root: dir, home: home(dir), files: [], linkPaths: [] });
    try {
      assert.equal(read(next.path, 'a.ts'), 'в коммите\n');
      // Запись о забытом дереве снята: иначе они копятся до первой ошибки на ровном месте.
      assert.equal(git(dir, 'worktree', 'list').includes(abandoned.path), false);
    } finally {
      next.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('два дерева живут рядом и не мешают друг другу', () => {
  const dir = makeRepo({ 'a.ts': 'в коммите\n' });
  try {
    write(dir, 'a.ts', 'правка первой партии\n');
    const first = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: ['a.ts'],
      linkPaths: [],
    });
    write(dir, 'a.ts', 'правка второй партии\n');
    const second = createIsolatedTree({
      root: dir,
      home: home(dir),
      files: ['a.ts'],
      linkPaths: [],
    });
    try {
      assert.notEqual(first.path, second.path);
      assert.equal(read(first.path, 'a.ts'), 'правка первой партии\n');
      assert.equal(read(second.path, 'a.ts'), 'правка второй партии\n');
      // Снос одного дерева не должен задевать соседнее: прогоны идут параллельно.
      first.dispose();
      assert.equal(read(second.path, 'a.ts'), 'правка второй партии\n');
    } finally {
      first.dispose();
      second.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
