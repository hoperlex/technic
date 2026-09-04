import {
  and,
  type AnyColumn,
  asc,
  count,
  desc,
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
  type CredentialTypeCode,
  type CredentialVerificationStatus,
  DRIVER_EXPERIENCE_MONTHS,
  type DriverDocumentGap,
  driverDocumentGaps,
  hasCategoryOn,
  JOB_TITLE_CREDENTIALS,
  requiredCredentialType,
  trailerCategoryCode,
  formatSnils,
  type WaybillLicense,
  waybillDocumentOf,
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающие функции годятся и в транзакции выписки листа, и вне её — форме подбора. */
type Reader = Tx | typeof db;

/**
 * Список водителей под машину (ADR 0037, ADR 0055, ADR 0064).
 *
 * Отбора здесь больше нет: функция отвечает не «кто может сесть за эту машину», а «кого можно
 * посадить и что при этом будет не так». Тем же запросом сервер собирает реквизиты присланного
 * человека, ограничив список одним `personId`, — одна функция в двух применениях, второму набору
 * правил разъехаться с первым негде.
 *
 * Ни комплект документов, ни категория прав никого не убирают (ADR 0064): первый едет в ответе
 * списком пробелов (`gaps`), вторая — флагом `matchesRequiredCategory`, а порядок списка считается
 * по обоим (`compareDriverOptions`). Сужают только два состояния, к качеству данных отношения не
 * имеющие: человек удалён из справочника или его специализация водителя в **эту дату** не
 * действовала (`activeOnCondition`, ADR 0101 п. 15).
 *
 * Закрывает отложенный пункт ADR 0008 («действующие допуски» функцией с датой-параметром).
 */

/** Код специализации, которой выражается водитель: отдельной таблицы для него нет (ADR 0008). */
export const DRIVER_SPECIALIZATION_CODE = 'driver';
/** Вид документа, по которому садятся за грузовой автомобиль. */
export const DRIVER_LICENSE_CODE = 'driver_license';
/** Вид документа, по которому садятся за погрузчик и экскаватор (миграция 0123, ADR 0095). */
export const TRACTOR_LICENSE_CODE = 'tractor_license';

/**
 * Каким документом человек допущен — выражением SQL (ADR 0095).
 *
 * То же правило, что `requiredCredentialType` в контрактах, и собрано оно из той же таблицы
 * `JOB_TITLE_CREDENTIALS`: второй список должностей, набранный руками в запросе, разошёлся бы с
 * первым в первой же правке. Запрос без него не обойтись — фильтр комплекта документов отбирает
 * страницу до выдачи строк, и посчитать должность в памяти сервер не может.
 *
 * Должность берётся из действующего трудового отношения; их у человека бывает несколько, и берётся
 * любое — как и везде, где портал спрашивает табельный номер (`selectDrivers`). Правило префикса
 * («водитель-экспедитор») здесь не нужно: оно даёт то же водительское удостоверение, что и `ELSE`.
 *
 * Сравнение идёт по нормализованной должности (`normalizedJobTitleSql`) — тем же приведением, что
 * `normalizeJobTitle` в контрактах: «Машинист  экскаватора» из кадровой выгрузки и «машинист
 * экскаватора» это одна должность, а не две.
 */
export function normalizedJobTitleSql(column: SQL | AnyColumn): SQL<string> {
  // Обратный слэш удвоен намеренно: тег `sql` обрабатывает escape-последовательности строки, и
  // одиночный «\s» дошёл бы до Postgres буквой «s» — тогда regexp_replace вырезал бы из должности
  // все «s» вместо пробелов, и «машинист» перестал бы совпадать сам с собой.
  return sql`lower(btrim(regexp_replace(${column}, '\\s+', ' ', 'g')))`;
}

export function requiredCredentialTypeSql(): SQL<CredentialTypeCode> {
  const jobTitle = sql`(
    SELECT ${normalizedJobTitleSql(sql`e.job_title`)}
    FROM ${personEmployments} e
    WHERE e.person_id = ${persons.id} AND e.ended_on IS NULL
    LIMIT 1
  )`;
  const byType = new Map<CredentialTypeCode, string[]>();
  for (const [title, type] of Object.entries(JOB_TITLE_CREDENTIALS)) {
    if (type === DRIVER_LICENSE_CODE) continue;
    byType.set(type, [...(byType.get(type) ?? []), title]);
  }
  const branches = [...byType].map(
    ([type, titles]) =>
      sql`WHEN ${jobTitle} IN (${sql.join(
        titles.map((t) => sql`${t}`),
        sql`, `,
      )}) THEN ${type}`,
  );
  return sql`CASE ${sql.join(branches, sql` `)} ELSE ${DRIVER_LICENSE_CODE} END`;
}

/**
 * Документ, по которому выпишется действительный путевой лист: годен на дату и заполнены графы,
 * которые печатает бланк. Спрашивает их фильтр справочника (`documents=complete`, EXISTS-подзапрос):
 * страницу отбирает сервер, и считать полноту в памяти он не может. То же правило в контрактах
 * записано для формы (`driverDocumentGaps`) — третьей копии быть не должно.
 *
 * Список водителей под машину этими условиями больше не сужается (ADR 0064): он считает те же
 * пробелы в памяти и показывает их пометкой.
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

/**
 * Полный комплект данных для путевого листа: СНИЛС человека и годное на сегодня удостоверение, у
 * которого заполнены номер и дата выдачи. Ровно эти графы бланк и печатает — правило целиком
 * записано в `driverDocumentGaps` для формы и в `licenseCompleteConditions` для запроса; здесь оно
 * только оборачивается в EXISTS, потому что фильтр применяется до страницы, и посчитать полноту по
 * выданным строкам сервер не может.
 *
 * Документ спрашивается того вида, которым человек допущен по должности (ADR 0095): у машиниста
 * экскаватора комплект закрывает тракторное удостоверение, а водительское — не закрывает, даже
 * если оно у него есть. Иначе фильтр показывал бы полным комплект, по которому лист не выпишется.
 *
 * Спрашивают его двое — справочник водителей и гараж (ADR 0076), — и спрашивают об одном:
 * выпишется ли по этому человеку лист на эту дату. Второй копии условия быть не должно.
 */
export function documentsCompleteCondition(on: string): SQL {
  return sql`${persons.snils} <> '' AND EXISTS (
    SELECT 1 FROM ${personCredentials}
    JOIN ${credentialTypes} ON ${credentialTypes.id} = ${personCredentials.credentialTypeId}
    WHERE ${personCredentials.personId} = ${persons.id}
      AND ${credentialTypes.code} = ${requiredCredentialTypeSql()}
      AND ${and(...licenseCompleteConditions(on))!}
  )`;
}

/**
 * Только водители: специализация действующая — уволенного из справочника не показывают.
 *
 * У удалённого человека действующей специализации не бывает: удаление само закрывает её сегодняшним
 * днём. Поэтому для архивной записи условие смягчено — иначе `includeDeleted` не показывал бы
 * ничего, а карточка удалённого водителя не открывалась бы даже администратору.
 */
export function driverCondition(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${personSpecializations} ps
    JOIN ${specializations} s ON s.id = ps.specialization_id
    WHERE ps.person_id = ${persons.id}
      AND (ps.ended_on IS NULL OR ${persons.deletedAt} IS NOT NULL)
      AND s.code = ${DRIVER_SPECIALIZATION_CODE}
  )`;
}

/**
 * Действовала ли кадровая запись в эту дату (ADR 0101 п. 15).
 *
 * Отбор водителя спрашивает не «кто числится сегодня», а «кого можно было посадить в этот день»:
 * лист выписывается и правится задним числом, и водитель, который вёз 5 августа и уволился 8-го,
 * обязан стоять в листе за 5-е. Проверка «запись не закрыта» (`ended_on IS NULL`) отвечает на
 * первый вопрос, а стояла она на месте второго — при том, что дата отбора приходит параметром.
 *
 * Правило одно на обе кадровые таблицы — специализацию и трудовое отношение: разъехавшись, они
 * дали бы водителя без должности, то есть лист с пустым табельным номером и не тем видом
 * документа (ADR 0095).
 *
 * Окно закрыто с обеих сторон. Нижняя граница отсекает нанятого после рейса — без неё
 * «исторический» отбор превратился бы в отбор без даты вовсе, и в лист за 5-е попал бы человек,
 * вышедший на работу 10-го. Верхняя включающая: день увольнения — ещё рабочий день, и рейс этого
 * дня за уволенным.
 *
 * `started_on` в обеих таблицах `NOT NULL DEFAULT CURRENT_DATE`, ветки «начало неизвестно» здесь
 * не бывает. Но у этого умолчания есть цена, и её надо знать: если кадровая выгрузка пришла без
 * даты приёма (`employedSince`), началом записан день заведения карточки — и человек, внесённый в
 * справочник уже после рейса, в отбор на дату рейса не попадёт. Смягчать это здесь нечем:
 * «началом считать минус бесконечность, когда дата приёма не заполнена» стёрло бы и настоящую
 * границу тоже, а качество кадровых дат чинится в справочнике, а не в запросе отбора.
 *
 * Запретом это правило не является (ADR 0037 п. 6): отбор — список выбора, а не валидатор. Но
 * тем же списком, суженным до одного человека, сервер сверяет присланного водителя — поэтому
 * окно обязано быть историческим и там: иначе коррекция задним числом отказывала бы в человеке,
 * которого сама же и предложила в форме.
 */
function activeOnCondition(started: AnyColumn, ended: AnyColumn, on: string): SQL {
  return sql`${started} <= ${on}::date AND (${ended} IS NULL OR ${ended} >= ${on}::date)`;
}

/**
 * Верхняя половина того же окна: запись не была закрыта **до** этой даты.
 *
 * Отдельным предикатом ради `findMachinist`, где нижняя граница брать нельзя (см. развёрнутое
 * обоснование там). Названа по тому, что проверяет, а не по тому, где применяется: «не закрыта
 * раньше» — самостоятельное условие, и читатель не должен догадываться, что это `activeOn` минус
 * одна строка.
 */
function notEndedBefore(ended: AnyColumn, on: string): SQL {
  return sql`(${ended} IS NULL OR ${ended} >= ${on}::date)`;
}

export interface DriverOption {
  personId: string;
  fullName: string;
  /** 11 цифр — как в базе; «112-233-445 95» отдаёт `snilsFormatted`. Пусто — не внесён. */
  snils: string;
  snilsFormatted: string;
  personnelNo: string;
  /** Должность из кадров; пусто — трудовое отношение не заведено. */
  jobTitle: string;
  /** Каким документом человек допущен по должности (`requiredCredentialType`, ADR 0095). */
  credentialTypeCode: CredentialTypeCode;
  /**
   * Документ, которым лист выпишется (`waybillDocumentOf`), — нужного вида, годный на дату и самый
   * заполненный из годных. `null` — годного нет: человек в списке остаётся (ADR 0064), а графы
   * бланка останутся пустыми, о чём и предупреждает `gaps`.
   */
  licenseId: string | null;
  licenseSeries: string;
  licenseNumber: string;
  licenseIssuedOn: string | null;
  licenseExpiresOn: string | null;
  /**
   * `unverified` в списке остаётся: это состояние учётной процедуры, а не отсутствие прав, и
   * останавливать работу из-за неразобранной бумаги нельзя. Интерфейс такого водителя помечает.
   * `null` — годного документа нет вовсе, и проверять нечего.
   */
  verificationStatus: CredentialVerificationStatus | null;
  /** Все категории документа («B», «C», «CE») — их печатает путевой лист и показывает форма. */
  categories: string[];
  /** Чего не хватает для листа на эту дату (`driverDocumentGaps`); пусто — комплект полный. */
  gaps: DriverDocumentGap[];
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
  /**
   * Какого документа требуемая категория. Требование ссылается на категорию любого вида (миграция
   * `0059` это предусматривала), и без вида «нужна C» не значит ничего: «C» водительского — это
   * грузовик, «C» тракториста — колёсная машина до 110 кВт.
   */
  categoryTypeCode: CredentialTypeCode | null;
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
      // Вид требуемой категории — из справочника, а не из предположения «раз машина, значит ВУ»:
      // ссылка на категорию идёт без привязки к виду, и у спецтехники там встанет тракторное.
      categoryTypeCode: sql<CredentialTypeCode | null>`${credentialTypes.code}`,
    })
    .from(vehicles)
    .leftJoin(
      qualificationCategories,
      eq(qualificationCategories.id, vehicles.requiredQualificationCategoryId),
    )
    .leftJoin(credentialTypes, eq(credentialTypes.id, qualificationCategories.credentialTypeId))
    .where(and(eq(vehicles.id, vehicleId), isNull(vehicles.deletedAt)));

  if (!row) return null;
  const asIs: VehicleRequirement = {
    vehicleId: row.vehicleId,
    categoryId: row.categoryId,
    categoryCode: row.categoryCode,
    categoryName: row.categoryName,
    categoryTypeCode: row.categoryTypeCode,
  };
  if (!row.categoryCode || !withTrailer) return asIs;

  const code = trailerCategoryCode(row.categoryCode);
  if (code === row.categoryCode) return asIs;

  // Прицепная категория ищется среди водительских: прицеп поднимает требование там, где машина
  // едет по дорогам, а у тракторного удостоверения E-версий категорий нет вовсе.
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
  if (!trailerCategory) return asIs;

  return {
    vehicleId: row.vehicleId,
    categoryId: trailerCategory.id,
    categoryCode: trailerCategory.code,
    categoryName: trailerCategory.name,
    categoryTypeCode: DRIVER_LICENSE_CODE,
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

/**
 * Удостоверение водителя в объёме, который спрашивают путевой лист и подсчёт пробелов: годность,
 * графы бланка и категории со своими сроками. Полного `DriverLicenseDto` здесь не собирают — кто
 * и когда проверил бумагу, списку выбора не нужно.
 */
export interface DriverLicenseRow extends WaybillLicense {
  id: string;
  categories: { code: string; name: string; validFrom: string | null; validTo: string | null }[];
}

/**
 * Должности людей **на их даты** — по трудовому отношению, действовавшему в этот день; нет такого
 * отношения — пустая строка.
 *
 * Дата здесь не удобство, а условие правдивости (ADR 0101 п. 15, §5 п. 12 плана). Должностью
 * выбирается вид требуемого документа (`requiredCredentialType`, ADR 0095), и посчитанная по
 * сегодняшней должности пометка о пробелах спорила бы с листом, выписанным по исторической: у
 * переведённого в машинисты водителя рейс прошлого месяца помечался бы нехваткой тракторного
 * удостоверения, которого у него тогда не спрашивали. Прежняя редакция брала «действующее сегодня»
 * (`ended_on IS NULL`) — ровно то, от чего отбор водителей уже отказался.
 *
 * Ключ ответа — пара «человек + дата» (`driverGapsKey`), а не один человек: тот же водитель ездит
 * в разные дни, и у пятидесяти рейсов страницы дат столько же. Запрос при этом один на всех, а
 * окно каждой пары считается в памяти: отношений у человека единицы, а пар — сотни, и полсотни
 * запросов с датой-параметром стоили бы дороже всей страницы.
 *
 * Отношений в окно даты попадает и несколько (несколько работодателей). Берётся самое позднее из
 * начавшихся — тем же правилом, что в `selectDrivers`: два места выбора одной должности обязаны
 * выбирать одинаково, иначе лист выпишется по одному документу, а предупреждение посчитается по
 * другому.
 */
export async function loadJobTitles(
  reader: Reader,
  people: readonly { personId: string; on: string }[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const personIds = [...new Set(people.map((p) => p.personId))];
  if (personIds.length === 0) return titles;

  const rows = await reader
    .select({
      personId: personEmployments.personId,
      jobTitle: personEmployments.jobTitle,
      startedOn: personEmployments.startedOn,
      endedOn: personEmployments.endedOn,
    })
    .from(personEmployments)
    .where(inArray(personEmployments.personId, personIds))
    .orderBy(asc(personEmployments.startedOn));

  for (const p of people) {
    const active = rows.filter(
      (r) =>
        r.personId === p.personId &&
        r.startedOn <= p.on &&
        (r.endedOn === null || r.endedOn >= p.on),
    );
    titles.set(driverGapsKey(p.personId, p.on), active.at(-1)?.jobTitle ?? '');
  }
  return titles;
}

/**
 * Документы найденных людей — все, а не только годные: годность считает `waybillDocumentOf`, и
 * считать её дважды разными способами (условием запроса и функцией контрактов) как раз и означало
 * бы две правды об одном документе. Виды тоже все: какой из них нужен, решает должность
 * (`waybillDocumentOf`), а отбирать его запросом значило бы завести третье место, где это решается.
 * Удалённые записи не в счёт: это не документ, а стёртая строка.
 *
 * Порядок — свежий документ первым, тот же, что в карточке водителя: из двух одинаково заполненных
 * годных удостоверений лист выпишется по свежему, а не по случайному.
 */
export async function loadDriverLicenses(
  reader: Reader,
  personIds: string[],
): Promise<Map<string, DriverLicenseRow[]>> {
  const map = new Map<string, DriverLicenseRow[]>();
  if (personIds.length === 0) return map;

  const rows = await reader
    .select({
      id: personCredentials.id,
      personId: personCredentials.personId,
      credentialTypeCode: sql<CredentialTypeCode>`${credentialTypes.code}`,
      series: personCredentials.series,
      number: personCredentials.number,
      issuedOn: personCredentials.issuedOn,
      expiresOn: personCredentials.expiresOn,
      revokedAt: personCredentials.revokedAt,
      verificationStatus: personCredentials.verificationStatus,
    })
    .from(personCredentials)
    .innerJoin(credentialTypes, eq(credentialTypes.id, personCredentials.credentialTypeId))
    .where(and(inArray(personCredentials.personId, personIds), isNull(personCredentials.deletedAt)))
    .orderBy(desc(personCredentials.issuedOn), desc(personCredentials.createdAt));

  const categories = await reader
    .select({
      credentialId: personCredentialCategories.credentialId,
      code: qualificationCategories.code,
      name: qualificationCategories.name,
      validFrom: personCredentialCategories.validFrom,
      validTo: personCredentialCategories.validTo,
    })
    .from(personCredentialCategories)
    .innerJoin(
      qualificationCategories,
      eq(qualificationCategories.id, personCredentialCategories.qualificationCategoryId),
    )
    .where(
      inArray(
        personCredentialCategories.credentialId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(qualificationCategories.sortOrder));

  const categoriesByLicense = new Map<string, DriverLicenseRow['categories']>();
  for (const c of categories) {
    const list = categoriesByLicense.get(c.credentialId) ?? [];
    list.push({ code: c.code, name: c.name, validFrom: c.validFrom, validTo: c.validTo });
    categoriesByLicense.set(c.credentialId, list);
  }

  for (const row of rows) {
    const list = map.get(row.personId) ?? [];
    list.push({
      id: row.id,
      credentialTypeCode: row.credentialTypeCode,
      series: row.series,
      number: row.number,
      issuedOn: row.issuedOn,
      expiresOn: row.expiresOn,
      // Аннулирование в контрактах — строка ISO: там его только сравнивают с `null`, а тип берут
      // от DTO, в котором дат-объектов не бывает вовсе.
      revokedAt: row.revokedAt?.toISOString() ?? null,
      verificationStatus: row.verificationStatus,
      categories: categoriesByLicense.get(row.id) ?? [],
    });
    map.set(row.personId, list);
  }
  return map;
}

/**
 * Чего не хватает этим водителям для листа на их даты (ADR 0064). Спрашивают карточка и список
 * рейсов: предупредить о пустых графах бланка нужно до выписки, а водитель у каждого рейса свой и
 * дата своя — тот же человек на вчерашний рейс годен, а на завтрашний уже с истёкшим документом.
 *
 * Пара «человек + дата» и есть ключ ответа (`driverGapsKey`): рейсов на странице до полусотни, а
 * запрос за удостоверениями один на всех.
 *
 * СНИЛС приходит вместе с человеком, а не добирается запросом: списки рейсов и так соединены с
 * `persons` ради ФИО, и второй заход за той же строкой был бы лишним. Должность — наоборот,
 * добирается здесь: она нужна только для выбора вида документа (ADR 0095), и таскать её через все
 * списки рейсов ради одного вопроса значило бы менять их запросы под внутреннее правило. Берётся
 * она на дату каждой пары (`loadJobTitles`), а не на сегодня: у прошедшего рейса вид требуемого
 * документа считается по той должности, по которой выписывался лист (ADR 0101, §5 п. 12 плана).
 */
export function driverGapsKey(personId: string, on: string): string {
  return `${personId}@${on}`;
}

export async function loadDriverGaps(
  reader: Reader,
  people: readonly { personId: string; snils: string; on: string }[],
): Promise<Map<string, DriverDocumentGap[]>> {
  const gaps = new Map<string, DriverDocumentGap[]>();
  if (people.length === 0) return gaps;

  const personIds = [...new Set(people.map((p) => p.personId))];
  const licensesByPerson = await loadDriverLicenses(reader, personIds);
  const jobTitles = await loadJobTitles(reader, people);
  for (const p of people) {
    const key = driverGapsKey(p.personId, p.on);
    gaps.set(
      key,
      driverDocumentGaps(
        {
          snils: p.snils,
          jobTitle: jobTitles.get(key) ?? '',
          licenses: licensesByPerson.get(p.personId) ?? [],
        },
        p.on,
      ),
    );
  }
  return gaps;
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
 * Кого можно посадить за эту машину в эту дату и что с каждым не так. Пустой список означает одно:
 * водителей, числившихся в справочнике на эту дату, нет вовсе.
 *
 * «На эту дату», а не «сегодня»: специализация и трудовое отношение сверяются с датой отбора
 * (`activeOnCondition`, ADR 0101 п. 15). Плановое окно назначения этим тоже меняется — уволившийся
 * появляется в отборе на даты внутри своего трудового отношения. Так и задумано: без этого лист за
 * прошлую неделю нельзя было бы выписать на того, кто её и отработал. Возврат к `ended_on IS NULL`
 * выглядел бы починкой, а был бы отменой ADR 0101 п. 15.
 *
 * Никаких условий, кроме «человек есть и он водитель» (ADR 0064): ни СНИЛС, ни удостоверение, ни
 * категория из списка никого не убирают. Пробелы комплекта считаются в памяти теми же функциями,
 * что показывают карточку водителя (`driverDocumentGaps`, `waybillDocumentOf`), и едут в ответе
 * рядом с человеком — вместе с документом, по которому лист выпишется, если его выписывать.
 *
 * Справочник водителей — сотни строк, поэтому три запроса вместо одного join'а осознанны: люди,
 * их удостоверения и категории этих удостоверений собираются отдельно и склеиваются в памяти.
 * Join размножил бы строки, а потом их всё равно пришлось бы склеивать обратно.
 */
export async function selectDrivers(
  params: DriverSelectionParams,
): Promise<DriverSelection | null> {
  const { vehicleId, on, withTrailer = false, personId } = params;

  const requirement = await loadRequirement(vehicleId, withTrailer);
  if (!requirement) return null;

  const rows = await db
    .selectDistinct({
      personId: persons.id,
      fullName: persons.fullName,
      snils: persons.snils,
    })
    .from(persons)
    .innerJoin(personSpecializations, eq(personSpecializations.personId, persons.id))
    .innerJoin(specializations, eq(specializations.id, personSpecializations.specializationId))
    .where(
      and(
        // Удалённый человек не возвращается и историческим окном (ADR 0101 п. 15): удаление значит
        // «его здесь не должно быть», а не «он уволился», и дата рейса этого не отменяет. Нужен
        // именно он — сначала восстановление записи, отдельным действием и своим правом.
        isNull(persons.deletedAt),
        // Водитель — человек, чья специализация действовала в эту дату, а не сегодня: уволенный
        // после рейса из листа за этот рейс не исчезает (ADR 0101 п. 15).
        activeOnCondition(personSpecializations.startedOn, personSpecializations.endedOn, on),
        eq(specializations.code, DRIVER_SPECIALIZATION_CODE),
        personId ? eq(persons.id, personId) : undefined,
      ),
    )
    .orderBy(asc(persons.fullName));

  if (rows.length === 0)
    return { requirement, requiredCategoryName: requirement.categoryName, drivers: [] };

  // Табельный номер с должностью, документы и их категории — добором по найденным.
  const personIds = rows.map((r) => r.personId);

  // Трудовое отношение — тем же историческим окном, что и специализация (ADR 0101 п. 15). Должность
  // здесь не украшение строки: ею выбирается вид документа для листа (`waybillDocumentOf`,
  // ADR 0095), и сегодняшняя должность для рейса трёхнедельной давности — ровно та же ошибка, что
  // сегодняшнее трудовое отношение: у переведённого в машинисты водителя лист за прошлый месяц
  // выписался бы по тракторному удостоверению, которого у него тогда не спрашивали.
  //
  // Отношений у человека бывает несколько (несколько работодателей), и в окно даты может попасть
  // не одно. Порядок по началу отношения делает выбор определённым: `Map` оставляет последнюю пару,
  // то есть самое позднее из действовавших в этот день, — а не ту строку, которую первой вернул
  // Postgres.
  const employments = await db
    .select({
      personId: personEmployments.personId,
      personnelNo: personEmployments.personnelNo,
      jobTitle: personEmployments.jobTitle,
    })
    .from(personEmployments)
    .where(
      and(
        inArray(personEmployments.personId, personIds),
        activeOnCondition(personEmployments.startedOn, personEmployments.endedOn, on),
      ),
    )
    .orderBy(asc(personEmployments.startedOn));
  const employmentByPerson = new Map(employments.map((e) => [e.personId, e]));

  const experience = await loadExperience(vehicleId, personIds, on);
  const licensesByPerson = await loadDriverLicenses(db, personIds);

  return {
    requirement,
    requiredCategoryName: requirement.categoryName,
    // Порядок — тем же правилом, что показывает форма: пригодные наверх (комплект документов,
    // затем категория — ADR 0055, ADR 0064), внутри них работавшие на этой машине по свежести,
    // остальные по алфавиту (ADR 0056). Запрос отдаёт список по ФИО, и сортировка здесь его
    // доупорядочивает — стабильная, поэтому равные остаются алфавитными.
    drivers: rows
      .map((r) => {
        const worked = experience.get(r.personId);
        const licenses = licensesByPerson.get(r.personId) ?? [];
        const jobTitle = employmentByPerson.get(r.personId)?.jobTitle ?? '';
        // Документ листа и пробелы комплекта — одним правилом на портал и на сервер: лист
        // выпишется по тому же удостоверению, о пробелах которого предупредили в форме. Вид
        // документа задаёт должность (ADR 0095): у машиниста погрузчика это тракторное.
        const license = waybillDocumentOf(licenses, jobTitle, on);
        return {
          personId: r.personId,
          fullName: r.fullName,
          snils: r.snils,
          snilsFormatted: r.snils === '' ? '' : formatSnils(r.snils),
          personnelNo: employmentByPerson.get(r.personId)?.personnelNo ?? '',
          jobTitle,
          credentialTypeCode: requiredCredentialType(jobTitle),
          licenseId: license?.id ?? null,
          licenseSeries: license?.series ?? '',
          licenseNumber: license?.number ?? '',
          licenseIssuedOn: license?.issuedOn ?? null,
          licenseExpiresOn: license?.expiresOn ?? null,
          verificationStatus: license?.verificationStatus ?? null,
          categories: license?.categories.map((c) => c.name) ?? [],
          gaps: driverDocumentGaps({ snils: r.snils, jobTitle, licenses }, on),
          // Требование не заведено — расхождению взяться неоткуда: пустое требование безопаснее
          // неверного, и помечать им человека значило бы предупреждать о незаполненном справочнике.
          //
          // Вид документа сверяется наравне с буквой: «C» тракториста не открывает грузовик, и
          // совпадение по одной букве было бы молча выданным допуском (ADR 0095).
          matchesRequiredCategory:
            requirement.categoryCode === null ||
            (requirement.categoryTypeCode === requiredCredentialType(jobTitle) &&
              hasCategoryOn(
                { categories: license?.categories ?? [] },
                requirement.categoryCode,
                on,
              )),
          workedRoutes: worked?.routes ?? 0,
          lastWorkedOn: worked?.lastWorkedOn ?? null,
        };
      })
      .sort(compareDriverOptions),
  };
}

/** Машинист строительной машины: ФИО и табельный номер бланка плюс его документ допуска. */
export interface MachinistOption {
  personId: string;
  fullName: string;
  personnelNo: string;
  jobTitle: string;
  /**
   * Документ, которым машинист допущен по должности, годный на дату (`waybillDocumentOf`);
   * `null` — годного нет. Бланк ЭСМ-2 его граф не содержит, но ключи листа заполняются из него:
   * снимок листа не должен зависеть от того, какие клетки размечены в шаблоне (ADR 0095).
   */
  license: DriverLicenseRow | null;
}

/**
 * Машинист для листа ЭСМ-2 — рядом с `selectDrivers`, но не внутри него, и это главное здесь.
 *
 * Отбора нет никакого, и с ADR 0164 — совсем никакого. `selectDrivers` отвечает на «кого посадить
 * за эту машину в эту дату» и считает пригодность по требованию машины; ЭСМ-2 выписывается на
 * неделю работы машины на площадке, требования у неё нет, и в лист идёт тот человек, которого
 * назначили заявке, — кем бы его ни числил справочник.
 *
 * **Специализация здесь больше не спрашивается, и это правка, а не упущение** (ADR 0164). Прежде
 * условием отбора стояла действующая запись `person_specializations` с кодом `driver`, и человек
 * без неё — или с закрытой раньше недели листа — отдавался как `null`. Ручная выписка отвечала на
 * это словами, а сверка выписывала лист молча и **с пустой графой ФИО**: машинистом заявки портал
 * ставит любого человека справочника (`openDayRoute` спрашивает существование, а не допуск), и
 * пустая фамилия делала бланк строгой отчётности недействительным. Кто числится водителем, решают
 * справочник водителей и форма подбора; печать имени человека, уже названного в листе, этого
 * вопроса не задаёт.
 *
 * Документ у машиниста есть — удостоверение тракториста-машиниста портал ведёт с миграции `0123`
 * (ADR 0095), — и он собирается тем же правилом, что у водителя: по должности и на дату. Годного
 * нет — ключи документа пусты, а выписка предупреждает об этом (`esm2IssueWarnings`); печатает ли
 * их бланк — вопрос шаблона, а не снимка.
 *
 * `null` означает теперь ровно одно: карточки в справочнике нет — она удалена (ADR 0101 п. 15:
 * удаление значит «его здесь не должно быть», и дата листа этого не отменяет). Лист на такого
 * человека не выписывается вовсе — ни рукой, ни сверкой.
 *
 * **Окно трудового отношения одностороннее, и это тоже решение** (ADR 0101 п. 15, Р21, §5 п. 11
 * плана). У `selectDrivers` окно закрыто с обеих сторон (`activeOnCondition`); здесь взята только
 * верхняя половина:
 *
 * ```text
 * ended_on IS NULL OR ended_on >= on        // взято
 * started_on <= on                          // НЕ взято
 * ```
 *
 * Верхняя граница — та самая, ради которой п. 13 и написан: у машиниста, отработавшего неделю и
 * уволившегося в следующий понедельник, лист за его неделю обязан печатать его табельный номер и
 * выбирать документ по его тогдашней должности, а `ended_on IS NULL` отвечал на другой вопрос —
 * «числится ли он сегодня».
 *
 * Нижнюю границу брать нельзя, и причина в данных, а не в правиле. `on` здесь — **начало недели
 * листа**, то есть прошлое уже при обычной выписке: лист за текущую неделю выписывают в среду, а
 * `started_on` трудового отношения при выгрузке без даты приёма равен `CURRENT_DATE`, дню
 * заведения карточки (§5 п. 10). Машинист, внесённый в справочник в среду, печатался бы на этой
 * самой неделе без табельного номера и не с тем видом документа (ADR 0095). Условие вида «или
 * дата приёма неизвестна» тут не выражается ничем: неизвестность записана обычной датой и от
 * настоящей неотличима.
 *
 * Отдельным «историческим режимом под коррекцией» это не делается намеренно: тогда один и тот же
 * человек печатался бы то с табельным номером, то без — в зависимости от того, каким входом лист
 * выписывают, — а `findMachinist` вызывается из сборки снимка, где вход уже не виден. Одно
 * правило на оба входа читается и проверяется, два — расходятся.
 */
export async function findMachinist(
  reader: Reader,
  personId: string,
  /** Дата, на которую читаются должность и документ: у листа ЭСМ-2 это начало недели. */
  on: string,
): Promise<MachinistOption | null> {
  const [row] = await reader
    .select({ personId: persons.id, fullName: persons.fullName })
    .from(persons)
    // Удалённый не возвращается и историческим окном: удаление значит «его здесь не должно
    // быть», а не «он уволился» (ADR 0101 п. 15).
    .where(and(eq(persons.id, personId), isNull(persons.deletedAt)));
  if (!row) return null;

  // Табельный номер с должностью — добором: работодателей у человека несколько, и join размножил
  // бы строку. Должность здесь не украшение: ею выбирается вид документа.
  //
  // Отношение односторонним окном (см. выше): закрытое раньше недели листа оставляет графы
  // табельного номера пустыми, но самого человека из бланка не убирает — фамилию печатает
  // карточка, а не кадровая запись. Порядок по началу отношения делает выбор определённым там,
  // где в окно попало не одно: берётся самое позднее из них — тот же выбор, что делает
  // `selectDrivers`.
  const [employment] = await reader
    .select({
      personnelNo: personEmployments.personnelNo,
      jobTitle: personEmployments.jobTitle,
    })
    .from(personEmployments)
    .where(
      and(eq(personEmployments.personId, personId), notEndedBefore(personEmployments.endedOn, on)),
    )
    .orderBy(desc(personEmployments.startedOn))
    .limit(1);

  const jobTitle = employment?.jobTitle ?? '';
  const licenses = (await loadDriverLicenses(reader, [personId])).get(personId) ?? [];
  return {
    ...row,
    personnelNo: employment?.personnelNo ?? '',
    jobTitle,
    license: waybillDocumentOf(licenses, jobTitle, on),
  };
}
