/**
 * Отчёт исполнителя и счёт изменённых строк.
 *
 * Ревизия нашла здесь две дыры разом, и обе жили в слое команд, где тестов не было вовсе: строки
 * партии не считались никогда (лимит объёма в политике стоял, а сработать не мог), а отчёт
 * разбирали три разных куска кода по-разному — в тяжёлом окне подмена «названного исполнителем» на
 * «изменённое на диске» выключала замок поведения целиком.
 *
 * Поэтому тесты проверяют не форму разбора, а именно эти свойства: отличается ли «отчёта нет» от
 * «отчёт испорчен», и честны ли числа, на которые опирается бюджет.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EMPTY_FIX_REPORT, countSevere, parseFixReport } from '../core/fix-report.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

test('испорченный отчёт — это не «отчёта нет»', () => {
  const broken = parseFixReport('{ applied: [ сломано');
  // Разница решающая: отчёта нет у ручного адаптера сплошь и рядом, а испорченный отчёт означает,
  // что исполнитель работал, и верить его границам нельзя.
  assert.equal(broken.present, true);
  assert.equal(broken.problems.length, 1);
  assert.equal(EMPTY_FIX_REPORT.present, false);
});

test('названные исполнителем файлы собираются из всех правок', () => {
  const report = parseFixReport(
    JSON.stringify({
      applied: [
        { id: 'F1', files: ['a.ts', 'b.ts'] },
        { id: 'F2', files: ['b.ts'] },
      ],
    }),
  );
  assert.deepEqual([...report.claimed].sort(), ['a.ts', 'b.ts']);
  assert.deepEqual(report.applied, ['F1', 'F2']);
});

test('поле не того вида не роняет разбор, но называется проблемой', () => {
  const report = parseFixReport(JSON.stringify({ applied: 'ничего не делал' }));
  assert.equal(report.claimed.length, 0);
  assert.match(report.problems.join(' '), /applied/);
});

test('серьёзными считаются только high: иначе условие «создаёт больше, чем чинит» глохнет', () => {
  const report = parseFixReport(
    JSON.stringify({ newFindings: [{ severity: 'high' }, { severity: 'low' }, {}] }),
  );
  assert.equal(countSevere(report.newSeverities), 1);
  assert.equal(report.newSeverities.length, 3);
});

function repoWith(files: Record<string, string>): string {
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'lines-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'начало');
  return dir;
}

test('изменённые строки считаются по контрольной точке, а не по словам исполнителя', async () => {
  const dir = repoWith({ 'a.ts': 'один\nдва\nтри\n' });
  try {
    const transaction = new FileCheckpointTransaction(dir, path.join(dir, '.checkpoints'));
    const id = await transaction.createCheckpoint(['a.ts']);
    writeFileSync(path.join(dir, 'a.ts'), 'один\nДВА\nтри\n', 'utf8');
    // Одна строка заменена: одна удалена и одна добавлена. Для бюджета важен объём работы, а не
    // итоговый прирост — переписанная строка стоит проверяющему столько же, сколько новая.
    assert.equal(transaction.changedLinesIn(id), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('вставка не засчитывается как переписанный хвост файла', async () => {
  const dir = repoWith({ 'a.ts': 'один\nдва\nтри\nчетыре\nпять\n' });
  try {
    const transaction = new FileCheckpointTransaction(dir, path.join(dir, '.checkpoints'));
    const id = await transaction.createCheckpoint(['a.ts']);
    writeFileSync(path.join(dir, 'a.ts'), 'ноль\nодин\nдва\nтри\nчетыре\nпять\n', 'utf8');
    // Наивный попарный счёт дал бы шесть: сдвиг делает все строки «непохожими». Считает git, и
    // ошибка была бы всегда в сторону завышения, то есть бюджет исчерпывался бы раньше времени.
    assert.equal(transaction.changedLinesIn(id), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('созданный и удалённый файлы считаются целиком', async () => {
  const dir = repoWith({ 'old.ts': 'один\nдва\n' });
  try {
    const transaction = new FileCheckpointTransaction(dir, path.join(dir, '.checkpoints'));
    const id = await transaction.createCheckpoint(['old.ts', 'new.ts']);
    rmSync(path.join(dir, 'old.ts'));
    writeFileSync(path.join(dir, 'new.ts'), 'а\nб\nв\n', 'utf8');
    assert.equal(transaction.changedLinesIn(id), 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('нетронутая партия даёт ноль строк', async () => {
  const dir = repoWith({ 'a.ts': 'один\n' });
  try {
    const transaction = new FileCheckpointTransaction(dir, path.join(dir, '.checkpoints'));
    const id = await transaction.createCheckpoint(['a.ts']);
    assert.equal(transaction.changedLinesIn(id), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
