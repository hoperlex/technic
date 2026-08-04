#!/usr/bin/env node
/**
 * Раскладка после этапа 1: что переехало в `shared`, а что осталось до своего этапа.
 *
 * Грепом это не проверить: оставшиеся файлы обязаны импортировать переехавшее — `AppLayout` берёт
 * режим устройства, `CancelReasonModal` — модальное окно, `api/resources` — транспорт. Поиск
 * «`@shared` в старых каталогах» всегда будет непустым и в правильном результате.
 *
 * Поэтому проверяется три вещи: переехавшего по старым путям больше нет, оставшееся совпадает со
 * списком отложенного, и ни один файл не остался заглушкой-реэкспортом.
 *
 * Запуск: pnpm --filter @technic/web check:stage1-layout
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

/** Переехало в `shared` — по старым путям этих файлов быть не должно. */
const MOVED = [
  'api/client.ts',
  'api/dadata.ts',
  'hooks/useIsMobile.ts',
  'hooks/useElementSize.ts',
  'hooks/useVersionCheck.ts',
  'hooks/useSoleOptionAutoSelect.ts',
  'hooks/useListParams.ts',
  'utils/selectOptions.ts',
  'utils/table.ts',
  'utils/avatar.ts',
  'components/ActionSheet.tsx',
  'components/AutoSelect.tsx',
  'components/columns.tsx',
  'components/DataTable.tsx',
  'components/Fab.tsx',
  'components/FilterSheet.tsx',
  'components/FormGrid.tsx',
  'components/FormModal.tsx',
  'components/listControls.ts',
  'components/ListToolbar.tsx',
  'components/PageTableLayout.tsx',
  'components/SortSheet.tsx',
  'components/SummaryBar.tsx',
  'components/ViewModal.tsx',
];

/**
 * Осталось до своего этапа — каждый со своей причиной (см. docs/frontend-fsd-stage-1.md §1.5).
 * Список точный: новый файл в этих каталогах — повод решить, куда он относится, а не привычка.
 */
const LEGACY = {
  api: ['auth.ts', 'resources.ts'],
  hooks: ['useDepartmentScope.ts', 'useObjectScope.ts', 'useVehicleClassifications.ts'],
  utils: ['date.ts', 'format.ts', 'formErrors.ts'],
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
    'PortalLogo.tsx',
    'RequestHistory.tsx',
    'ResponsibleFields.tsx',
    'TimeInput.tsx',
    'UserAvatar.tsx',
    'WaybillPrint.tsx',
  ],
};

const problems = [];

for (const rel of MOVED) {
  if (existsSync(path.join(SRC, rel))) {
    problems.push(`переехавший модуль всё ещё лежит по старому пути: src/${rel}`);
  }
}

for (const [dir, expected] of Object.entries(LEGACY)) {
  const full = path.join(SRC, dir);
  if (!existsSync(full)) {
    problems.push(`каталог src/${dir} исчез, хотя в нём должны остаться файлы до своего этапа`);
    continue;
  }
  const actual = readdirSync(full).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  for (const file of actual) {
    if (!expected.includes(file)) {
      problems.push(
        `src/${dir}/${file} не значится в списке отложенного: перенесите его в свой слой либо впишите в скрипт с причиной`,
      );
    }
  }
  for (const file of expected) {
    if (!actual.includes(file)) {
      problems.push(`src/${dir}/${file} пропал, хотя должен был остаться до своего этапа`);
    }
  }
}

/** Заглушка — файл, который только реэкспортирует переехавшее и своего кода не содержит. */
for (const [dir, expected] of Object.entries(LEGACY)) {
  for (const file of expected) {
    const full = path.join(SRC, dir, file);
    if (!existsSync(full)) continue;
    const code = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .trim();
    const onlyReexport =
      code.length > 0 &&
      code.split('\n').every((line) => !line.trim() || /^export .*from '@shared/.test(line.trim()));
    if (onlyReexport) {
      problems.push(`src/${dir}/${file} — заглушка-реэкспорт: этап 1 их не оставляет`);
    }
  }
}

if (problems.length > 0) {
  console.error('Раскладка этапа 1 нарушена:\n' + problems.map((p) => `  — ${p}`).join('\n'));
  process.exit(1);
}

console.log('Раскладка этапа 1 в порядке: переехавшее убрано, отложенное на месте, заглушек нет.');
