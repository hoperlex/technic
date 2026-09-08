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
  pathEverExisted,
  readAdrs,
} from './lib/docs-navigation.mjs';
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

test('история пути отделяет снятый файл от опечатки (Р5)', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  // Спрашивают эту функцию только про ОТСУТСТВУЮЩИЕ пути, поэтому пример берётся из истории, а
  // не из рабочего дерева: у файла, ни разу не закоммиченного, истории нет по построению.
  assert.equal(pathEverExisted(ROOT, 'apps/api/src/routes/service-requests.ts'), true);
  assert.equal(
    pathEverExisted(ROOT, 'apps/web/src/components/DataTable.tsx'),
    true,
    'снятый FSD-переносом файл в истории остаётся',
  );
  assert.equal(pathEverExisted(ROOT, 'apps/api/src/routes/такого-нет.ts'), false);
});

test('указатель prettier-стабилен: повторное форматирование его не меняет (Р9)', async () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const index = await renderIndex(readAdrs(ROOT));
  const config = (await prettier.resolveConfig(path.join(ROOT, 'docs/adr/README.md'))) ?? {};
  const again = await prettier.format(index, { ...config, filepath: 'README.md' });
  assert.equal(again, index, 'после `pnpm format` указатель обязан остаться прежним');
});
