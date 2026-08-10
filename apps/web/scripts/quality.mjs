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
import { walkTs, hasRawQueryKey, isEntityKeysFile } from './lib/source-scan.mjs';

const WEB = path.resolve(process.cwd());
const SRC = path.join(WEB, 'src');
const BUDGET_FILE = path.join(WEB, 'quality-budget.json');

/** Порог тот же, что у `max-lines` в eslint.config.mjs: два числа разошлись бы при первой правке. */
const LINE_LIMIT = 400;

/** Каталоги, оставшиеся от раскладки до FSD. Новый файл здесь — повод решить, куда он относится. */
const LEGACY_DIRS = ['hooks', 'utils', 'components'];

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
  const maxLines = {};
  for (const file of walkTs(SRC)) {
    const rel = path.relative(WEB, file);
    const code = readFileSync(file, 'utf8');

    if (!isEntityKeysFile(path.relative(SRC, file)) && hasRawQueryKey(code)) rawKeyFiles += 1;

    const lines = code.split('\n').length;
    if (lines > LINE_LIMIT) maxLines[rel] = lines;
  }

  return { legacyFiles, rawKeyFiles, maxLines };
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
