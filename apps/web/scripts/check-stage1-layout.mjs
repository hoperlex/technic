#!/usr/bin/env node
/**
 * Раскладка после этапа 1: переехавшее в `shared` не осталось по старым путям и не превратилось в
 * заглушку.
 *
 * Грепом это не проверить: оставшиеся файлы обязаны импортировать переехавшее — `AppLayout` берёт
 * режим устройства, `CancelReasonModal` — модальное окно, `api/resources` — транспорт. Поиск
 * «`@shared` в старых каталогах» всегда будет непустым и в правильном результате.
 *
 * Список отложенного скрипт больше не держит: он был и здесь, и в `check-stage2-layout`, и вторая
 * копия отстала — восемь новых файлов оказались «нарушением», а законно уехавший
 * `AddressAutoComplete` числился пропавшим. Список живёт в одном месте, в проверке этапа 2; здесь
 * остаётся то, чего там нет.
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

/** Старые каталоги, где заглушка после переезда и заводится. */
const LEGACY_DIRS = ['api', 'hooks', 'utils', 'components'];

const problems = [];

for (const rel of MOVED) {
  if (existsSync(path.join(SRC, rel))) {
    problems.push(`переехавший модуль всё ещё лежит по старому пути: src/${rel}`);
  }
}

/**
 * Заглушка — файл, который только реэкспортирует переехавшее и своего кода не содержит. Проверяются
 * все файлы старых каталогов, а не перечисленные поимённо: заглушка появляется как раз тогда, когда
 * модуль уехал, а список обновить забыли, — то есть у файла, которого в списке уже нет.
 */
for (const dir of LEGACY_DIRS) {
  const full = path.join(SRC, dir);
  if (!existsSync(full)) continue;
  for (const file of readdirSync(full).filter((f) => /\.tsx?$/.test(f))) {
    const code = readFileSync(path.join(full, file), 'utf8')
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

console.log('Раскладка этапа 1 в порядке: переехавшее убрано, заглушек не осталось.');
