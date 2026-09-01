#!/usr/bin/env node
/**
 * Бюджеты качества фронта: числа, которым разрешено только уменьшаться.
 *
 * Зачем это поверх линта и проверок раскладки. `max-lines` включён предупреждением и не блокирует
 * ничего; `check-stage2-layout` про то, что отложено, а не про то, что растёт. В итоге за неделю
 * три страницы набрали 1369 строк, `resources.ts` — 224, и ни одна проверка не покраснела.
 * Бюджет ловит именно рост: он не требует ничего чинить сегодня, но не даёт долгу увеличиться
 * незаметно.
 *
 * Два режима — намеренно раздельные:
 *   check  — только читает; падает и на росте, и на незаписанном улучшении;
 *   update — переписывает бюджет, но ТОЛЬКО в сторону улучшения.
 *
 * `check` зовётся из `pretest`, поэтому писать в дерево он не имеет права: правку бюджета,
 * сделанную молча посреди прогона тестов, слишком легко не закоммитить — и ратчет разожмётся сам
 * собой. Послабление (рост числа) не делает и `update`: его правят руками, и оно видно на ревью.
 *
 * Запуск: pnpm --filter @technic/web quality:check | quality:update
 * План: docs/frontend-followup-plan.md, барьеры Б1 и Б2.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walkTs, hasRawQueryKey, isEntityKeysFile } from './lib/source-scan.mjs';

const WEB = path.resolve(process.cwd());
const SRC = path.join(WEB, 'src');
const BUDGET_FILE = path.join(WEB, 'quality-budget.json');

/** Порог тот же, что у `max-lines` в eslint.config.mjs: два числа разошлись бы при первой правке. */
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

// --- замер -----------------------------------------------------------------

function measure() {
  const legacyFiles = {};
  for (const dir of LEGACY_DIRS) {
    const full = path.join(SRC, dir);
    // Каталог исчез — значит разложен: ноль, а не пропуск. Пропуск читался бы как «не мерили».
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

    const lines = code.split('\n').length;
    if (lines > LINE_LIMIT) maxLines[rel] = lines;
  }

  return { legacyFiles, rawKeyFiles, antdDeprecated, maxLines };
}

// --- сравнение с бюджетом ---------------------------------------------------

/**
 * Рост — ошибка, улучшение — повод обновить бюджет. Разделены намеренно: первое чинит автор
 * правки, второе делает `quality:update` одной командой, и оба видны в дифффе коммита.
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

  // Волна Э8 сняла `Space direction`, `Divider type` и `Alert message` до нуля; на `Space` и
  // `Divider` сверху стоит ещё и no-restricted-syntax. Остальное — `List`, `Drawer width`,
  // `InputNumber addon*` и мелочь — чинится по мере касания, а число держит, чтобы долг не рос:
  // портал уже на antd 6.5, и в следующем мажоре этих пропсов не будет.
  // Число новое, и в бюджете его может ещё не быть. Это не рост: в `grown` оно бы заблокировало
  // сам `quality:update`, которым его и записывают, — поэтому идёт в `improved`.
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
    // Новый длинный файл — тоже рост, хотя ни одно старое число не изменилось. Без этой ветки
    // ограничение обходится созданием ещё одного файла на 900 строк.
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

// --- режимы -----------------------------------------------------------------

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
