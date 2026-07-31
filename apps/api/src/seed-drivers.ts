import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { formatSnils } from '@technic/contracts';
import { type DriversImportFile, prepareDriverImport } from './services/driver-import';
import { closeDb, db } from './db/client';
import {
  credentialTypes,
  personCredentialCategories,
  personCredentials,
  personEmployments,
  persons,
  personSpecializations,
  qualificationCategories,
  specializations,
} from './db/schema';

// Первичное наполнение справочника водителей из кадровой выгрузки (ADR 0037).
//
// Данные приходят файлом, а не лежат в репозитории и не едут миграцией. Причина та же, по которой
// отдельным скриптом сделан `seed:drivers-test` (ADR 0037 п. 12): миграции применяются в проде и
// хранятся в git навсегда — ФИО, дата рождения и СНИЛС живых людей туда не попадают ни при каком
// режиме доступа к репозиторию. Файл кладут рядом с prod.env и монтируют
// в контейнер на один запуск (ADR 0037 п. 13 — персональные данные закрыты правом).
//
// Использование:
//   DRIVERS_FILE=./drivers.json pnpm seed:drivers --dry-run   — разбор и отчёт, база не трогается
//   DRIVERS_FILE=./drivers.json pnpm seed:drivers             — завести
//
// Повторный запуск ничего не дублирует: ключ человека — СНИЛС (ADR 0037), и заведённые пропускаются.
// Обратной операции нет намеренно: удаление настоящих людей — учётное действие с аудитом, а не
// ключ командной строки.

/** Код специализации, которой выражается водитель: отдельной таблицы для него нет (ADR 0008). */
const DRIVER_SPECIALIZATION_CODE = 'driver';
const DRIVER_LICENSE_CODE = 'driver_license';

/**
 * Почему у заведённого документа пустые серия, номер и сроки: в кадровой выгрузке их нет, а
 * категории хранятся только на документе — без него человек не попадёт в отбор под машину вообще
 * (`selectDrivers` присоединяет `person_credentials` внутренним join'ом). Пустой срок отбор
 * пропускает как бессрочный документ, поэтому водитель работоспособен сразу, а `unverified`
 * честно говорит, что бумагу никто не сверял: интерфейс такого водителя помечает.
 */
const LICENSE_COMMENT =
  'Заведено кадровой выгрузкой: известны только категории. Серию, номер, дату выдачи и срок ' +
  'действия внести по оригиналу удостоверения — заменой документа.';

interface Report {
  created: string[];
  skipped: string[];
  withoutLicense: { who: string; why: string }[];
  unknownCategories: { who: string; codes: string[] }[];
  nameCollisions: { who: string; existing: string }[];
}

async function run(file: DriversImportFile, dryRun: boolean): Promise<Report> {
  const jobTitle = file.jobTitle ?? 'Водитель';
  const employmentComment = file.department ?? '';

  const [driverSpecialization] = await db
    .select({ id: specializations.id })
    .from(specializations)
    .where(eq(specializations.code, DRIVER_SPECIALIZATION_CODE));
  const [licenseType] = await db
    .select({ id: credentialTypes.id })
    .from(credentialTypes)
    .where(eq(credentialTypes.code, DRIVER_LICENSE_CODE));
  if (!driverSpecialization || !licenseType) {
    throw new Error(
      'Справочники не наполнены: примените миграцию 0058 (специализация «driver» и вид документа «driver_license»).',
    );
  }

  const categoryRows = await db
    .select({ id: qualificationCategories.id, code: qualificationCategories.code })
    .from(qualificationCategories)
    .where(eq(qualificationCategories.credentialTypeId, licenseType.id));
  const categoryIdByCode = new Map(categoryRows.map((c) => [c.code, c.id]));

  // Разбор целиком до первой записи в базу: половина заведённого справочника хуже, чем
  // невыполненный запуск — второй раз его придётся сверять руками.
  const prepared = prepareDriverImport(file, categoryIdByCode.keys());
  const parsed = prepared.drivers;

  const report: Report = {
    created: [],
    skipped: [],
    withoutLicense: [],
    unknownCategories: prepared.unknownCategories,
    nameCollisions: [],
  };

  // Однофамильцы среди уже заведённых — не ошибка (ADR 0008: жёсткого UNIQUE по ФИО нет), но
  // при первичном наполнении это чаще всего тот же человек, заведённый раньше руками.
  const existingByName = await db
    .select({ id: persons.id, fullName: persons.fullName, snils: persons.snils })
    .from(persons)
    .where(
      inArray(
        persons.fullName,
        parsed.map((p) => `${p.name.lastName} ${p.name.firstName} ${p.name.middleName}`.trim()),
      ),
    );

  for (const d of parsed) {
    const [existing] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.snils, d.snils));
    if (existing) {
      report.skipped.push(d.who);
      continue;
    }

    const sameName = existingByName.find((e) => e.fullName === d.who && e.snils !== d.snils);
    if (sameName) report.nameCollisions.push({ who: d.who, existing: formatSnils(sameName.snils) });

    if (d.categories.length === 0) {
      report.withoutLicense.push({
        who: d.who,
        why: 'в выгрузке нет ни одной известной категории — удостоверение заводит администратор',
      });
    }

    if (dryRun) {
      report.created.push(d.who);
      continue;
    }

    await db.transaction(async (tx) => {
      const [person] = await tx
        .insert(persons)
        .values({ ...d.name, snils: d.snils, birthDate: d.birthDate })
        .returning({ id: persons.id });
      const personId = person!.id;

      await tx.insert(personSpecializations).values({
        personId,
        specializationId: driverSpecialization.id,
        isPrimary: true,
        // Специализация начинается с приёма на работу: до него человек водителем не числился.
        ...(d.employedSince ? { startedOn: d.employedSince } : {}),
      });

      await tx.insert(personEmployments).values({
        personId,
        employmentType: 'staff',
        personnelNo: d.personnelNo,
        jobTitle,
        comment: employmentComment,
        ...(d.employedSince ? { startedOn: d.employedSince } : {}),
      });

      // Документа без категорий не бывает: он не открывает ничего, и водителя по нему не
      // отобрать ни под одну машину. Такой человек заводится карточкой без удостоверения.
      if (d.categories.length === 0) return;

      const [credential] = await tx
        .insert(personCredentials)
        .values({
          personId,
          credentialTypeId: licenseType.id,
          verificationStatus: 'unverified',
          comment: LICENSE_COMMENT,
        })
        .returning({ id: personCredentials.id });

      await tx.insert(personCredentialCategories).values(
        d.categories.map((code) => ({
          credentialId: credential!.id,
          qualificationCategoryId: categoryIdByCode.get(code)!,
          credentialTypeId: licenseType.id,
        })),
      );
    });
    report.created.push(d.who);
  }

  return report;
}

function print(report: Report, dryRun: boolean): void {
  const verb = dryRun ? 'Будет заведено' : 'Заведено';
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
  if (report.created.length > 0 && !dryRun) {
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

  const report = await run(file, dryRun);
  print(report, dryRun);
  if (dryRun) console.log('\n--dry-run: база не изменена.');
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await closeDb().catch(() => {});
    process.exit(1);
  });
