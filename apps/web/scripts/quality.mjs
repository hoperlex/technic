#!/usr/bin/env node
/**
 * Front-end quality budgets: figures that are only allowed to go down.
 *
 * Why this on top of the linter and the layout checks. `max-lines` is a warning and blocks nothing;
 * `check-stage2-layout` is about what was postponed, not about what grows. Within one week three
 * pages gained 1369 lines and `resources.ts` 224, and not a single check turned red. A budget
 * catches exactly growth: it asks for no fix today, but does not let the debt grow unnoticed.
 *
 * Two modes, separate on purpose:
 *   check  — read-only; fails both on growth and on an improvement that is not written down;
 *   update — rewrites the budget, but ONLY in the direction of improvement.
 *
 * `check` runs from `pretest`, so it has no right to write to the tree: a budget edit made silently
 * in the middle of a test run is too easy to leave uncommitted, and the ratchet would loosen by
 * itself. A relaxation (a figure going up) is not made by `update` either: it is edited by hand,
 * where review sees it.
 *
 * Run: pnpm --filter @technic/web quality:check | quality:update
 * Plan: docs/frontend-followup-plan.md, barriers Б1 and Б2.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walkTs, hasRawQueryKey, isEntityKeysFile } from './lib/source-scan.mjs';

const WEB = path.resolve(process.cwd());
const SRC = path.join(WEB, 'src');
const BUDGET_FILE = path.join(WEB, 'quality-budget.json');

/*
 * Порог общий с `max-lines` в eslint.config.mjs: два числа разошлись бы при первой правке. А вот
 * мера разная: линт считает без пустых строк и комментариев, здесь строки сырые — те самые, что
 * видит человек в редакторе. Поэтому бюджет строго строже линта: файлы, сидящие здесь, у линта
 * молчат, обратных случаев нет.
 *
 * Меры не выравниваются намеренно. Снять `skipComments` в линте значит наказывать за комментарий,
 * а он тут носитель проектного решения, а не шум; научить бюджет считать по-линтовски значит
 * вывести часть длинных файлов из-под ратчета вовсе. Ворота — здесь, линт только подсказывает.
 */
const LINE_LIMIT = 400;

/** Каталоги, оставшиеся от раскладки до FSD. Новый файл здесь — повод решить, куда он относится. */
const LEGACY_DIRS = ['hooks', 'utils', 'components'];

/**
 * Устаревшее в antd 6: пропсы, которых в следующем мажоре не будет.
 *
 * Ключ — имя элемента ровно так, как оно написано в JSX. Это не педантизм: `direction` законен у
 * `Flex`, `type` — у `Button` и `Typography.Text`, `message` — у `Form.Item`, `width` — у `Modal`.
 * Текстовый греп посчитал бы всё это долгом, число перестало бы что-либо значить, и ратчет
 * пришлось бы отключить первым же честным `<Flex direction=…>`.
 */
const DEPRECATED_PROPS = {
  Space: ['direction', 'split'],
  Divider: ['type'],
  Alert: ['message'],
  Descriptions: ['labelStyle'],
  Drawer: ['width', 'destroyOnClose'],
  Dropdown: ['destroyOnClose'],
  InputNumber: ['addonBefore', 'addonAfter'],
  Select: ['onDropdownVisibleChange'],
  Spin: ['tip'],
};

/** `List` уходит целиком, а не пропсом: каждое употребление — место будущей замены вёрсткой. */
const DEPRECATED_TAGS = ['List', 'List.Item', 'List.Item.Meta'];

/**
 * Пункты `Timeline` строятся не в теге, а в помощнике-`map`, и привязать ключ объекта к тегу
 * статически нечем. Отличаем по соседям: у пункта `Timeline` подписи нет вовсе (`label` там тоже
 * устарел), а у пункта `Descriptions`, где `children` совершенно законен, она есть всегда.
 * Правило заведомо неполное — пункт с `label` и `children` мы пропустим, — но лучше недосчитать,
 * чем записать в долг чужой законный ключ.
 */
function isTimelineItemChildren(node, sf) {
  if (!ts.isPropertyAssignment(node) || node.name.getText(sf) !== 'children') return false;
  const owner = node.parent;
  return (
    ts.isObjectLiteralExpression(owner) &&
    !owner.properties.some((p) => p.name && p.name.getText(sf) === 'label')
  );
}

/** Сколько устаревших пропсов и компонентов antd в одном файле. */
function countAntdDeprecated(file, code) {
  // Вид файла — по расширению, а не всегда TSX: в `.ts` разбор как TSX ломается на обобщённой
  // стрелке `<T>(x: T) => x`, и дерево после этого считать нельзя.
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const hasTimeline = /<Timeline[\s/>]/.test(code);
  let found = 0;

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (DEPRECATED_TAGS.includes(tag)) found += 1;
      const props = DEPRECATED_PROPS[tag] ?? [];
      if (props.length > 0)
        for (const attr of node.attributes.properties)
          if (ts.isJsxAttribute(attr) && props.includes(attr.name.getText(sf))) found += 1;
    }
    if (hasTimeline && isTimelineItemChildren(node, sf)) found += 1;
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

// --- measurement -------------------------------------------------------------

function measure() {
  const legacyFiles = {};
  for (const dir of LEGACY_DIRS) {
    const full = path.join(SRC, dir);
    // A directory that is gone has been taken apart: zero, not a gap. A gap would read as "not
    // measured".
    legacyFiles[dir] = existsSync(full)
      ? walkTs(full).filter((f) => path.dirname(f) === full).length
      : 0;
  }

  let rawKeyFiles = 0;
  let antdDeprecated = 0;
  const maxLines = {};
  for (const file of walkTs(SRC)) {
    const rel = path.relative(WEB, file);
    const code = readFileSync(file, 'utf8');

    if (!isEntityKeysFile(path.relative(SRC, file)) && hasRawQueryKey(code)) rawKeyFiles += 1;
    antdDeprecated += countAntdDeprecated(file, code);

    /*
     * Lines in a file are counted by line breaks, not by the pieces of a split. `split('\n')` of a
     * file ending with a newline (every file has one, prettier puts it there) yields one piece too
     * many: the last one is the empty string after the final `\n`. A file of exactly 400 lines was
     * counted as 401 and declared "longer than 400" — which is what happened to
     * `ServiceRequestForm.tsx` and turned the gate red on a file that did not break the limit.
     *
     * The figure has to match what a person sees in the editor and in `wc -l`, and the requirement
     * rests on the person, not on the linter: `max-lines` has a measure of its own, without blank
     * lines and comments (see the header at `LINE_LIMIT`). The budget counts raw lines because raw
     * lines are what people argue about: "I have 400 and the gate says 401" is settled by opening
     * the editor, not by reading rule settings.
     */
    const lines = code.replace(/\n$/, '').split('\n').length;
    if (lines > LINE_LIMIT) maxLines[rel] = lines;
  }

  return { legacyFiles, rawKeyFiles, antdDeprecated, maxLines };
}

// --- comparison with the budget ----------------------------------------------

/**
 * Growth is an error, an improvement is a reason to update the budget. Kept apart on purpose: the
 * first is fixed by the author of the change, the second is done by `quality:update` in one command,
 * and both show in the commit diff.
 */
function compare(actual, budget) {
  const grown = [];
  const improved = [];

  for (const dir of LEGACY_DIRS) {
    const was = budget.legacyFiles?.[dir];
    if (was === undefined) {
      grown.push(`бюджет не знает каталога src/${dir} — обновите его через quality:update`);
      continue;
    }
    const now = actual.legacyFiles[dir];
    if (now > was)
      grown.push(
        `src/${dir}: файлов ${now}, бюджет ${was} — разложите новый файл по слоям либо поднимите бюджет руками, с причиной`,
      );
    if (now < was) improved.push(`src/${dir}: ${was} → ${now}`);
  }

  if (actual.rawKeyFiles > budget.rawKeyFiles)
    grown.push(
      `файлов с сырыми ключами: ${actual.rawKeyFiles}, бюджет ${budget.rawKeyFiles} — ключи новых запросов заводятся в entities/*/api/keys`,
    );
  if (actual.rawKeyFiles < budget.rawKeyFiles)
    improved.push(`сырые ключи: ${budget.rawKeyFiles} → ${actual.rawKeyFiles}`);

  // Wave Э8 took `Space direction`, `Divider type` and `Alert message` down to zero; `Space` and
  // `Divider` are also guarded by no-restricted-syntax. The rest — `List`, `Drawer width`,
  // `InputNumber addon*` and small things — is fixed when touched, and the figure keeps the debt
  // from growing: the portal is on antd 6.5 already, and the next major drops these props.
  // The figure is new and the budget may not know it yet. That is not growth: in `grown` it would
  // block the very `quality:update` that records it, so it goes to `improved`.
  if (budget.antdDeprecated === undefined)
    improved.push(`устаревшее antd: бюджет числа не знает → ${actual.antdDeprecated}`);
  else if (actual.antdDeprecated > budget.antdDeprecated)
    grown.push(
      `устаревших пропсов antd: ${actual.antdDeprecated}, бюджет ${budget.antdDeprecated} — новый код пишется на нынешних именах (см. DEPRECATED_PROPS в этом файле)`,
    );
  else if (actual.antdDeprecated < budget.antdDeprecated)
    improved.push(`устаревшее antd: ${budget.antdDeprecated} → ${actual.antdDeprecated}`);

  const budgetLines = budget.maxLines ?? {};
  for (const [file, now] of Object.entries(actual.maxLines)) {
    const was = budgetLines[file];
    // A new long file is growth too, although no old figure changed. Without this branch the limit
    // is bypassed by creating one more file of 900 lines.
    if (was === undefined)
      grown.push(`${file}: ${now} строк — новый файл длиннее ${LINE_LIMIT}; разделите его`);
    else if (now > was) grown.push(`${file}: ${now} строк, бюджет ${was}`);
    else if (now < was) improved.push(`${file}: ${was} → ${now}`);
  }
  for (const [file, was] of Object.entries(budgetLines)) {
    if (actual.maxLines[file] === undefined)
      improved.push(`${file}: ${was} → ниже ${LINE_LIMIT} (или файла нет)`);
  }

  return { grown, improved };
}

// --- modes -------------------------------------------------------------------

const mode = process.argv[2] ?? 'check';
if (!['check', 'update'].includes(mode)) {
  console.error(`Неизвестный режим «${mode}»: ожидается check или update`);
  process.exit(2);
}

const actual = measure();

if (!existsSync(BUDGET_FILE)) {
  if (mode !== 'update') {
    console.error(
      `Нет ${path.relative(WEB, BUDGET_FILE)} — снимите первый бюджет: pnpm --filter @technic/web quality:update`,
    );
    process.exit(1);
  }
  writeFileSync(BUDGET_FILE, JSON.stringify(actual, null, 2) + '\n');
  console.log('Бюджет снят впервые.');
  process.exit(0);
}

const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
const { grown, improved } = compare(actual, budget);

if (grown.length > 0) {
  console.error('Долг вырос:\n' + grown.map((m) => `  — ${m}`).join('\n'));
  if (mode === 'update')
    console.error(
      '\nquality:update ослабить бюджет не может: рост правится руками — так его видно на ревью.',
    );
  process.exit(1);
}

if (mode === 'update') {
  if (improved.length === 0) {
    console.log('Бюджет уже точен — обновлять нечего.');
    process.exit(0);
  }
  writeFileSync(BUDGET_FILE, JSON.stringify(actual, null, 2) + '\n');
  console.log('Бюджет подтянут:\n' + improved.map((m) => `  · ${m}`).join('\n'));
  process.exit(0);
}

if (improved.length > 0) {
  console.error(
    'Стало лучше, но бюджет не записан:\n' +
      improved.map((m) => `  · ${m}`).join('\n') +
      '\n\nЗапустите pnpm --filter @technic/web quality:update и закоммитьте quality-budget.json —' +
      '\nиначе достигнутое не закрепится и место освободится под новый долг.',
  );
  process.exit(1);
}

console.log('Бюджеты качества в порядке.');
