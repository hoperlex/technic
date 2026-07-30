import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  type CredentialVerificationStatus,
  trailerCategoryCode,
  formatSnils,
} from '@technic/contracts';
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
  vehicles,
} from '../db/schema';

/**
 * Отбор водителей под машину (ADR 0037).
 *
 * Допуск здесь — это отбор, а не проверка, которая отклоняет: портал показывает тех, кто может
 * сесть за эту машину в эту дату, и тем же запросом сервер убеждается в присланном человеке,
 * ограничив отбор одним `personId`. Одна функция в двух применениях — второму набору правил
 * разъехаться с первым негде.
 *
 * Закрывает отложенный пункт ADR 0008 («действующие допуски» функцией с датой-параметром).
 */

/** Код специализации, которой выражается водитель: отдельной таблицы для него нет (ADR 0008). */
const DRIVER_SPECIALIZATION_CODE = 'driver';
/** Вид документа, по которому садятся за грузовой автомобиль. */
const DRIVER_LICENSE_CODE = 'driver_license';

export interface DriverOption {
  personId: string;
  fullName: string;
  /** 11 цифр — как в базе; «112-233-445 95» отдаёт `snilsFormatted`. */
  snils: string;
  snilsFormatted: string;
  personnelNo: string;
  licenseId: string;
  licenseSeries: string;
  licenseNumber: string;
  licenseIssuedOn: string | null;
  licenseExpiresOn: string | null;
  /**
   * `unverified` в отбор входит: это состояние учётной процедуры, а не отсутствие прав, и
   * останавливать работу из-за неразобранной бумаги нельзя. Интерфейс такого водителя помечает.
   */
  verificationStatus: CredentialVerificationStatus;
  /** Все категории документа («B», «C», «CE») — их печатает путевой лист и показывает форма. */
  categories: string[];
}

/** Что требует машина: `categoryId` пуст — требование не заведено, и отбор по нему не сужается. */
export interface VehicleRequirement {
  vehicleId: string;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
}

export interface DriverSelection {
  requirement: VehicleRequirement;
  /** Требуемая категория с учётом прицепа: «C» превращается в «CE» (ADR 0037 п. 8). */
  requiredCategoryName: string | null;
  drivers: DriverOption[];
}

/**
 * Требование машины с поправкой на прицеп. Прицеп — признак рейса, поэтому категорию считаем
 * от кода: у машины стоит «C», а рейс с прицепом требует «CE», и такой категории у машины
 * в справочнике нет и быть не должно.
 */
async function loadRequirement(
  vehicleId: string,
  withTrailer: boolean,
): Promise<VehicleRequirement | null> {
  const [row] = await db
    .select({
      vehicleId: vehicles.id,
      categoryId: vehicles.requiredQualificationCategoryId,
      categoryCode: qualificationCategories.code,
      categoryName: qualificationCategories.name,
    })
    .from(vehicles)
    .leftJoin(
      qualificationCategories,
      eq(qualificationCategories.id, vehicles.requiredQualificationCategoryId),
    )
    .where(and(eq(vehicles.id, vehicleId), isNull(vehicles.deletedAt)));

  if (!row) return null;
  if (!row.categoryCode || !withTrailer) {
    return {
      vehicleId: row.vehicleId,
      categoryId: row.categoryId,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
    };
  }

  const code = trailerCategoryCode(row.categoryCode);
  if (code === row.categoryCode) {
    return {
      vehicleId: row.vehicleId,
      categoryId: row.categoryId,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
    };
  }

  const [trailerCategory] = await db
    .select({
      id: qualificationCategories.id,
      code: qualificationCategories.code,
      name: qualificationCategories.name,
    })
    .from(qualificationCategories)
    .innerJoin(credentialTypes, eq(credentialTypes.id, qualificationCategories.credentialTypeId))
    .where(
      and(eq(credentialTypes.code, DRIVER_LICENSE_CODE), eq(qualificationCategories.code, code)),
    );

  // Категории с прицепом нет в справочнике — сужаем по базовой: отсечь всех было бы хуже, чем
  // показать список, из которого диспетчер выберет по документу в руках.
  if (!trailerCategory) {
    return {
      vehicleId: row.vehicleId,
      categoryId: row.categoryId,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
    };
  }

  return {
    vehicleId: row.vehicleId,
    categoryId: trailerCategory.id,
    categoryCode: trailerCategory.code,
    categoryName: trailerCategory.name,
  };
}

export interface DriverSelectionParams {
  vehicleId: string;
  /** Дата рейса (YYYY-MM-DD). Параметром, а не «сегодня»: заявку берут в работу заранее. */
  on: string;
  withTrailer?: boolean;
  /** Ограничить отбор одним человеком — так сервер проверяет присланного водителя. */
  personId?: string;
}

/**
 * Кто может сесть за эту машину в эту дату. Пустой список — законный ответ: у машины требование,
 * под которое нет ни одного годного документа, и объяснять это должен интерфейс, а не молчание.
 *
 * СНИЛС обязателен: без него путевой лист недействителен, и водитель без номера в отборе не нужен —
 * иначе его выберут, а лист не выпишется.
 */
export async function selectDrivers(
  params: DriverSelectionParams,
): Promise<DriverSelection | null> {
  const { vehicleId, on, withTrailer = false, personId } = params;

  const requirement = await loadRequirement(vehicleId, withTrailer);
  if (!requirement) return null;

  const conditions = [
    isNull(persons.deletedAt),
    sql`${persons.snils} <> ''`,
    // Водитель — человек с действующей специализацией: увольняясь, её закрывают.
    isNull(personSpecializations.endedOn),
    eq(specializations.code, DRIVER_SPECIALIZATION_CODE),
    // Документ: живой, не аннулированный, не отклонённый и не истёкший на дату рейса.
    isNull(personCredentials.deletedAt),
    isNull(personCredentials.revokedAt),
    sql`${personCredentials.verificationStatus} <> 'rejected'`,
    or(isNull(personCredentials.expiresOn), gte(personCredentials.expiresOn, on))!,
  ];

  if (personId) conditions.push(eq(persons.id, personId));

  // Требование не заведено — по категории не сужаем: пустое требование безопаснее неверного,
  // а отсечь всех из-за незаполненного справочника хуже, чем показать список пошире.
  if (requirement.categoryId) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${personCredentialCategories} pcc
        WHERE pcc.credential_id = ${personCredentials.id}
          AND pcc.qualification_category_id = ${requirement.categoryId}
          AND (pcc.valid_from IS NULL OR pcc.valid_from <= ${on}::date)
          AND (pcc.valid_to IS NULL OR pcc.valid_to >= ${on}::date)
      )`,
    );
  }

  const rows = await db
    .selectDistinct({
      personId: persons.id,
      fullName: persons.fullName,
      snils: persons.snils,
      licenseId: personCredentials.id,
      licenseSeries: personCredentials.series,
      licenseNumber: personCredentials.number,
      licenseIssuedOn: personCredentials.issuedOn,
      licenseExpiresOn: personCredentials.expiresOn,
      verificationStatus: personCredentials.verificationStatus,
    })
    .from(persons)
    .innerJoin(personSpecializations, eq(personSpecializations.personId, persons.id))
    .innerJoin(specializations, eq(specializations.id, personSpecializations.specializationId))
    .innerJoin(personCredentials, eq(personCredentials.personId, persons.id))
    .innerJoin(credentialTypes, eq(credentialTypes.id, personCredentials.credentialTypeId))
    .where(and(...conditions, eq(credentialTypes.code, DRIVER_LICENSE_CODE)))
    .orderBy(asc(persons.fullName));

  if (rows.length === 0)
    return { requirement, requiredCategoryName: requirement.categoryName, drivers: [] };

  // Табельный номер и категории — добором по найденным: join'ить их к основному запросу значило бы
  // размножить строки и потом склеивать людей обратно.
  const personIds = rows.map((r) => r.personId);
  const licenseIds = rows.map((r) => r.licenseId);

  const employments = await db
    .select({ personId: personEmployments.personId, personnelNo: personEmployments.personnelNo })
    .from(personEmployments)
    .where(and(inArray(personEmployments.personId, personIds), isNull(personEmployments.endedOn)));
  const personnelByPerson = new Map(employments.map((e) => [e.personId, e.personnelNo]));

  const categories = await db
    .select({
      credentialId: personCredentialCategories.credentialId,
      name: qualificationCategories.name,
      sortOrder: qualificationCategories.sortOrder,
    })
    .from(personCredentialCategories)
    .innerJoin(
      qualificationCategories,
      eq(qualificationCategories.id, personCredentialCategories.qualificationCategoryId),
    )
    .where(inArray(personCredentialCategories.credentialId, licenseIds))
    .orderBy(asc(qualificationCategories.sortOrder));
  const categoriesByLicense = new Map<string, string[]>();
  for (const c of categories) {
    const list = categoriesByLicense.get(c.credentialId) ?? [];
    list.push(c.name);
    categoriesByLicense.set(c.credentialId, list);
  }

  return {
    requirement,
    requiredCategoryName: requirement.categoryName,
    drivers: rows.map((r) => ({
      personId: r.personId,
      fullName: r.fullName,
      snils: r.snils,
      snilsFormatted: formatSnils(r.snils),
      personnelNo: personnelByPerson.get(r.personId) ?? '',
      licenseId: r.licenseId,
      licenseSeries: r.licenseSeries,
      licenseNumber: r.licenseNumber,
      licenseIssuedOn: r.licenseIssuedOn,
      licenseExpiresOn: r.licenseExpiresOn,
      verificationStatus: r.verificationStatus,
      categories: categoriesByLicense.get(r.licenseId) ?? [],
    })),
  };
}

/** Годен ли конкретный человек за эту машину: тот же отбор, ограниченный одним `personId`. */
export async function isDriverAllowed(
  params: Omit<DriverSelectionParams, 'personId'> & { personId: string },
): Promise<boolean> {
  const selection = await selectDrivers(params);
  return (selection?.drivers.length ?? 0) > 0;
}
