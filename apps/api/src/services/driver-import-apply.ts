import { eq, inArray } from 'drizzle-orm';
import { formatSnils } from '@technic/contracts';
import type { DriversImportReportDto } from '@technic/contracts';
import { type DriversImportFile, prepareDriverImport } from './driver-import';
import { db } from '../db/client';
import {
  credentialTypes,
  personCredentialCategories,
  personCredentials,
  personEmployments,
  persons,
  personSpecializations,
  qualificationCategories,
  specializations,
} from '../db/schema';

// Запись разобранной кадровой выгрузки в справочник водителей (ADR 0037, ADR 0047).
//
// Отделено от `driver-import.ts` (там решения о том, что считать корректной строкой) и от обоих
// вызывающих: справочник наполняют из портала (`POST /drivers/import`) и из командной строки
// (`seed:drivers`, когда файл кладут на VPS). Путь заведения человека при этом обязан быть один:
// разъехавшись, они завели бы одних и тех же людей по-разному — с документом и без, с трудовым
// отношением и без него, — а обнаружилось бы это на выписке путевого листа.
//
// Обратной операции нет намеренно: удаление настоящих людей — учётное действие с аудитом, а не
// побочный эффект повторной загрузки. Повторный запуск ничего не дублирует: ключ человека —
// СНИЛС (ADR 0037), и заведённые пропускаются.

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
export const LICENSE_COMMENT =
  'Заведено кадровой выгрузкой: известны только категории. Серию, номер, дату выдачи и срок ' +
  'действия внести по оригиналу удостоверения — заменой документа.';

export interface ApplyDriverImportOptions {
  /** Разбор и отчёт без единой записи в базу: первый шаг работы с чужим файлом. */
  dryRun: boolean;
  /** Кто грузит. У командной строки автора нет — там заведение остаётся без `created_by`. */
  actorUserId?: string | null;
}

/** Справочники, без которых водителя не завести (наполняет миграция 0058). */
export class DirectoriesNotSeededError extends Error {
  constructor() {
    super(
      'Справочники не наполнены: примените миграцию 0058 (специализация «driver» и вид документа «driver_license»).',
    );
    this.name = 'DirectoriesNotSeededError';
  }
}

export async function applyDriverImport(
  file: DriversImportFile,
  { dryRun, actorUserId = null }: ApplyDriverImportOptions,
): Promise<DriversImportReportDto> {
  const [driverSpecialization] = await db
    .select({ id: specializations.id })
    .from(specializations)
    .where(eq(specializations.code, DRIVER_SPECIALIZATION_CODE));
  const [licenseType] = await db
    .select({ id: credentialTypes.id })
    .from(credentialTypes)
    .where(eq(credentialTypes.code, DRIVER_LICENSE_CODE));
  if (!driverSpecialization || !licenseType) throw new DirectoriesNotSeededError();

  const categoryRows = await db
    .select({ id: qualificationCategories.id, code: qualificationCategories.code })
    .from(qualificationCategories)
    .where(eq(qualificationCategories.credentialTypeId, licenseType.id));
  const categoryIdByCode = new Map(categoryRows.map((c) => [c.code, c.id]));

  // Разбор целиком до первой записи в базу: половина заведённого справочника хуже, чем
  // невыполненная загрузка — второй раз её придётся сверять руками.
  const prepared = prepareDriverImport(file, categoryIdByCode.keys());
  const parsed = prepared.drivers;

  const report: DriversImportReportDto = {
    dryRun,
    created: [],
    skipped: [],
    withoutLicense: [],
    unknownCategories: prepared.unknownCategories,
    nameCollisions: [],
  };

  // Однофамильцы среди уже заведённых — не ошибка (ADR 0008: жёсткого UNIQUE по ФИО нет), но
  // при наполнении это чаще всего тот же человек, заведённый раньше руками.
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
        why:
          d.licenseSkipReason ||
          'в выгрузке нет ни одной известной категории — удостоверение заводит администратор',
      });
    }

    if (dryRun) {
      report.created.push(d.who);
      continue;
    }

    await db.transaction(async (tx) => {
      const [person] = await tx
        .insert(persons)
        .values({
          ...d.name,
          snils: d.snils,
          birthDate: d.birthDate,
          ...(actorUserId ? { createdBy: actorUserId } : {}),
        })
        .returning({ id: persons.id });
      const personId = person!.id;

      await tx.insert(personSpecializations).values({
        personId,
        specializationId: driverSpecialization.id,
        isPrimary: true,
        // Специализация начинается с приёма на работу: до него человек водителем не числился.
        ...(d.employedSince ? { startedOn: d.employedSince } : {}),
      });

      // Должность и подразделение — из строки: в выгрузке отдела водители, машинисты крана и
      // погрузчика идут одним файлом, а обособленные подразделения — его разделами.
      await tx.insert(personEmployments).values({
        personId,
        employmentType: 'staff',
        personnelNo: d.personnelNo,
        jobTitle: d.jobTitle,
        comment: d.department,
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
