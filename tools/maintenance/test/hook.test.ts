/**
 * Очередь коммитов и замок прогона.
 *
 * Проверяется не хук (его пишет оболочка и ставит git), а то, ради чего он существует: что очередь
 * забирается целиком и один раз, а замок не пускает второй прогон. Оба свойства держат систему в
 * дереве, где коммитят несколько сессий сразу, — и оба молчаливы при поломке: очередь просто
 * потеряется, а второй прогон продолжит чужой проход как свой.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { enqueueCommit, lockHolder, queuedCommits, takeLock, takeQueue } from '../cli/hook.ts';
import type { Workspace } from '../state/workspace.ts';

function sandbox(): { workspace: Workspace; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'hook-'));
  const workspace = {
    home: root,
    root,
    state: path.join(root, 'state'),
    results: path.join(root, 'results'),
    reports: path.join(root, 'reports'),
    context: path.join(root, 'context'),
    checkpoints: path.join(root, 'checkpoints'),
    tmp: path.join(root, 'tmp'),
    taskFile: path.join(root, 'task.md'),
  } as Workspace;
  return { workspace, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('очередь забирается целиком и один раз', () => {
  const box = sandbox();
  try {
    enqueueCommit(box.workspace, 'aaa111');
    enqueueCommit(box.workspace, 'bbb222');
    assert.deepEqual(queuedCommits(box.workspace), ['aaa111', 'bbb222']);

    assert.deepEqual(takeQueue(box.workspace), ['aaa111', 'bbb222']);
    // Второй прогон не должен разбирать то же самое ещё раз.
    assert.deepEqual(queuedCommits(box.workspace), []);

    // Пока прогон идёт, в очередь капают новые коммиты — они ждут следующего.
    enqueueCommit(box.workspace, 'ccc333');
    assert.deepEqual(takeQueue(box.workspace), ['ccc333']);
  } finally {
    box.dispose();
  }
});

test('замок держит один прогон и называет занявшего', () => {
  const box = sandbox();
  try {
    const first = takeLock(box.workspace);
    assert.notEqual(first, null);
    assert.equal(lockHolder(box.workspace)?.pid, process.pid);

    // Второй прогон обязан уйти, а не ждать: очередь никуда не денется.
    assert.equal(takeLock(box.workspace), null);

    first?.release();
    const second = takeLock(box.workspace);
    assert.notEqual(second, null);
    second?.release();
    assert.equal(lockHolder(box.workspace), null);
  } finally {
    box.dispose();
  }
});

test('замок мёртвого процесса не держит прогон вечно', () => {
  const box = sandbox();
  try {
    const lock = takeLock(box.workspace);
    lock?.release();
    // Процесса с таким номером заведомо нет: обрыв по питанию выглядит ровно так.
    writeFileSync(
      path.join(box.workspace.state, 'run.lock'),
      JSON.stringify({ pid: 2 ** 22, at: new Date().toISOString() }),
      'utf8',
    );
    const taken = takeLock(box.workspace);
    assert.notEqual(taken, null);
    taken?.release();
  } finally {
    box.dispose();
  }
});
