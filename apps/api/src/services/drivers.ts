import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  compareDriverOptions,
  type CredentialVerificationStatus,
  DRIVER_EXPERIENCE_MONTHS,
  hasCategoryOn,
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
  vehicleRequests,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  waybills,
} from '../db/schema';

/**
 * Отбор водителей под машину (ADR 0037, ADR 0055).
 *
 * Допуск здесь — это отбор, а не проверка, которая отклоняет: портал показывает тех, кто может
 * сесть за эту машину в эту дату, и тем же запросом сервер убеждается в присланном человеке,
 * ограничив отбор одним `personId`. Одна функция в двух применениях — второму набору правил
 * разъехаться с первым негде.
 *
 * Сужает список комплект документов, а не категория прав (ADR 0055): без СНИЛСа, действующего
 * удостоверения, его номера и даты выдачи путевой лист печатается недействительным, и такого
 * водителя предлагать нечем. Категория машине проставлена скопом по типу техники (миграция
 * `0059`) и осталась справочной — расхождение с ней отдаётся флагом, а не пустым списком.
 *
 * Закрывает отложенный пункт ADR 0008 («действующие допуски» функцией с датой-параметром).
 */

/** Код специализации, которой выражается водитель: отдельной таблицы для него нет (ADR 0008). */
export const DRIVER_SPECIALIZATION_CODE = 'driver';
/** Вид документа, по которому садятся за грузовой автомобиль. */
export const DRIVER_LICENSE_CODE = 'driver_license';

/**
 * Документ, по которому выпишется действительный путевой лист: годен на дату и заполнены графы,
 * которые печатает бланк. Условия собраны здесь одним набором, потому что их спрашивают в двух
 * местах — отбором под машину (join к `person_credentials`) и фильтром справочника (EXISTS): то же
 * правило в контрактах записано для формы (`driverDocumentGaps`), и третьей копии быть не должно.
 *
 * Срок действия в комплект не входит: пустой — бессрочный документ, а не пустая графа. Проверка
 * бумаги (`unverified`) тоже: это состояние учётной процедуры, а не отсутствие прав.
 */
export function licenseCompleteConditions(on: string): SQL[] {
  return [
    isNull(personCredentials.deletedAt),
    isNull(personCredentials.revokedAt),
    sql`${personCredentials.verificationStatus} <> 'rejected'`,
    or(isNull(personCredentials.expiresOn), gte(personCredentials.expiresOn, on))!,
    sql`btrim(${personCredentials.series} || ${personCredentials.number}) <> ''`,
    isNotNull(personCredentials.issuedOn),
  ];
}

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
  /** Открыта ли требуемая машиной категория на дату рейса. Ничего не запрещает (ADR 0055). */
  matchesRequiredCategory: boolean;
  /** Состоявшихся рейсов этой машины с этим водителем за последний год (ADR 0056). */
  workedRoutes: number;
  /** День последнего такого рейса; `null` — не работал. По нему список стоит по свежести. */
  lastWorkedOn: string | null;
}

/** Что требует машина: `categoryId` пуст — требование не заведено, и расхождению взяться неоткуда. */
export interface VehicleRequirement {
  vehicleId: string;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
}

export interface DriverSelection {
  requirement: VehicleRequirement;
  /**
   * Требуемая категория с учётом прицепа: «C» превращается в «CE» (ADR 0037 п. 8). Список ею не
   * сужается (ADR 0055) — ею называют расхождение в предупреждении.
   */
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

/**
 * Кто из найденных водителей уже работал на этой машине (ADR 0056).
 *
 * Работой считается состоявшийся рейс, а не назначение: рейс заводят заранее и переигрывают, и
 * «стоял в плане» опытом не является. Состоявшийся — это выполненная заявка в составе рейса либо
 * выписанный и не аннулированный лист: первое говорит, что работу закрыли, второе — что человек
 * за руль сел, даже если заявку ещё не закрыли. Одного признака мало: заявку закрывают не в тот
 * же день, а лист выписывают не на всякий рейс.
 *
 * Окно считается от даты рейса, а не от «сегодня»: на неё же считается годность документов в
 * этом отборе, и ответ не должен зависеть от дня, когда открыли форму. Верхняя граница — сама
 * дата: рейс, заведённый на следующую неделю, это план, а не опыт.
 */
async function loadExperience(
  vehicleId: string,
  personIds: string[],
  on: string,
): Promise<Map<string, { routes: number; lastWorkedOn: string }>> {
  const rows = await db
    .select({
      personId: vehicleRoutes.driverPersonId,
      routes: count(),
      lastWorkedOn: sql<string>`max(${vehicleRoutes.routeDate})`,
    })
    .from(vehicleRoutes)
    .where(
      and(
        eq(vehicleRoutes.vehicleId, vehicleId),
        inArray(vehicleRoutes.driverPersonId, personIds),
        gte(
          vehicleRoutes.routeDate,
          sql`${on}::date - make_interval(months => ${DRIVER_EXPERIENCE_MONTHS})`,
        ),
        lte(vehicleRoutes.routeDate, sql`${on}::date`),
        or(
          sql`EXISTS (
            SELECT 1 FROM ${vehicleRouteRequests} rr
            JOIN ${vehicleRequests} vr ON vr.id = rr.request_id
            WHERE rr.route_id = ${vehicleRoutes.id}
              AND vr.status = 'done'
              AND vr.deleted_at IS NULL
          )`,
          sql`EXISTS (
            SELECT 1 FROM ${waybills} w
            WHERE w.route_id = ${vehicleRoutes.id}
              AND w.status <> 'cancelled'
          )`,
        )!,
      ),
    )
    .groupBy(vehicleRoutes.driverPersonId);

  return new Map(
    rows
      .filter((r): r is typeof r & { personId: string } => r.personId !== null)
      .map((r) => [r.personId, { routes: Number(r.routes), lastWorkedOn: r.lastWorkedOn }]),
  );
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
 * Кто может сесть за эту машину в эту дату. Пустой список — законный ответ: ни у кого нет полного
 * комплекта документов на эту дату, и объяснять это должен интерфейс, а не молчание.
 *
 * Сужает комплект документов (`licenseCompleteConditions`), а не категория прав (ADR 0055): СНИЛС,
 * номер удостоверения и дата его выдачи печатаются в бланке, и без любого из них лист выйдет
 * недействительным — предлагать такого водителя незачем. Категория расхождением не отсекает: она
 * возвращается флагом `matchesRequiredCategory`, а решение оставлено человеку.
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
    // Документ: годный на дату рейса и с заполненными графами бланка.
    ...licenseCompleteConditions(on),
  ];

  if (personId) conditions.push(eq(persons.id, personId));

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

  const experience = await loadExperience(vehicleId, personIds, on);

  // Сроки категории берутся вместе с именем: по ним считается соответствие требованию машины —
  // той же функцией, что показывает карточку водителя, чтобы правило не разошлось надвое.
  const categories = await db
    .select({
      credentialId: personCredentialCategories.credentialId,
      code: qualificationCategories.code,
      name: qualificationCategories.name,
      validFrom: personCredentialCategories.validFrom,
      validTo: personCredentialCategories.validTo,
      sortOrder: qualificationCategories.sortOrder,
    })
    .from(personCredentialCategories)
    .innerJoin(
      qualificationCategories,
      eq(qualificationCategories.id, personCredentialCategories.qualificationCategoryId),
    )
    .where(inArray(personCredentialCategories.credentialId, licenseIds))
    .orderBy(asc(qualificationCategories.sortOrder));
  type LicenseCategory = (typeof categories)[number];
  const categoriesByLicense = new Map<string, LicenseCategory[]>();
  for (const c of categories) {
    const list = categoriesByLicense.get(c.credentialId) ?? [];
    list.push(c);
    categoriesByLicense.set(c.credentialId, list);
  }

  return {
    requirement,
    requiredCategoryName: requirement.categoryName,
    // Порядок — тем же правилом, что показывает форма: подходящие по категории наверх (ADR 0055),
    // внутри них работавшие на этой машине по свежести, остальные по алфавиту (ADR 0056). Запрос
    // отдаёт список по ФИО, и сортировка здесь его доупорядочивает — стабильная, поэтому равные
    // остаются алфавитными.
    drivers: rows
      .map((r) => {
        const worked = experience.get(r.personId);
        const licenseCategories = categoriesByLicense.get(r.licenseId) ?? [];
        return {
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
          categories: licenseCategories.map((c) => c.name),
          // Требование не заведено — расхождению взяться неоткуда: пустое требование безопаснее
          // неверного, и помечать им человека значило бы предупреждать о незаполненном справочнике.
          matchesRequiredCategory:
            requirement.categoryCode === null ||
            hasCategoryOn({ categories: licenseCategories }, requirement.categoryCode, on),
          workedRoutes: worked?.routes ?? 0,
          lastWorkedOn: worked?.lastWorkedOn ?? null,
        };
      })
      .sort(compareDriverOptions),
  };
}

/**
 * Хватает ли документов этому человеку, чтобы выйти в рейс на этой машине: тот же отбор,
 * ограниченный одним `personId`. Категория ответа не меняет (ADR 0055) — она справочная.
 */
export async function isDriverAllowed(
  params: Omit<DriverSelectionParams, 'personId'> & { personId: string },
): Promise<boolean> {
  const selection = await selectDrivers(params);
  return (selection?.drivers.length ?? 0) > 0;
}
