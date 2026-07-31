import { readFileSync } from 'node:fs';
import type { DriversImportReportDto } from '@technic/contracts';
import type { DriversImportFile } from './services/driver-import';
import { applyDriverImport } from './services/driver-import-apply';
import { closeDb } from './db/client';

// Наполнение справочника водителей из кадровой выгрузки, положенной на VPS (ADR 0037).
//
// Данные приходят файлом, а не лежат в репозитории и не едут миграцией. Причина та же, по которой
// отдельным скриптом сделан `seed:drivers-test` (ADR 0037 п. 12): миграции применяются в проде и
// хранятся в git навсегда — ФИО, дата рождения и СНИЛС живых людей туда не попадают ни при каком
// режиме доступа к репозиторию. Файл кладут рядом с prod.env и монтируют
// в контейнер на один запуск (ADR 0037 п. 13 — персональные данные закрыты правом).
//
// Второй путь наполнения — загрузка выгрузки администратором в портале (ADR 0047): он не требует
// доступа к серверу вовсе. Оба ведут в один и тот же `applyDriverImport`, поэтому человек
// заводится одинаково независимо от того, откуда приехал файл.
//
// Использование:
//   DRIVERS_FILE=./drivers.json pnpm seed:drivers --dry-run   — разбор и отчёт, база не трогается
//   DRIVERS_FILE=./drivers.json pnpm seed:drivers             — завести
//
// Повторный запуск ничего не дублирует: ключ человека — СНИЛС (ADR 0037), и заведённые пропускаются.
// Обратной операции нет намеренно: удаление настоящих людей — учётное действие с аудитом, а не
// ключ командной строки.

function print(report: DriversImportReportDto): void {
  const verb = report.dryRun ? 'Будет заведено' : 'Заведено';
  console.log(`${verb} водителей: ${report.created.length}`);
  if (report.skipped.length > 0) {
    console.log(`Уже заведены (совпал СНИЛС), пропущено: ${report.skipped.length}`);
    for (const who of report.skipped) console.log(`  · ${who}`);
  }
  if (report.withoutLicense.length > 0) {
    console.log(`\nБез удостоверения — в отбор под машину не попадут:`);
    for (const w of report.withoutLicense) console.log(`  · ${w.who}: ${w.why}`);
  }
  if (report.unknownCategories.length > 0) {
    console.log(`\nКатегории, которых нет в справочнике, — не заведены, уточнить по оригиналу:`);
    for (const u of report.unknownCategories) {
      console.log(`  · ${u.who}: ${u.codes.map((c) => c.toUpperCase()).join(', ')}`);
    }
  }
  if (report.nameCollisions.length > 0) {
    console.log(`\nОднофамильцы среди заведённых ранее — проверить, не один ли это человек:`);
    for (const c of report.nameCollisions)
      console.log(`  · ${c.who}: уже есть с СНИЛС ${c.existing}`);
  }
  if (report.created.length > 0 && !report.dryRun) {
    console.log(
      `\nУ заведённых удостоверений пустые серия, номер и сроки: в выгрузке их нет. Пока они ` +
        `пустые, водитель в отбор попадает, но графа «номер удостоверения» в путевом листе ` +
        `печатается пустой. Реквизиты вносит администратор заменой документа в карточке.`,
    );
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const path = process.env.DRIVERS_FILE ?? process.argv.find((a) => a.endsWith('.json'));
  if (!path) {
    console.error('Использование: DRIVERS_FILE=./drivers.json pnpm seed:drivers [--dry-run]');
    process.exit(1);
  }

  const file = JSON.parse(readFileSync(path, 'utf8')) as DriversImportFile;
  if (!Array.isArray(file.drivers) || file.drivers.length === 0) {
    throw new Error(`${path}: нет массива drivers`);
  }

  const report = await applyDriverImport(file, { dryRun });
  print(report);
  if (dryRun) console.log('\n--dry-run: база не изменена.');
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await closeDb().catch(() => {});
    process.exit(1);
  });
