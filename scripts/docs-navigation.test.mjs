#!/usr/bin/env node
/**
 * `pnpm test:docs` — регрессии общего разборщика документации.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЕ ТЕСТЫ У СКРИПТА. Разборщик читает 176 шапок, писавшихся три года, и вся его
 * ценность — в том, что он одинаково понимает их неоднородные формы. Проверить это прогоном по
 * дереву нельзя: дерево меняется, и «сегодня сошлось» ничего не обещает про завтрашнюю шапку.
 * Поэтому реальные формы (перенос строки в поле, синонимы ключей, обе записи путей, обратное поле
 * «Изменён») зафиксированы здесь примерами, а на дереве проверяется только то, что по нему и
 * считается, — полнота и отсутствие коллизий.
 *
 * `node:test` без единой зависимости: скрипты репозитория не имеют своего `package.json`, и тащить
 * им vitest значило бы заводить второй тестовый стек ради четырёх десятков утверждений.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import prettier from 'prettier';
import {
  COLLISION_EXCEPTIONS,
  DOMAINS,
  RELATION_FIELDS,
  STATUSES,
  adrRefsIn,
  classifyBrokenLink,
  codePathsIn,
  collisionProblems,
  fieldsOf,
  headerOf,
  linksIn,
  HISTORY,
  pathHistory,
  qualifierText,
  readAdrs,
  readDocs,
} from './lib/docs-navigation.mjs';
import { LEGACY_DOMAINS } from './lib/docs-legacy-domains.mjs';
import { execFileSync } from 'node:child_process';
import { renderIndex } from './gen-adr-index.mjs';

/** Временное дерево «как настоящее»: `docs/adr` плюс пара файлов кода, на которые можно ссылаться. */
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-nav-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

test('шапка кончается на первом разделе: поля из прозы не берутся', () => {
  const header = headerOf(
    '# ADR 0001. X\n\n- Статус: Принято\n\n## Контекст\n\n- Статус: Отменено\n',
  );
  assert.match(header, /Принято/);
  assert.doesNotMatch(header, /Отменено/);
});

test('поле переживает перенос строки', () => {
  const fields = fieldsOf(
    '- Область: контракты —\n  [a.ts](../../packages/contracts/src/a.ts),\n  сервер\n',
  );
  assert.match(fields.get('Область'), /контракты — \[a\.ts\].+, сервер/);
});

test('синонимы ключей сводятся к одному имени', () => {
  const fields = fieldsOf('- Связано с: X\n- Миграция: `0261`\n- Области: Y\n');
  assert.equal(fields.get('Связано'), 'X');
  assert.equal(fields.get('Миграции'), '`0261`');
  assert.equal(fields.get('Область'), 'Y');
});

test('номера решений читаются и ссылкой, и словами', () => {
  assert.deepEqual(adrRefsIn('[ADR 0021](0021-x.md) и ADR 0038, снова ADR 0021'), ['0021', '0038']);
});

test('пути шапки берутся и из ссылок, и из обратных кавычек', () => {
  const header =
    '- Область: [a.ts](../../packages/contracts/src/a.ts), `apps/api/src/routes/b.ts`\n' +
    '- Связано: [решение](0001-x.md), `../не-путь`\n';
  const paths = codePathsIn(header, { adrDir: '/repo/docs/adr', root: '/repo' });
  assert.deepEqual(paths.sort(), ['apps/api/src/routes/b.ts', 'packages/contracts/src/a.ts']);
});

test('ссылки: код, внешние схемы, якоря и адреса портала пропускаются', () => {
  const text = [
    '[файл](a.md) и ![схема](b.png)',
    '`[в коде](nope.md)`',
    '```',
    '[в блоке](nope.md)',
    '```',
    '[внешняя](https://example.com/x.md) [почта](mailto:a@b.c)',
    '[якорь](#раздел) [портал](/login)',
    '[по ссылке][ref]',
    '',
    '[ref]: c.md',
  ].join('\n');
  assert.deepEqual(
    linksIn(text).map((l) => l.target),
    ['a.md', 'b.png', 'c.md'],
  );
});

test('ссылка теряет якорь и раскодируется', () => {
  assert.deepEqual(
    linksIn('[x](docs/%D0%B0.md#anchor)').map((l) => l.target),
    ['docs/а.md'],
  );
});

test('класс «не хватает ../» узнаётся и подсказывает верный путь', () => {
  const root = fixture({ 'packages/contracts/src/a.ts': '', 'docs/plan.md': '' });
  const res = classifyBrokenLink({
    file: path.join(root, 'docs/plan.md'),
    target: 'packages/contracts/src/a.ts',
    root,
    adrsByNumber: new Map(),
  });
  assert.equal(res.kind, 'missing-parent');
  assert.equal(res.hint, '../packages/contracts/src/a.ts');
  rmSync(root, { recursive: true, force: true });
});

test('класс «устаревший slug»: подсказка даётся при единственном файле с номером', () => {
  const res = classifyBrokenLink({
    file: '/repo/docs/adr/0100-x.md',
    target: '0021-access-model.md',
    root: '/repo',
    adrsByNumber: new Map([['0021', ['0021-permissions-model.md']]]),
  });
  assert.equal(res.kind, 'adr-slug');
  assert.equal(res.hint, '0021-permissions-model.md');
});

test('класс «устаревший slug»: у занятого дважды номера автоподсказки нет', () => {
  const res = classifyBrokenLink({
    file: '/repo/docs/adr/0100-x.md',
    target: '0085-old-name.md',
    root: '/repo',
    adrsByNumber: new Map([
      ['0085', ['0085-office-equipment-module.md', '0085-weekly-vehicle-request.md']],
    ]),
  });
  assert.equal(res.kind, 'adr-slug');
  assert.match(res.hint, /занят дважды/);
  assert.doesNotMatch(res.hint, /^0085-office/);
});

test('класс «снятый код» отличается от прочего', () => {
  const root = fixture({ 'docs/plan.md': '' });
  const code = classifyBrokenLink({
    file: path.join(root, 'docs/plan.md'),
    target: '../apps/web/src/components/Gone.tsx',
    root,
    adrsByNumber: new Map(),
  });
  const other = classifyBrokenLink({
    file: path.join(root, 'docs/plan.md'),
    target: 'нет-такого.md',
    root,
    adrsByNumber: new Map(),
  });
  assert.equal(code.kind, 'code-path');
  assert.equal(other.kind, 'other');
  rmSync(root, { recursive: true, force: true });
});

test('рёбра графа: направление, синонимы и дедупликация', () => {
  const root = fixture({
    'docs/adr/0100-new.md':
      '# ADR 0100. Новое\n\n- Статус: Принято\n- Изменяет: [ADR 0021](0021-x.md), ADR 0021\n' +
      '- Уточняет: ADR 0038\n- Развивает: ADR 0004\n- Связано: ADR 0999\n',
    'docs/adr/0021-x.md': '# ADR 0021. Старое\n\n- Статус: Принято\n- Изменён: ADR 0100\n',
  });
  const [old, fresh] = readAdrs(root);
  assert.deepEqual(
    fresh.relations.map((r) => `${r.kind}:${r.id}`).sort(),
    ['changes:0021', 'changes:0038', 'extends:0004'],
    'Связано не типизируется, повтор номера не удваивает ребро',
  );
  assert.deepEqual(
    old.relations.map((r) => `${r.kind}:${r.id}`),
    ['changed-by:0100'],
    'обратное поле читается своим типом',
  );
  rmSync(root, { recursive: true, force: true });
});

test('коллизия: объявленная пара молчит, третий файл и подмена имени — ошибка', () => {
  const known = COLLISION_EXCEPTIONS[0];
  const pair = known.files.map((name) => ({ id: known.id, name }));
  assert.deepEqual(collisionProblems(pair), []);
  const third = [...pair, { id: known.id, name: `${known.id}-third.md` }];
  assert.equal(collisionProblems(third).length, 1);
  const swapped = [pair[0], { id: known.id, name: `${known.id}-renamed.md` }];
  assert.match(collisionProblems(swapped)[0], /разошёлся с объявленным исключением/);
  assert.equal(
    collisionProblems([
      { id: '0500', name: 'a.md' },
      { id: '0500', name: 'b.md' },
    ]).length,
    1,
  );
});

test('словари не пустые и не пересекаются по смыслу', () => {
  assert.ok(STATUSES.includes('Принято') && STATUSES.length === 4);
  assert.equal(DOMAINS.length, 16);
  assert.equal(new Set(DOMAINS).size, DOMAINS.length);
  assert.ok(RELATION_FIELDS.get('Отменяет') === 'cancels');
  assert.ok(RELATION_FIELDS.get('Связано') === undefined, 'нейтральная связь не типизируется');
});

test('статус берётся первым словом, пояснение после него не мешает', () => {
  const root = fixture({
    'docs/adr/0100-x.md':
      '# ADR 0100. X\n\n- Статус: Принято (реализовано целиком — коммит `abc`)\n',
  });
  assert.equal(readAdrs(root)[0].status, 'Принято');
  rmSync(root, { recursive: true, force: true });
});

test('история пути: снятый файл, опечатка и «историю не спросить» — три разных ответа (Р5)', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  assert.equal(pathHistory(ROOT, 'apps/api/src/routes/service-requests.ts'), HISTORY.EXISTS);
  assert.equal(
    pathHistory(ROOT, 'apps/web/src/components/DataTable.tsx'),
    HISTORY.EXISTS,
    'снятый FSD-переносом файл в истории остаётся',
  );
  assert.equal(pathHistory(ROOT, 'apps/api/src/routes/такого-нет.ts'), HISTORY.ABSENT);
  // Каталог без репозитория: ответить нечем, и выдавать это за «не существовал» нельзя — иначе
  // в архиве исходников и в поверхностном клоне полсотни исторических путей стали бы ошибками.
  const bare = fixture({ 'docs/adr/0100-x.md': '# ADR 0100. X\n\n- Статус: Принято\n' });
  assert.equal(pathHistory(bare, 'apps/api/src/routes/что-угодно.ts'), HISTORY.UNKNOWN);
  rmSync(bare, { recursive: true, force: true });
});

test('цель связи опознаётся именем файла, а не номером (Р6)', () => {
  const root = fixture({
    'docs/adr/0060-purge.md': '# ADR 0060. Уборка\n\n- Статус: Принято\n',
    'docs/adr/0060-esm2.md': '# ADR 0060. Лист\n\n- Статус: Принято\n',
    'docs/adr/0142-split.md':
      '# ADR 0142. Разрез\n\n- Статус: Принято\n- Отменяет: [ADR 0060](0060-esm2.md)\n',
  });
  const split = readAdrs(root).find((a) => a.id === '0142');
  assert.deepEqual(
    split.relations.map((r) => `${r.kind}:${r.name}`),
    ['cancels:0060-esm2.md'],
    'ребро принадлежит одному файлу, а не обоим носителям номера',
  );
  rmSync(root, { recursive: true, force: true });
});

test('голый номер занятого дважды номера — неоднозначность, а не догадка (Р7)', () => {
  const root = fixture({
    'docs/adr/0085-orgtech.md': '# ADR 0085. Оргтехника\n\n- Статус: Принято\n',
    'docs/adr/0085-weekly.md': '# ADR 0085. Неделя\n\n- Статус: Принято\n',
    'docs/adr/0125-cycle.md': '# ADR 0125. Цикл\n\n- Статус: Принято\n- Изменяет: ADR 0085\n',
  });
  const [, , cycle] = readAdrs(root);
  assert.equal(cycle.relations.length, 1);
  assert.equal(cycle.relations[0].ambiguous, true);
  assert.equal(
    cycle.relations[0].name,
    null,
    'цель не выбрана: догадка приписала бы связь не тому',
  );
  rmSync(root, { recursive: true, force: true });
});

test('частичная отмена сохраняет границу и не гасит всё решение (Р4)', async () => {
  const root = fixture({
    'docs/adr/0053-comment.md':
      '# ADR 0053. Комментарий\n\n- Статус: Принято\n- Домены: вывоз-мусора\n',
    'docs/adr/0133-cycle.md': '# ADR 0133. Цикл\n\n- Статус: Принято\n- Домены: оргтехника\n',
    // Обе живые формы уточнения: до двоеточия (0141) и выделением внутри значения (0145).
    'docs/adr/0141-chat.md':
      '# ADR 0141. Обсуждение\n\n- Статус: Принято\n- Домены: оргтехника\n' +
      '- Отменяет — **в модуле оргтехники** — приём [ADR 0053](0053-comment.md): поле остаётся\n',
    'docs/adr/0145-simple.md':
      '# ADR 0145. Упрощение\n\n- Статус: Принято\n- Домены: оргтехника\n' +
      '- Отменяет: **решение 3 [ADR 0133](0133-cycle.md)** — виза упраздняется\n',
  });
  const adrs = readAdrs(root);
  const chat = adrs.find((a) => a.id === '0141');
  assert.equal(chat.relations[0].kind, 'cancels', 'поле с уточнением вообще перестало теряться');
  assert.equal(chat.relations[0].name, '0053-comment.md');
  assert.equal(chat.relations[0].qualifier, 'в модуле оргтехники');
  assert.equal(adrs.find((a) => a.id === '0145').relations[0].qualifier, 'решение 3');
  const index = await renderIndex(adrs);
  assert.match(index, /\[0053\].*отменён 0141 \(в модуле оргтехники\)/);
  assert.ok(
    !/⛔ \[0053\]/.test(index),
    'входящая отмена не гасит решение целиком: область отмены знает только его текст',
  );
  rmSync(root, { recursive: true, force: true });
});

test('⛔ ставит только собственный статус решения (Р4)', async () => {
  const root = fixture({
    // Выделение вокруг статуса — живая форма (ADR 0134): со звёздочками знак не ставился вовсе.
    'docs/adr/0100-dead.md':
      '# ADR 0100. Снятое\n\n- Статус: **Отменено** [ADR 0154](0154-x.md) 02.09.2026\n' +
      '- Домены: качество\n',
    'docs/adr/0101-live.md': '# ADR 0101. Живое\n\n- Статус: Принято\n- Домены: качество\n',
  });
  const index = await renderIndex(readAdrs(root));
  assert.match(index, /⛔ \[0100\]/);
  assert.ok(!/⛔ \[0101\]/.test(index));
  rmSync(root, { recursive: true, force: true });
});

test('указатель показывает всю «Область», а не первые пять путей (Э3)', async () => {
  const paths = Array.from({ length: 7 }, (_, i) => `\`apps/api/src/routes/r${i}.ts\``).join(', ');
  const root = fixture({
    'docs/adr/0100-wide.md': `# ADR 0100. Широкое\n\n- Статус: Принято\n- Домены: качество\n- Область: ${paths}\n`,
  });
  const [adr] = readAdrs(root);
  assert.equal(adr.regionPaths.length, 7, 'поле «Область» разбирается отдельно и целиком');
  const index = await renderIndex(readAdrs(root));
  assert.match(index, /r6\.ts/, 'седьмой путь виден: обрезки больше нет');
  assert.ok(!/и ещё \d/.test(index), 'счётчика остатка не осталось');
  rmSync(root, { recursive: true, force: true });
});

test('«Область» отделена от прочей шапки, но у legacy-формы её роль играет вся шапка', () => {
  const root = fixture({
    'docs/adr/0100-new.md':
      '# ADR 0100. Новое\n\n- Статус: Принято\n- Область: `apps/api/src/a.ts`\n' +
      '- Связано: `apps/api/src/b.ts`\n',
    'docs/adr/0101-old.md':
      '# ADR 0101. Старое\n\n- Статус: Принято\n- Связано: `apps/api/src/c.ts`\n',
  });
  const [fresh, legacy] = readAdrs(root);
  assert.deepEqual(fresh.regionPaths, ['apps/api/src/a.ts'], 'есть поле — берётся только оно');
  assert.deepEqual(fresh.codePaths.sort(), ['apps/api/src/a.ts', 'apps/api/src/b.ts']);
  assert.deepEqual(
    legacy.regionPaths,
    ['apps/api/src/c.ts'],
    'нет поля — область названа «Связано»',
  );
  rmSync(root, { recursive: true, force: true });
});

test('ссылки проверяются и в корневых README.md и AGENTS.md (§6)', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const docs = readDocs(ROOT).map((f) => path.relative(ROOT, f));
  assert.ok(
    docs.includes('README.md'),
    'корневой README — точка входа, его ссылки тоже проверяются',
  );
  assert.ok(docs.includes('AGENTS.md'));
  assert.ok(docs.some((f) => f.startsWith('docs/adr/')));
});

test('уточнение читается во всех трёх живых написаниях', () => {
  assert.equal(
    qualifierText('— **в модуле оргтехники** — приём [ADR 0053](0053-x.md)'),
    'в модуле оргтехники',
  );
  assert.equal(qualifierText('ограничение'), 'ограничение');
  assert.equal(qualifierText('действующую половину'), 'действующую половину');
  assert.equal(qualifierText(''), '');
});

test('у каждого закоммиченного решения ровно один источник доменов (Р8)', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const tracked = new Set(
    execFileSync('git', ['ls-files', 'docs/adr'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((line) => path.basename(line.trim()))
      .filter((name) => /^\d{4}-.+\.md$/.test(name)),
  );
  const adrs = readAdrs(ROOT);
  const names = new Set(adrs.map((a) => a.name));
  for (const adr of adrs) {
    const inTable = LEGACY_DOMAINS.has(adr.name);
    const hasField = adr.domains.length > 0;
    if (tracked.has(adr.name)) {
      assert.ok(inTable || hasField, `${adr.name}: закоммиченное решение без домена`);
    }
    assert.ok(!(inTable && hasField), `${adr.name}: домен задан дважды`);
  }
  for (const name of LEGACY_DOMAINS.keys()) {
    assert.ok(names.has(name), `таблица классификации помнит несуществующее решение ${name}`);
  }
  for (const list of LEGACY_DOMAINS.values()) {
    for (const domain of list) assert.ok(DOMAINS.includes(domain), `домен вне словаря: ${domain}`);
  }
});

test('указатель prettier-стабилен: повторное форматирование его не меняет (Р9)', async () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const index = await renderIndex(readAdrs(ROOT));
  const config = (await prettier.resolveConfig(path.join(ROOT, 'docs/adr/README.md'))) ?? {};
  const again = await prettier.format(index, { ...config, filepath: 'README.md' });
  assert.equal(again, index, 'после `pnpm format` указатель обязан остаться прежним');
});
