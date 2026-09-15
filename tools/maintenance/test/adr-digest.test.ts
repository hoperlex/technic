/**
 * Выжимка решений — на заготовленных файлах, а не на `docs/adr/**`.
 *
 * Корпус решений меняется каждый день: по два-три номера в день занимает поток работ. Тест,
 * опирающийся на живой файл, назавтра проверял бы не разбор, а чужую правку шапки — и падал бы у
 * того, кто к нему не прикасался. Поэтому здесь свои файлы, и номера у них девятитысячные: разбор
 * добирает домен точной таблицей legacy-классификации по ИМЕНИ файла, и назовись заготовка
 * `0021-permissions-model.md`, она получила бы домен настоящего решения.
 *
 * Заготовки собираются в рабочем каталоге прогона (`.maintenance/tmp`), как и у остальных тестов
 * системы: каталог вне истории, зато после падения видно, что именно разбиралось.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { digestMany, readAdrDigest } from '../project/adr-digest.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

function makeAdrs(files: Record<string, string>): string {
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'adr-digest-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

/** Решение привычной формы: шапка, история вопроса и нумерованный список правил. */
const NUMBERED = `# ADR 9001. Единица доступа — право, а не роль

- Статус: Принято (реализовано целиком). Схему не трогает, записи выпуска нет
- Домены: доступ, качество
- Область: \`apps/api/src/lib/access.ts\`

## Контекст

Доступ проверялся четырьмя независимыми способами сразу, и списки ролей расходились молча.
Это история вопроса, и агенту она не нужна.

## Решения

1. **Право, а не роль, — единица доступа.** Код спрашивает \`can(role, permission)\` и нигде не
   перечисляет роли: новая роль заводится строкой матрицы. Обоснование занимает ещё абзац.

2. **Матрица живёт в общем пакете, а не на сервере.** Разъехавшиеся копии давали либо кнопку,
   ведущую в 403, либо действие, видимое в интерфейсе и запрещённое на сервере.

## Последствия

Учётка без роли теперь не может ничего явно.
`;

/** Вторая живая форма: правила названы подзаголовками, жирного зачина нет вовсе. */
const HEADINGS = `# ADR 9002. Фамилию печатает карточка человека

- Статус: Принято
- Домены: путевые-листы

## Контекст

Отбора у бланка не было и раньше.

## Решение

### 1. \`findMachinist\` не спрашивает специализацию

Она убрана: машинист читается по идентификатору карточки.

### 2. \`null\` означает удалённую карточку

Удаление значит «его здесь не должно быть», и дата листа этого не отменяет.

## Последствия

Печать отказывает раньше, чем расходуется номер бланка.
`;

test('шапка разбирается общим разбором навигации: номер, заголовок, статус, домены', () => {
  const dir = makeAdrs({ 'docs/adr/9001-permission-unit.md': NUMBERED });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9001-permission-unit.md');
    assert.ok(digest !== null);
    assert.equal(digest.number, '9001');
    assert.equal(digest.path, 'docs/adr/9001-permission-unit.md');
    assert.equal(digest.title, 'Единица доступа — право, а не роль');
    // Статус обрезан первым предложением: дальше идут оговорки про схему, а не сам статус.
    assert.equal(digest.status, 'Принято (реализовано целиком)');
    assert.deepEqual(digest.domains, ['доступ', 'качество']);
    assert.deepEqual(digest.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('суть — ведущие утверждения раздела «Решения», а не история вопроса', () => {
  const dir = makeAdrs({ 'docs/adr/9001-permission-unit.md': NUMBERED });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9001-permission-unit.md');
    assert.ok(digest !== null);
    assert.equal(
      digest.essence,
      [
        '1. Право, а не роль, — единица доступа.',
        '2. Матрица живёт в общем пакете, а не на сервере.',
      ].join('\n'),
    );
    // Ради этого выжимка и существует: агенту нужно правило, а не обоснование и не контекст.
    assert.ok(!digest.essence.includes('Обоснование'));
    assert.ok(!digest.essence.includes('история вопроса'));
    assert.ok(!digest.essence.includes('Учётка без роли'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('правила, названные подзаголовками, тоже дают суть', () => {
  const dir = makeAdrs({ 'docs/adr/9002-machinist-name.md': HEADINGS });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9002-machinist-name.md');
    assert.ok(digest !== null);
    assert.equal(
      digest.essence,
      [
        '1. `findMachinist` не спрашивает специализацию',
        '2. `null` означает удалённую карточку',
      ].join('\n'),
    );
    assert.deepEqual(digest.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('обрезка по maxCharsEach не рвёт слово посередине', () => {
  const word = 'словоправила';
  const lead = `Р1. ${Array.from({ length: 12 }, () => word).join(' ')}`;
  const dir = makeAdrs({
    'docs/adr/9003-long.md': `# ADR 9003. Длинное правило\n\n- Статус: Принято\n\n## Решение\n\n**${lead}** проза\n`,
  });
  try {
    const { digests } = digestMany(dir, ['docs/adr/9003-long.md'], {
      maxAdr: 5,
      maxCharsEach: 50,
    });
    const digest = digests[0];
    assert.ok(digest !== undefined);
    assert.ok(digest.essence.endsWith(' …'));
    const kept = digest.essence.slice(0, -2);
    assert.ok(kept.length <= 50);
    // Проверка «не рвёт слово»: оставленное — посимвольное начало сути И целое число её слов.
    assert.ok(lead.startsWith(kept));
    const keptWords = kept.split(' ');
    const fullWords = lead.split(' ');
    assert.deepEqual(keptWords, fullWords.slice(0, keptWords.length));
    // Обрезка не молчит: о ней сказано там же, где о прочих изъянах разбора.
    assert.ok(digest.problems.some((problem) => problem.includes('обрезана')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('обрезка предпочитает границу строки: лучше меньше правил, но целых', () => {
  const first = 'Р1. Первое правило решения, названное целиком';
  const second = 'Р2. Второе правило решения, которое уже не помещается';
  const dir = makeAdrs({
    'docs/adr/9004-two-rules.md': `# ADR 9004. Два правила\n\n- Статус: Принято\n\n## Решения\n\n**${first}** проза\n\n**${second}** проза\n`,
  });
  try {
    const { digests } = digestMany(dir, ['docs/adr/9004-two-rules.md'], {
      maxAdr: 5,
      maxCharsEach: first.length + 20,
    });
    assert.equal(digests[0]?.essence, `${first} …`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maxAdr ограничивает число решений и сообщает, сколько осталось за бортом', () => {
  const files: Record<string, string> = {};
  for (const number of ['9005', '9006', '9007', '9008', '9009']) {
    files[`docs/adr/${number}-rule.md`] =
      `# ADR ${number}. Правило ${number}\n\n- Статус: Принято\n\n## Решение\n\n**Правило ${number}.** проза\n`;
  }
  const dir = makeAdrs(files);
  try {
    const { digests, omitted } = digestMany(dir, Object.keys(files), {
      maxAdr: 2,
      maxCharsEach: 500,
    });
    assert.equal(digests.length, 2);
    assert.equal(omitted, 3);
    assert.deepEqual(
      digests.map((digest) => digest.number),
      ['9005', '9006'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('порядок выжимок детерминирован и не зависит от порядка входного списка', () => {
  const files: Record<string, string> = {};
  for (const number of ['9005', '9006', '9007']) {
    files[`docs/adr/${number}-rule.md`] =
      `# ADR ${number}. Правило ${number}\n\n- Статус: Принято\n\n## Решение\n\n**Правило ${number}.** проза\n`;
  }
  const dir = makeAdrs(files);
  try {
    const straight = digestMany(dir, Object.keys(files), { maxAdr: 10, maxCharsEach: 500 });
    const shuffled = digestMany(dir, [...Object.keys(files)].reverse(), {
      maxAdr: 10,
      maxCharsEach: 500,
    });
    assert.deepEqual(
      shuffled.digests.map((digest) => digest.path),
      straight.digests.map((digest) => digest.path),
    );
    assert.deepEqual(
      straight.digests.map((digest) => digest.number),
      ['9005', '9006', '9007'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('повторы во входном списке не удваивают решение', () => {
  const dir = makeAdrs({ 'docs/adr/9001-permission-unit.md': NUMBERED });
  try {
    const { digests, omitted } = digestMany(
      dir,
      [
        'docs/adr/9001-permission-unit.md',
        './docs/adr/9001-permission-unit.md',
        path.join(dir, 'docs/adr/9001-permission-unit.md'),
      ],
      { maxAdr: 10, maxCharsEach: 500 },
    );
    assert.equal(digests.length, 1);
    assert.equal(omitted, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('решение без раздела «Решение» не роняет разбор, а называет проблему', () => {
  const dir = makeAdrs({
    'docs/adr/9010-old-form.md': `# ADR 9010. Старая форма

- Статус: Принято

## Контекст

Историю вопроса здесь писали в контексте.

## Что это меняет в коде

**Справочник ведёт менеджер.** Дальше идёт обоснование.
`,
  });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9010-old-form.md');
    assert.ok(digest !== null);
    assert.equal(digest.essence, 'Справочник ведёт менеджер.');
    assert.equal(digest.problems.length, 1);
    assert.match(digest.problems[0] ?? '', /нет раздела «Решение»/);
    // Названа и та дверь, в которую разбор вошёл: иначе агент прочтёт запасной путь как обычный.
    assert.match(digest.problems[0] ?? '', /Что это меняет в коде/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('раздел без выделенных утверждений даёт первый абзац и честную пометку', () => {
  const dir = makeAdrs({
    'docs/adr/9011-plain.md': `# ADR 9011. Решение сплошной прозой

- Статус: Принято

## Решение

Справочник ведёт менеджер, а диспетчер его только читает.

Второй абзац в суть уже не идёт.
`,
  });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9011-plain.md');
    assert.ok(digest !== null);
    assert.equal(digest.essence, 'Справочник ведёт менеджер, а диспетчер его только читает.');
    assert.equal(digest.problems.length, 1);
    assert.match(digest.problems[0] ?? '', /первым абзацем/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('шапка без статуса разбор не роняет: пустой статус назван проблемой', () => {
  const dir = makeAdrs({
    'docs/adr/9012-no-status.md': `# ADR 9012. Без статуса

- Область: \`apps/api/src/x.ts\`

## Решение

**Правило названо.** проза
`,
  });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9012-no-status.md');
    assert.ok(digest !== null);
    assert.equal(digest.status, '');
    assert.equal(digest.essence, 'Правило названо.');
    assert.ok(digest.problems.some((problem) => problem.includes('«Статус»')));
    // Домен не выдуман: ни поля, ни строки в таблице — значит, пусто.
    assert.deepEqual(digest.domains, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл вовсе без разделов разбор не роняет', () => {
  const dir = makeAdrs({
    'docs/adr/9013-header-only.md': '# ADR 9013. Одна шапка\n\n- Статус: Принято\n',
  });
  try {
    const digest = readAdrDigest(dir, 'docs/adr/9013-header-only.md');
    assert.ok(digest !== null);
    assert.equal(digest.number, '9013');
    assert.ok(digest.problems.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('не решение и отсутствующий файл дают null, а не выдуманный номер', () => {
  const dir = makeAdrs({
    'docs/adr/README.md': '# Указатель решений\n',
    'docs/plan.md': '# План\n',
  });
  try {
    assert.equal(readAdrDigest(dir, 'docs/adr/README.md'), null);
    assert.equal(readAdrDigest(dir, 'docs/plan.md'), null);
    assert.equal(readAdrDigest(dir, 'docs/adr/9999-missing.md'), null);
    // Мусор во входном списке выжимку не рушит и в счёт «за бортом» не идёт.
    const { digests, omitted } = digestMany(dir, ['docs/adr/README.md', 'docs/plan.md'], {
      maxAdr: 5,
      maxCharsEach: 500,
    });
    assert.deepEqual(digests, []);
    assert.equal(omitted, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
