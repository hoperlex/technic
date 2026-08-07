#!/usr/bin/env node
/**
 * Раскладка этапа 2: что уже разрезано по сущностям, а что ещё ждёт своей очереди.
 *
 * Скрипт заводится в начале этапа, а не в конце: проверять раскладку нужно после каждого
 * мини-переезда, иначе «ещё не переехало» и «переехало, но забыли убрать» неотличимы. По ходу
 * этапа списки ниже сокращаются — слайс за слайсом.
 *
 * Грепом это не проверить: оставшиеся файлы обязаны импортировать переехавшее, и поиск «@entities
 * в старых каталогах» непуст даже в правильном результате.
 *
 * Запуск: pnpm --filter @technic/web check:stage2-layout
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

/**
 * Ещё не разрезано. Список пустеет по мере этапа; когда опустеет — `resources.ts` и `auth.ts`
 * уходят, и проверка начинает требовать их отсутствия.
 */
const PENDING_API = ['api/resources.ts', 'api/auth.ts'];

/**
 * Что остаётся в старых каталогах до своих этапов. Список точный: новый файл здесь — повод решить,
 * куда он относится, а не привычка. Причины — в docs/frontend-fsd-stage-2.md §2.1.
 */
const LEGACY = {
  hooks: [
    'useDepartmentScope.ts',
    'useObjectScope.ts',
    // Удаление насовсем одинаково у справочников и учёток (ADR 0060, 0063), а учётки ведутся в
    // другом разделе: слайсу справочников хук не принадлежит, импорт между соседями запрещён.
    'usePurgeAction.ts',
    'useVehicleClassificationFilter.tsx',
    'useVehicleClassifications.ts',
    // Область модуля «Вывоз мусора» (ADR 0062): уедет вместе со слайсом заявок на вывоз.
    'useWasteObjectScope.ts',
  ],
  // Адреса записей портала: знают вкладки обоих модулей заявок сразу — переедут, когда переедут оба.
  utils: ['date.ts', 'format.ts', 'formErrors.ts', 'links.ts'],
  components: [
    'AddressAutoComplete.tsx',
    'AppLayout.tsx',
    'AppUpdateBanner.tsx',
    'CancelReasonModal.tsx',
    'CaptchaField.tsx',
    'FileLinks.tsx',
    'MobileAppBar.tsx',
    'MobileNav.tsx',
    'ObjectCell.tsx',
    'PageTabs.tsx',
    'PasswordField.tsx',
    'PersonNameFields.tsx',
    'PhoneField.tsx',
    // Маска телефона — часть поля `PhoneField`, и переедет вместе с ним.
    'PhoneInput.tsx',
    'PortalLogo.tsx',
    // Окна каркаса: журнал обновлений (ADR 0077) и контакты поддержки — их открывает `AppLayout`,
    // и уедут они вместе с ним, когда каркас станет виджетом.
    'ReleaseNotesModal.tsx',
    'RequestHistory.tsx',
    'ResponsibleFields.tsx',
    'SupportContactsModal.tsx',
    'TimeInput.tsx',
    'UserAvatar.tsx',
    // Вложения путевого листа: зовут waybillsApi и filesApi — уедут в `waybill` вместе с печатью.
    'WaybillFiles.tsx',
    'WaybillPrint.tsx',
  ],
};

/**
 * Обращения к кэшу запросов, которые обязаны идти через ключи сущности. Проверяется не только
 * `queryKey:` — строковый ключ прячется и в `setQueryData`, и в `invalidateQueries`, и в legacy
 * вроде `AppLayout`.
 */
const CACHE_CALLS =
  /(queryKey:\s*\[\s*'|invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*'|setQueryData\(\s*\[\s*'|getQueryData\(\s*\[\s*'|removeQueries\(\s*\{\s*queryKey:\s*\[\s*'|cancelQueries\(\s*\{\s*queryKey:\s*\[\s*')/;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

const problems = [];
const notes = [];

// 1. Разрез: пока `resources.ts` жив — это норма и отмечается заметкой, а не ошибкой.
const stillPending = PENDING_API.filter((rel) => existsSync(path.join(SRC, rel)));
if (stillPending.length > 0) {
  notes.push(`ещё не разрезано: ${stillPending.join(', ')}`);
}

// 2. Старые каталоги: ровно то, что отложено.
for (const [dir, expected] of Object.entries(LEGACY)) {
  const full = path.join(SRC, dir);
  if (!existsSync(full)) continue;
  const actual = readdirSync(full).filter((f) => /\.tsx?$/.test(f));
  for (const file of actual) {
    if (!expected.includes(file)) {
      problems.push(
        `src/${dir}/${file} не значится в списке отложенного: перенесите его в свой слайс либо впишите в скрипт с причиной`,
      );
    }
  }
}

// 3. Строковые ключи запросов вне сущностей.
const entitiesDir = path.join(SRC, 'entities');
const stringKeyOwners = [];
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file);
  // Ключи и есть содержимое `keys.ts` — там строки законны.
  if (rel.startsWith(`entities${path.sep}`) && rel.includes(`api${path.sep}keys`)) continue;
  const code = readFileSync(file, 'utf8');
  if (CACHE_CALLS.test(code)) stringKeyOwners.push(rel);
}
if (stringKeyOwners.length > 0) {
  const done = existsSync(entitiesDir) && stillPending.length === 0;
  const message = `строковые ключи запросов вне entities/*/api/keys (${stringKeyOwners.length} файлов): ${stringKeyOwners.slice(0, 5).join(', ')}${stringKeyOwners.length > 5 ? ' …' : ''}`;
  // Пока разрез не закончен, это ожидаемое состояние — но видеть остаток полезно каждый прогон.
  (done ? problems : notes).push(message);
}

if (problems.length > 0) {
  console.error('Раскладка этапа 2 нарушена:\n' + problems.map((p) => `  — ${p}`).join('\n'));
  process.exit(1);
}

console.log('Раскладка этапа 2 в порядке.');
for (const note of notes) console.log(`  · ${note}`);
