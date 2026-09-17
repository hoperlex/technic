/**
 * Доставка задания агенту.
 *
 * Проверяется не «работает ли запуск процесса», а граница между тремя исходами: ответ, ожидание и
 * отказ. Ошибка на этой границе дороже остальных — молчаливый отказ цикл прочтёт как «агент ничего
 * не нашёл» и пойдёт дальше, считая код осмотренным.
 *
 * Настоящий агент здесь не запускается НИКОГДА: тест обязан быть быстрым, воспроизводимым и не
 * зависеть от того, установлен ли внешний инструмент и есть ли у него доступ. Поэтому вместо
 * агента — обычные команды оболочки, которые ведут себя нужным образом заведомо.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { manualAdapter } from '../agents/manual.ts';
import { commandAdapter } from '../agents/command.ts';
import type { AgentContext } from '../agents/adapter.ts';
import type { WorkPacket } from '../work-packets/types.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const TMP = path.join(REPO, '.maintenance', 'tmp');

const PACKET: WorkPacket = {
  role: 'reviewer',
  goal: 'найти мёртвый код в области',
  scope: ['apps/api/src/x.ts'],
  inputs: [{ title: 'Факты', body: 'файлов в области: 1' }],
  constraints: ['не выходить за область'],
  forbidden: ['править файлы'],
  expectedOutput: 'список находок',
  outputSchema: '{ "findings": [] }',
  outputFile: '.maintenance/results/review.json',
};

function sandbox(): { root: string; context: AgentContext; dispose: () => void } {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(path.join(TMP, 'agents-'));
  return {
    root,
    context: {
      root,
      taskFile: path.join(root, '.maintenance', 'task.md'),
      answerFile: path.join(root, '.maintenance', 'results', 'review.json'),
      timeoutMs: 10_000,
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('ручной адаптер пишет задание и ждёт человека, пока ответа нет', () => {
  const box = sandbox();
  try {
    const reply = manualAdapter().deliver(PACKET, box.context);
    assert.equal(reply.kind, 'awaiting');
    // Ждущему человеку называется место ответа, иначе ожидание бессодержательно.
    assert.match(reply.kind === 'awaiting' ? reply.where : '', /results\/review\.json/);
    assert.match(readFileSync(box.context.taskFile, 'utf8'), /найти мёртвый код/);
  } finally {
    box.dispose();
  }
});

test('ручной адаптер отдаёт ответ, когда он уже лежит на месте', () => {
  const box = sandbox();
  try {
    mkdirSync(path.dirname(box.context.answerFile), { recursive: true });
    writeFileSync(box.context.answerFile, '{"findings":[]}', 'utf8');
    const reply = manualAdapter().deliver(PACKET, box.context);
    assert.equal(reply.kind, 'answer');
    // Текст отдаётся как есть: разбирать его — дело finding-io, а не доставки.
    assert.equal(reply.kind === 'answer' ? reply.text : '', '{"findings":[]}');
  } finally {
    box.dispose();
  }
});

test('ручной адаптер не считает ответом пустой файл', () => {
  const box = sandbox();
  try {
    mkdirSync(path.dirname(box.context.answerFile), { recursive: true });
    writeFileSync(box.context.answerFile, '   \n', 'utf8');
    assert.equal(manualAdapter().deliver(PACKET, box.context).kind, 'awaiting');
  } finally {
    box.dispose();
  }
});

test('командный адаптер передаёт задание на stdin и возвращает вывод', () => {
  const box = sandbox();
  try {
    // `cat` возвращает ровно то, что получил: так видно, что на stdin ушёл текст задания целиком.
    const reply = commandAdapter({ command: ['cat'] }).deliver(PACKET, box.context);
    assert.equal(reply.kind, 'answer');
    const text = reply.kind === 'answer' ? reply.text : '';
    assert.match(text, /найти мёртвый код/);
    assert.match(text, /Напечатайте ответ в стандартный вывод/);
    assert.equal(text, readFileSync(box.context.taskFile, 'utf8'));
    // Полученный ответ сохраняется туда, где его ждёт остальной цикл.
    assert.equal(readFileSync(box.context.answerFile, 'utf8'), text);
  } finally {
    box.dispose();
  }
});

test('ненулевой код — отказ, а не пустой ответ', () => {
  const box = sandbox();
  try {
    const reply = commandAdapter({
      command: ['sh', '-c', 'cat >/dev/null; echo "нет доступа" >&2; exit 3'],
    }).deliver(PACKET, box.context);
    assert.equal(reply.kind, 'failed');
    const why = reply.kind === 'failed' ? reply.why : '';
    assert.match(why, /код 3/);
    // В причине виден чужой вывод: без него человеку остаётся только номер.
    assert.match(why, /нет доступа/);
  } finally {
    box.dispose();
  }
});

test('превышение таймаута — отказ с названной причиной', () => {
  const box = sandbox();
  try {
    const reply = commandAdapter({ command: ['sleep', '30'] }).deliver(PACKET, {
      ...box.context,
      timeoutMs: 250,
    });
    assert.equal(reply.kind, 'failed');
    assert.match(reply.kind === 'failed' ? reply.why : '', /250 мс/);
  } finally {
    box.dispose();
  }
});

test('непустой stderr при нулевом коде ошибкой не считается', () => {
  const box = sandbox();
  try {
    // Ровно так ведут себя настоящие агенты: ход работы в stderr, ответ в stdout.
    const reply = commandAdapter({
      command: ['sh', '-c', 'echo "думаю…" >&2; cat; echo "готово" >&2'],
    }).deliver(PACKET, box.context);
    assert.equal(reply.kind, 'answer');
    assert.match(reply.kind === 'answer' ? reply.text : '', /найти мёртвый код/);
  } finally {
    box.dispose();
  }
});

test('пустой вывод при нулевом коде берётся из файла ответа', () => {
  const box = sandbox();
  try {
    // Агент вправе отвечать файлом — он назван ему в задании; в поток при этом не идёт ничего.
    const reply = commandAdapter({
      command: [
        'sh',
        '-c',
        'cat >/dev/null; printf %s "{\\"findings\\":[]}" > "$0"',
        box.context.answerFile,
      ],
    }).deliver(PACKET, box.context);
    assert.equal(reply.kind, 'answer');
    assert.equal(reply.kind === 'answer' ? reply.text : '', '{"findings":[]}');
  } finally {
    box.dispose();
  }
});

test('нулевой код без единого следа ответа — отказ', () => {
  const box = sandbox();
  try {
    const reply = commandAdapter({ command: ['sh', '-c', 'cat >/dev/null'] }).deliver(
      PACKET,
      box.context,
    );
    assert.equal(reply.kind, 'failed');
    assert.match(reply.kind === 'failed' ? reply.why : '', /ответа нет/);
  } finally {
    box.dispose();
  }
});

test('сухой прогон показывает команду и ничего не запускает', () => {
  const box = sandbox();
  try {
    const printed: string[] = [];
    // Команда заведомо несуществующая: если бы адаптер её запустил, исходом был бы отказ.
    const reply = commandAdapter({
      command: ['несуществующий-агент', '-p', 'два слова'],
      dryRun: true,
      log: (text) => printed.push(text),
    }).deliver(PACKET, box.context);
    assert.equal(reply.kind, 'awaiting');
    assert.match(printed.join('\n'), /несуществующий-агент -p "два слова"/);
    assert.ok(existsSync(box.context.taskFile), 'задание всё равно написано');
    assert.equal(existsSync(box.context.answerFile), false);
  } finally {
    box.dispose();
  }
});

test('незаданная команда — отказ, а не попытка запуска пустоты', () => {
  const box = sandbox();
  try {
    const reply = commandAdapter({ command: [] }).deliver(PACKET, box.context);
    assert.equal(reply.kind, 'failed');
  } finally {
    box.dispose();
  }
});

test('неположительный таймаут — отказ: ждать вечно в автоматическом цикле некому', () => {
  const box = sandbox();
  try {
    const reply = commandAdapter({ command: ['cat'] }).deliver(PACKET, {
      ...box.context,
      timeoutMs: 0,
    });
    assert.equal(reply.kind, 'failed');
    assert.match(reply.kind === 'failed' ? reply.why : '', /таймаут/);
  } finally {
    box.dispose();
  }
});

/*
 * Проверка стоит отдельным тестом, потому что её отсутствие уже стоило прогона.
 *
 * В первом самоходном прогоне задание требовало «положите ответ в файл», а ревьюеру запись
 * запрещена флагом запуска. Агент не смог выполнить инструкцию, сказал об этом словами и напечатал
 * находки таблицей; разбор не нашёл в таблице JSON, и прогон встал на десятой минуте ожидания.
 */
test('задание называет способ ответа по адаптеру: ручному — файл, командному — вывод', () => {
  const box = sandbox();
  try {
    manualAdapter().deliver(PACKET, box.context);
    const manualTask = readFileSync(box.context.taskFile, 'utf8');
    assert.match(manualTask, /Положите ответ в файл/);

    commandAdapter({ command: ['true'], log: () => {} }).deliver(PACKET, box.context);
    const commandTask = readFileSync(box.context.taskFile, 'utf8');
    assert.match(commandTask, /Напечатайте ответ в стандартный вывод/);
    // Слова про файл в командном задании быть не должно вовсе: агент принял бы его за место ответа.
    assert.ok(!commandTask.includes('Положите ответ в файл'));
  } finally {
    box.dispose();
  }
});
