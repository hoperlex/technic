import { eq, inArray, sql } from 'drizzle-orm';
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
// Отделено от `driver-import.ts` — там решения о том, что считать корректной строкой, здесь
// только запись. Наполняют справочник выгрузкой из портала (`POST /drivers/import`); пути с
// сервера больше нет (ADR 0047, изменение от 06.08.2026).
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
 * пропускает как бессрочный документ, а вот пустые серия с номером — нет (ADR 0055): пока их не
 * внесут, в рейс по такому документу не выйти, потому что лист напечатается недействительным.
 * `unverified` при этом честно говорит, что бумагу никто не сверял, — и допуска не отменяет.
 */
export const LICENSE_COMMENT =
  'Заведено кадровой выгрузкой: известны только категории. Серию, номер, дату выдачи и срок ' +
  'действия внести по оригиналу удостоверения — заменой документа.';

/**
 * Та же отметка, когда реквизиты в файле были. Вид документа называется коротко («ВУ», «УТМ»):
 * обменом заводится и удостоверение тракториста-машиниста (ADR 0095), и «с реквизитами ВУ» в
 * карточке машиниста было бы неправдой о том, какой документ у него на руках.
 */
export function licenseWithRequisitesComment(shortLabel: string): string {
  return `Заведено кадровой выгрузкой с реквизитами ${shortLabel}. Документ требует сверки с оригиналом.`;
}

/** Кадровая выгрузка приносит реквизиты только водительского: другого документа она не знает. */
export const LICENSE_WITH_REQUISITES_COMMENT = licenseWithRequisitesComment('ВУ');

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
    emailUpdated: [],
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
      .select({ id: persons.id, email: persons.email })
      .from(persons)
      .where(eq(persons.snils, d.snils));
    if (existing) {
      report.skipped.push(d.who);
      // Адрес — единственное, что выгрузка правит у заведённого человека, и только когда он в
      // файле есть и отличается от записанного. Пустая ячейка адрес не стирает: кадровая выгрузка
      // про почту ничего не знает, и её молчание — не «адреса нет».
      if (d.email !== null && d.email !== existing.email) {
        report.emailUpdated.push({ who: d.who, email: d.email });
        if (!dryRun) {
          await db
            .update(persons)
            .set({
              email: d.email,
              ...(actorUserId ? { updatedBy: actorUserId } : {}),
              updatedAt: new Date(),
              // Версия растёт, как при правке карточки: иначе открытая у кого-то форма сохранилась
              // бы поверх и вернула прежний адрес, ничего никому не сказав.
              version: sql`${persons.version} + 1`,
            })
            .where(eq(persons.id, existing.id));
        }
      }
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
          ...(d.email ? { email: d.email } : {}),
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
          ...(d.license
            ? {
                series: d.license.series,
                number: d.license.number,
                issuedOn: d.license.issuedOn,
                expiresOn: d.license.expiresOn,
                issuedBy: d.license.issuedBy,
              }
            : {}),
          verificationStatus: 'unverified',
          comment: d.license ? LICENSE_WITH_REQUISITES_COMMENT : LICENSE_COMMENT,
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
