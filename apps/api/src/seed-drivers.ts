import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { formatSnils, isValidSnils, normalizeSnils, splitFullName } from '@technic/contracts';
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

/** Что кадровая выгрузка даёт по одному человеку. Даты — «ДД.ММ.ГГГГ» или «ГГГГ-ММ-ДД». */
interface DriverRecord {
  fullName: string;
  personnelNo?: string;
  birthDate?: string;
  employedSince?: string;
  snils: string;
  /** Категории строкой ровно как в источнике («B,B1,C,C1,BE,CE,C1E»). Разбирает скрипт. */
  categories?: string;
}

interface DriversFile {
  department?: string;
  jobTitle?: string;
  drivers: DriverRecord[];
}

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

function parseDate(value: string | undefined, field: string, who: string): string | null {
  if (!value || value.trim() === '') return null;
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(v);
  if (iso) return v;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(v);
  if (!ru)
    throw new Error(`${who}: ${field} — ожидается ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, получено «${v}»`);
  return `${ru[3]}-${ru[2]}-${ru[1]}`;
}

/**
 * Коды категорий из строки источника. Регистр снимается («C1E» → «c1e»), пустые элементы
 * отбрасываются: в выгрузке встречается «C,C1,,BE» — это мусор разделителей, а не категория.
 * Неизвестные коды не угадываются: «AM», «CE1» и одиночная «E» похожи на M, C1E и старую
 * докатегорийную E, но речь о допуске живого человека к грузовику — такую догадку подтверждают
 * удостоверением в руках, а не эвристикой в сиде. Скрипт их перечислит, остальные заведёт.
 */
function parseCategories(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c !== ''),
    ),
  ];
}

interface Report {
  created: string[];
  skipped: string[];
  withoutLicense: { who: string; why: string }[];
  unknownCategories: { who: string; codes: string[] }[];
  nameCollisions: { who: string; existing: string }[];
}

async function run(file: DriversFile, dryRun: boolean): Promise<Report> {
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

  const report: Report = {
    created: [],
    skipped: [],
    withoutLicense: [],
    unknownCategories: [],
    nameCollisions: [],
  };

  // Разбор целиком до первой записи в базу: половина заведённого справочника хуже, чем
  // невыполненный запуск — второй раз его придётся сверять руками.
  const parsed = file.drivers.map((d) => {
    const who = d.fullName;
    const name = splitFullName(d.fullName);
    if (!name.lastName || !name.firstName) {
      throw new Error(`${who}: ожидается «Фамилия Имя Отчество»`);
    }
    const snils = normalizeSnils(d.snils ?? '');
    if (!/^\d{11}$/u.test(snils)) throw new Error(`${who}: СНИЛС — 11 цифр, получено «${d.snils}»`);
    // Контрольная сумма ловит опечатку в одной цифре — то, чего формат не видит. Пропустить её
    // здесь значило бы завести номер, который потом отвергнет форма правки карточки.
    if (!isValidSnils(snils)) {
      throw new Error(`${who}: СНИЛС ${formatSnils(snils)} не проходит проверку контрольной суммы`);
    }

    const codes = parseCategories(d.categories);
    const known = codes.filter((c) => categoryIdByCode.has(c));
    const unknown = codes.filter((c) => !categoryIdByCode.has(c));
    if (unknown.length > 0) report.unknownCategories.push({ who, codes: unknown });

    return {
      who,
      name,
      snils,
      personnelNo: d.personnelNo?.trim() ?? '',
      birthDate: parseDate(d.birthDate, 'дата рождения', who),
      employedSince: parseDate(d.employedSince, 'дата приёма', who),
      categories: known,
    };
  });

  const duplicates = parsed
    .map((p) => p.snils)
    .filter((s, i, all) => all.indexOf(s) !== i)
    .map((s) => formatSnils(s));
  if (duplicates.length > 0) {
    throw new Error(`СНИЛС повторяется в файле: ${[...new Set(duplicates)].join(', ')}`);
  }

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

  const file = JSON.parse(readFileSync(path, 'utf8')) as DriversFile;
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
