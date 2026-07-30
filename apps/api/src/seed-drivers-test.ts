import { and, eq, inArray } from 'drizzle-orm';
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

// Тестовые водители (ADR 0037). Отдельным скриптом, а не миграцией: миграции применяются в
// проде, и персональным данным — пусть даже выдуманным — там не место.
//
// Набор покрывает не только успех, но и отказы: без просроченного, аннулированного и отклонённого
// документа отбор водителя под машину остаётся непроверенным, а именно он решает, кого покажут
// в форме перевода заявки в работу.
//
// Использование:
//   pnpm seed:drivers-test            — завести (повторный запуск ничего не дублирует)
//   pnpm seed:drivers-test --purge    — удалить заведённое этим скриптом
//
// Очевидность подделки: ФИО «Тестовый Водитель Первый», СНИЛС из одинаковых цифр, серия
// удостоверения «00 00» (региона с кодом 00 не существует). Контрольную сумму СНИЛС при этом
// проходят — иначе карточку такого водителя нельзя было бы сохранить той же формой, которой
// пользуются с настоящими.

/** Метка в комментарии: по ней скрипт находит своё, чтобы удалить ровно его. */
const MARKER = 'ТЕСТОВЫЕ ДАННЫЕ';

const EMPLOYED_SINCE = '2024-01-15';

interface SeedDriver {
  middleName: string;
  snils: string;
  personnelNo: string;
  licenseNumber: string;
  issuedOn: string;
  expiresOn: string;
  /** Коды категорий (`qualification_categories.code`) — в нижнем регистре, как в справочнике. */
  categories: string[];
  verificationStatus: 'unverified' | 'verified' | 'rejected';
  revokedAt?: string;
  revokeReason?: string;
  /** Собственный срок отдельной категории: он сужает срок документа, но не продлевает его. */
  categoryValidTo?: Record<string, string>;
  /** Зачем этот водитель в наборе — попадает в комментарий карточки. */
  purpose: string;
}

const DRIVERS: SeedDriver[] = [
  {
    middleName: 'Первый',
    snils: '11111111145',
    personnelNo: 'Т-001',
    licenseNumber: '000001',
    issuedOn: '2021-03-12',
    expiresOn: '2031-03-12',
    categories: ['b', 'c'],
    verificationStatus: 'verified',
    purpose: 'основной допуск на грузовые',
  },
  {
    middleName: 'Второй',
    snils: '22222222290',
    personnelNo: 'Т-002',
    licenseNumber: '000002',
    issuedOn: '2022-06-05',
    expiresOn: '2032-06-05',
    categories: ['b', 'c'],
    verificationStatus: 'verified',
    purpose: 'второй допущенный — проверка сортировки «уже ездил на этой машине»',
  },
  {
    middleName: 'Третий',
    snils: '33333333334',
    personnelNo: 'Т-003',
    licenseNumber: '000003',
    issuedOn: '2020-09-18',
    expiresOn: '2030-09-18',
    categories: ['b', 'c', 'ce'],
    verificationStatus: 'verified',
    purpose: 'единственный, кто может сесть за тягач с прицепом',
  },
  {
    middleName: 'Четвёртый',
    snils: '44444444479',
    personnelNo: 'Т-004',
    licenseNumber: '000004',
    issuedOn: '2016-07-29',
    expiresOn: '2026-07-29',
    categories: ['b', 'c'],
    verificationStatus: 'verified',
    purpose: 'срок удостоверения истёк — в отбор не попадает',
  },
  {
    middleName: 'Пятый',
    snils: '55555555523',
    personnelNo: 'Т-005',
    licenseNumber: '000005',
    issuedOn: '2021-03-12',
    expiresOn: '2031-03-12',
    categories: ['b', 'c'],
    verificationStatus: 'verified',
    revokedAt: '2026-06-15T09:00:00.000Z',
    revokeReason: 'ТЕСТОВЫЕ ДАННЫЕ: лишение права управления',
    purpose: 'удостоверение аннулировано — в отбор не попадает',
  },
  {
    middleName: 'Шестой',
    snils: '66666666668',
    personnelNo: 'Т-006',
    licenseNumber: '000006',
    issuedOn: '2023-01-20',
    expiresOn: '2033-01-20',
    categories: ['b', 'c'],
    verificationStatus: 'unverified',
    purpose: 'документ не проверен — в отборе есть, но с пометкой',
  },
  {
    middleName: 'Седьмой',
    snils: '77777777712',
    personnelNo: 'Т-007',
    licenseNumber: '000007',
    issuedOn: '2023-01-20',
    expiresOn: '2033-01-20',
    categories: ['b', 'c'],
    verificationStatus: 'rejected',
    purpose: 'документ отклонён при проверке — в отбор не попадает',
  },
  {
    middleName: 'Восьмой',
    snils: '88888888857',
    personnelNo: 'Т-008',
    licenseNumber: '000008',
    issuedOn: '2019-11-14',
    expiresOn: '2029-11-14',
    categories: ['b'],
    verificationStatus: 'verified',
    purpose: 'нет категории C — на самосвал не отбирается',
  },
  {
    middleName: 'Девятый',
    snils: '99999999901',
    personnelNo: 'Т-009',
    licenseNumber: '000009',
    issuedOn: '2021-04-03',
    expiresOn: '2031-04-03',
    categories: ['b', 'c', 'ce'],
    categoryValidTo: { ce: '2026-06-01' },
    verificationStatus: 'verified',
    purpose: 'категория CE закрыта собственным сроком — на самосвал да, на тягач нет',
  },
];

async function purge(): Promise<void> {
  const deleted = await db.delete(persons).where(eq(persons.comment, MARKER)).returning({
    fullName: persons.fullName,
  });
  // Специализации, трудовые отношения, документы и их категории уходят каскадом от человека.
  console.log(`Удалено тестовых водителей: ${deleted.length}`);
}

async function seed(): Promise<void> {
  const [driverSpecialization] = await db
    .select({ id: specializations.id })
    .from(specializations)
    .where(eq(specializations.code, 'driver'));
  const [licenseType] = await db
    .select({ id: credentialTypes.id })
    .from(credentialTypes)
    .where(eq(credentialTypes.code, 'driver_license'));

  if (!driverSpecialization || !licenseType) {
    throw new Error(
      'Справочники не наполнены: примените миграцию 0058 (специализация «driver» и вид документа «driver_license»).',
    );
  }

  const codes = [...new Set(DRIVERS.flatMap((d) => d.categories))];
  const categoryRows = await db
    .select({ id: qualificationCategories.id, code: qualificationCategories.code })
    .from(qualificationCategories)
    .where(
      and(
        eq(qualificationCategories.credentialTypeId, licenseType.id),
        inArray(qualificationCategories.code, codes),
      ),
    );
  const categoryIdByCode = new Map(categoryRows.map((c) => [c.code, c.id]));
  const missing = codes.filter((c) => !categoryIdByCode.has(c));
  if (missing.length > 0) {
    throw new Error(`В справочнике нет категорий: ${missing.join(', ')}`);
  }

  let created = 0;
  for (const driver of DRIVERS) {
    // Идемпотентность по СНИЛС: он и есть ключ человека (ADR 0037).
    const [existing] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.snils, driver.snils));
    if (existing) continue;

    await db.transaction(async (tx) => {
      const [person] = await tx
        .insert(persons)
        .values({
          lastName: 'Тестовый',
          firstName: 'Водитель',
          middleName: driver.middleName,
          snils: driver.snils,
          comment: MARKER,
        })
        .returning({ id: persons.id });
      const personId = person!.id;

      await tx.insert(personSpecializations).values({
        personId,
        specializationId: driverSpecialization.id,
        isPrimary: true,
        startedOn: EMPLOYED_SINCE,
        comment: driver.purpose,
      });

      await tx.insert(personEmployments).values({
        personId,
        employmentType: 'staff',
        personnelNo: driver.personnelNo,
        jobTitle: 'Водитель',
        startedOn: EMPLOYED_SINCE,
        comment: MARKER,
      });

      const [credential] = await tx
        .insert(personCredentials)
        .values({
          personId,
          credentialTypeId: licenseType.id,
          series: '00 00',
          number: driver.licenseNumber,
          issuedOn: driver.issuedOn,
          expiresOn: driver.expiresOn,
          verificationStatus: driver.verificationStatus,
          // CHECK person_credentials_verified_at_check: отметка времени есть у всего, что
          // проверено или отклонено, и её нет у непроверенного.
          verifiedAt:
            driver.verificationStatus === 'unverified'
              ? null
              : new Date(`${driver.issuedOn}T12:00:00Z`),
          revokedAt: driver.revokedAt ? new Date(driver.revokedAt) : null,
          revokeReason: driver.revokeReason ?? '',
          comment: `${MARKER}: ${driver.purpose}`,
        })
        .returning({ id: personCredentials.id });

      await tx.insert(personCredentialCategories).values(
        driver.categories.map((code) => ({
          credentialId: credential!.id,
          qualificationCategoryId: categoryIdByCode.get(code)!,
          credentialTypeId: licenseType.id,
          validTo: driver.categoryValidTo?.[code] ?? null,
        })),
      );
    });
    created += 1;
  }

  console.log(`Заведено тестовых водителей: ${created} (всего в наборе ${DRIVERS.length}).`);
  if (created < DRIVERS.length) {
    console.log('Остальные уже были заведены — повторный запуск ничего не дублирует.');
  }
}

async function main(): Promise<void> {
  // Набор существует ради проверок; в проде выдуманные люди с выдуманными правами — мусор,
  // который потом невозможно отличить от настоящих записей.
  if (process.env.NODE_ENV === 'production') {
    console.error('Тестовые данные в production не заводятся.');
    process.exit(1);
  }

  if (process.argv.includes('--purge')) {
    await purge();
    return;
  }
  await seed();
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb().catch(() => {});
    process.exit(1);
  });
