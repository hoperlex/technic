import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  can,
  CREDENTIAL_TYPE_CODES,
  createDriverSchema,
  type CredentialTypeCode,
  credentialTypeLabels,
  type DriverDto,
  type DriverJobTitleDto,
  type DriverLicenseDto,
  driverLicenseInputSchema,
  driverListQuerySchema,
  type DriverSelectionDto,
  driverSelectionQuerySchema,
  isPersonScopedRole,
  isValidSnils,
  LICENSE_NUMBER_RACE_MESSAGE,
  licenseNumberLabel,
  licenseNumberTakenMessage,
  normalizeJobTitle,
  requiredCredentialType,
  revokeDriverLicenseSchema,
  SNILS_CHECKSUM_MESSAGE,
  updateDriverSchema,
  verifyDriverLicenseSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  credentialTypes,
  files,
  personCredentialCategories,
  personCredentialFiles,
  personCredentials,
  personEmployments,
  persons,
  personSpecializations,
  qualificationCategories,
  specializations,
  users,
} from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { assertArchiveVisible } from '../lib/access';
import { orderByFrom, pageParams, phoneSearchCondition, searchCondition } from '../lib/pagination';
import {
  DRIVER_SPECIALIZATION_CODE,
  documentsCompleteCondition,
  driverCondition,
  normalizedJobTitleSql,
  selectDrivers,
} from '../services/drivers';
import { registerPurgeRoute } from '../services/directory-purge';
import { hardDeleteFiles } from '../services/request-files';

/**
 * Справочник водителей (ADR 0037, ADR 0008, ADR 0095).
 *
 * Отдельной таблицы водителей нет: карточка собирает физлицо, его специализацию, трудовое
 * отношение и документы допуска с категориями. Заводить их четырьмя экранами значило бы дать
 * остановиться на полпути — водитель без документа в отбор не попадёт и молча пропадёт из формы
 * перевода заявки в работу.
 *
 * Документов справочник ведёт два вида — водительское удостоверение и удостоверение
 * тракториста-машиниста, — и оба показывает у каждого человека: у водителя, пересевшего на
 * погрузчик, они бывают сразу оба. А какой из них у человека спрашивают — комплект документов,
 * путевой лист, требование машины, — решает должность действующего трудового отношения
 * (`requiredCredentialType`), а не выбор в форме: за экскаватор садятся по тракторному, и
 * водительское его не заменяет, даже когда оно заполнено лучше.
 *
 * Право своё, а не `directories.*`: в карточке лежат персональные данные, и открывать их каждому,
 * кому нужен список типов ТС, нельзя.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

/**
 * Справочные идентификаторы, без которых водителя не завести: специализация и виды документов
 * (миграции 0058 и 0123).
 *
 * Виды берутся оба сразу, а не запрошенный: их всего два, справочник их не меняет, а ходить за
 * идентификатором вида на каждое действие с документом значило бы делать второй запрос ради
 * строки, которая уже в руках.
 */
async function loadDirectoryIds(): Promise<{
  specializationId: string;
  credentialTypeIds: Record<CredentialTypeCode, string>;
}> {
  const [specialization] = await db
    .select({ id: specializations.id })
    .from(specializations)
    .where(eq(specializations.code, DRIVER_SPECIALIZATION_CODE));
  const types = await db
    .select({ id: credentialTypes.id, code: credentialTypes.code })
    .from(credentialTypes)
    .where(inArray(credentialTypes.code, [...CREDENTIAL_TYPE_CODES]));

  const byCode = new Map(types.map((t) => [t.code, t.id]));
  if (!specialization || CREDENTIAL_TYPE_CODES.some((code) => !byCode.has(code))) {
    throw err.conflict(
      'Справочник специализаций и видов документов не наполнен: примените миграции 0058 и 0123',
    );
  }
  return {
    specializationId: specialization.id,
    credentialTypeIds: Object.fromEntries(
      CREDENTIAL_TYPE_CODES.map((code) => [code, byCode.get(code)!]),
    ) as Record<CredentialTypeCode, string>,
  };
}

interface PersonRow {
  id: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  birthDate: string | null;
  phone: string;
  email: string;
  snils: string;
  comment: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  personnelNo: string | null;
  jobTitle: string | null;
  employedSince: string | null;
}

/**
 * Документы найденных людей — добором: join'ить их к списку значило бы размножить строки.
 *
 * Оба вида сразу (ADR 0095): карточка показывает и водительское, и тракторное удостоверение, а
 * какой из них подставится в лист, решает должность (`waybillDocumentOf`) — отбирать вид запросом
 * значило бы завести второе место, где это решается.
 */
async function licensesByPerson(personIds: string[]): Promise<Map<string, DriverLicenseDto[]>> {
  const map = new Map<string, DriverLicenseDto[]>();
  if (personIds.length === 0) return map;

  const rows = await db
    .select({
      id: personCredentials.id,
      personId: personCredentials.personId,
      credentialTypeCode: sql<CredentialTypeCode>`${credentialTypes.code}`,
      series: personCredentials.series,
      number: personCredentials.number,
      issuedOn: personCredentials.issuedOn,
      expiresOn: personCredentials.expiresOn,
      issuedBy: personCredentials.issuedBy,
      verificationStatus: personCredentials.verificationStatus,
      verifiedAt: personCredentials.verifiedAt,
      verifiedByName: users.fullName,
      revokedAt: personCredentials.revokedAt,
      revokeReason: personCredentials.revokeReason,
    })
    .from(personCredentials)
    .innerJoin(credentialTypes, eq(credentialTypes.id, personCredentials.credentialTypeId))
    .leftJoin(users, eq(users.id, personCredentials.verifiedBy))
    .where(and(inArray(personCredentials.personId, personIds), isNull(personCredentials.deletedAt)))
    // Свежий документ первым: им человек и ездит, старые остаются историей.
    .orderBy(desc(personCredentials.issuedOn), desc(personCredentials.createdAt));

  const categories = await db
    .select({
      credentialId: personCredentialCategories.credentialId,
      categoryId: qualificationCategories.id,
      code: qualificationCategories.code,
      name: qualificationCategories.name,
      validFrom: personCredentialCategories.validFrom,
      validTo: personCredentialCategories.validTo,
      restrictions: personCredentialCategories.restrictions,
      sortOrder: qualificationCategories.sortOrder,
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

  const categoriesByLicense = new Map<string, DriverLicenseDto['categories']>();
  for (const c of categories) {
    const list = categoriesByLicense.get(c.credentialId) ?? [];
    list.push({
      categoryId: c.categoryId,
      code: c.code,
      name: c.name,
      validFrom: c.validFrom,
      validTo: c.validTo,
      restrictions: c.restrictions,
    });
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
      issuedBy: row.issuedBy,
      verificationStatus: row.verificationStatus,
      verifiedByName: row.verifiedByName,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokeReason: row.revokeReason,
      categories: categoriesByLicense.get(row.id) ?? [],
    });
    map.set(row.personId, list);
  }
  return map;
}

function toDto(row: PersonRow, licenses: DriverLicenseDto[]): DriverDto {
  return {
    id: row.id,
    lastName: row.lastName,
    firstName: row.firstName,
    middleName: row.middleName,
    fullName: row.fullName,
    birthDate: row.birthDate,
    phone: row.phone,
    email: row.email,
    snils: row.snils,
    comment: row.comment,
    personnelNo: row.personnelNo ?? '',
    jobTitle: row.jobTitle ?? '',
    employedSince: row.employedSince,
    licenses,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/**
 * Нормализованная должность действующего трудового отношения — одним выражением на список
 * должностей и на фильтр по ним (ADR 0095): группируется и сравнивается одно и то же, иначе фильтр
 * не нашёл бы строку, которую сам же и предложил. Приведение общее с фильтром комплекта документов
 * (`normalizedJobTitleSql`) и парное `normalizeJobTitle` из контрактов — трёх правд о должности
 * быть не должно.
 */
const jobTitleKeySql = normalizedJobTitleSql(personEmployments.jobTitle);

/** Действующее трудовое отношение — источник табельного номера и должности для бланка. */
const employmentJoin = {
  personnelNo: personEmployments.personnelNo,
  jobTitle: personEmployments.jobTitle,
  employedSince: personEmployments.startedOn,
};

const personSelect = {
  id: persons.id,
  lastName: persons.lastName,
  firstName: persons.firstName,
  middleName: persons.middleName,
  fullName: persons.fullName,
  birthDate: persons.birthDate,
  phone: persons.phone,
  email: persons.email,
  snils: persons.snils,
  comment: persons.comment,
  version: persons.version,
  createdAt: persons.createdAt,
  updatedAt: persons.updatedAt,
  deletedAt: persons.deletedAt,
  ...employmentJoin,
};

/**
 * Сегодня по московскому времени — ею меряется срок документа в фильтре комплекта. Тем же
 * временем берётся дата рейса при выписке листа (`tripDate`): справочник и бланк обязаны считать
 * просроченным одно и то же, а UTC ночью отстаёт на день.
 */
function todayInMoscow(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * У кого открыта эта категория на сегодня (ADR 0055). Справочный вопрос — «кого можно посадить за
 * седельный тягач», — а не отбор под конкретную машину: тот считается на дату рейса и категорией
 * не сужается. Сроки самой категории учитываются: открытая до июня к июлю закрыта, даже если
 * удостоверение действует.
 *
 * Годность документа проверяется, а полнота реквизитов — нет: справочник тем и живёт, что
 * показывает недозаполненных, и фильтр по категории не должен молча прятать их от того, кто
 * пришёл именно за ними.
 */
function categoryCondition(categoryId: string, on: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${personCredentials}
    JOIN ${personCredentialCategories}
      ON ${personCredentialCategories.credentialId} = ${personCredentials.id}
    WHERE ${personCredentials.personId} = ${persons.id}
      AND ${personCredentialCategories.qualificationCategoryId} = ${categoryId}
      AND ${personCredentials.deletedAt} IS NULL
      AND ${personCredentials.revokedAt} IS NULL
      AND ${personCredentials.verificationStatus} <> 'rejected'
      AND (${personCredentials.expiresOn} IS NULL OR ${personCredentials.expiresOn} >= ${on}::date)
      AND (${personCredentialCategories.validFrom} IS NULL
        OR ${personCredentialCategories.validFrom} <= ${on}::date)
      AND (${personCredentialCategories.validTo} IS NULL
        OR ${personCredentialCategories.validTo} >= ${on}::date)
  )`;
}

/**
 * Все ли присланные категории принадлежат этому виду документа (ADR 0095).
 *
 * Пару «документ + категория» держит составной внешний ключ (`0019`), и без этой проверки портал
 * отвечал бы на «B» тракторного в водительском удостоверении ошибкой базы — то есть 500 и текстом
 * про ограничение. Категории у видов называются одними буквами, перепутать их в форме — обычное
 * дело, и ответ должен называть причину.
 */
async function assertCategoriesOf(
  tx: Tx,
  type: CredentialTypeCode,
  credentialTypeId: string,
  categories: readonly { categoryId: string }[],
): Promise<void> {
  if (categories.length === 0) return;
  const ids = [...new Set(categories.map((c) => c.categoryId))];
  const rows = await tx
    .select({ id: qualificationCategories.id })
    .from(qualificationCategories)
    .where(
      and(
        inArray(qualificationCategories.id, ids),
        eq(qualificationCategories.credentialTypeId, credentialTypeId),
      ),
    );
  if (rows.length === ids.length) return;
  throw err.validation({
    categories:
      `Категория не из документа «${credentialTypeLabels[type]}»: ` +
      'у водительского и тракторного удостоверений свои списки категорий',
  });
}

async function loadDriver(id: string): Promise<{ row: PersonRow; dto: DriverDto } | null> {
  const [row] = await db
    .select(personSelect)
    .from(persons)
    .leftJoin(
      personEmployments,
      and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
    )
    .where(and(eq(persons.id, id), driverCondition()));

  if (!row) return null;
  const licenses = await licensesByPerson([row.id]);
  return { row, dto: toDto(row, licenses.get(row.id) ?? []) };
}

/**
 * Снять документы одного вида у человека — пометкой, как и всё остальное в справочнике.
 *
 * Строка остаётся: по ней объясняются выписанные листы и назначения прошлых лет, а `deleted_at`
 * снимает её со всех чтений разом — все они фильтруют по нему. Заодно освобождается серия с
 * номером: частичный уникальный индекс стережёт только неудалённые.
 */
async function dropLicensesOf(
  tx: Tx,
  personId: string,
  credentialTypeId: string,
  actorUserId: string,
): Promise<string[]> {
  const dropped = await tx
    .update(personCredentials)
    .set({
      deletedAt: new Date(),
      deletedBy: actorUserId,
      updatedBy: actorUserId,
      updatedAt: new Date(),
      version: sql`${personCredentials.version} + 1`,
    })
    .where(
      and(
        eq(personCredentials.personId, personId),
        eq(personCredentials.credentialTypeId, credentialTypeId),
        isNull(personCredentials.deletedAt),
      ),
    )
    .returning({ id: personCredentials.id });
  return dropped.map((r) => r.id);
}

/**
 * Свободны ли серия с номером — до вставки, ради человеческого ответа.
 *
 * Уникальность стережёт БД (`person_credentials_number_unique`), и предпроверка её не заменяет:
 * гонку ловит `asLicenseNumberConflict`. Но её отказ называет поле формы и говорит, чей это номер,
 * — а 23505 сам по себе доходил бы до общего обработчика ошибкой 500.
 */
async function assertNumberFree(
  tx: Tx,
  personId: string,
  credentialTypeId: string,
  license: { series: string; number: string },
  field: string,
): Promise<void> {
  // Пустой номер индекс не стережёт (`WHERE number <> ''`): документ по одним категориям заводится
  // и без него, и сверять тут нечего.
  if (license.number === '') return;
  const [taken] = await tx
    .select({ personId: personCredentials.personId })
    .from(personCredentials)
    .where(
      and(
        eq(personCredentials.credentialTypeId, credentialTypeId),
        eq(personCredentials.series, license.series),
        eq(personCredentials.number, license.number),
        isNull(personCredentials.deletedAt),
      ),
    );
  if (!taken) return;
  throw err.validation({ [field]: licenseNumberTakenMessage(taken.personId === personId) });
}

/** Тот же отказ, но пришедший гонкой: между предпроверкой и вставкой номер занял кто-то другой. */
function asLicenseNumberConflict(e: unknown, field: string): unknown {
  // Через `pgErrorOf`: drizzle оборачивает ошибку драйвера в свою, и на верхнем объекте кода уже
  // нет — проверка молчала бы, а человек получал 500.
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'person_credentials_number_unique') {
    return err.validation({ [field]: LICENSE_NUMBER_RACE_MESSAGE });
  }
  return e;
}

/**
 * Документ водителя вместе с категориями — одной транзакцией: водительское удостоверение без
 * категорий бесполезно, и заводить его двумя действиями значило бы дать остановиться на полпути.
 *
 * У тракторного удостоверения категорий может не быть вовсе (`driverLicenseInputSchema`): в
 * кадровой выгрузке их не бывает, а бланку нужны номер и дата выдачи. Поэтому вставка категорий
 * условная — пустой `values([])` в drizzle это ошибка, а не пустая работа.
 *
 * Вид документа приходит в теле, а идентификаторы обоих видов — картой: подобрать не тот id к не
 * тому коду так попросту негде. Категории перед вставкой сверяются с видом (`assertCategoriesOf`):
 * составной внешний ключ этого и так не пропустит, но ответом была бы ошибка базы.
 *
 * Снятие прежних документов (ADR 0099) живёт здесь же, а не в обработчике: заведение нового и
 * снятие старого обязаны быть одной транзакцией — иначе карточка останется без документа вовсе.
 */
async function insertLicense(
  tx: Tx,
  personId: string,
  credentialTypeIds: Record<CredentialTypeCode, string>,
  license: NonNullable<z.infer<typeof createDriverSchema>['license']>,
  actorUserId: string,
  /** Поле формы, которому адресован отказ по занятому номеру: у заведения водителя оно вложенное. */
  numberField: string,
): Promise<{ dropped: number }> {
  const licenseTypeId = credentialTypeIds[license.credentialType];
  await assertCategoriesOf(tx, license.credentialType, licenseTypeId, license.categories);
  // Прежний снимается до проверки номера, а не после: ради того галочка и нужна — переоформленный
  // документ сплошь и рядом приходит с той же серией и номером.
  const dropped = license.deletePrevious
    ? await dropLicensesOf(tx, personId, licenseTypeId, actorUserId)
    : [];
  await assertNumberFree(tx, personId, licenseTypeId, license, numberField);

  const [credential] = await tx
    .insert(personCredentials)
    .values({
      personId,
      credentialTypeId: licenseTypeId,
      series: license.series,
      number: license.number,
      issuedOn: license.issuedOn ?? null,
      expiresOn: license.expiresOn ?? null,
      issuedBy: license.issuedBy,
      createdBy: actorUserId,
    })
    .returning({ id: personCredentials.id })
    .catch((e: unknown) => {
      throw asLicenseNumberConflict(e, numberField);
    });

  if (license.categories.length === 0) return { dropped: dropped.length };
  await tx.insert(personCredentialCategories).values(
    license.categories.map((c) => ({
      credentialId: credential!.id,
      qualificationCategoryId: c.categoryId,
      credentialTypeId: licenseTypeId,
      validFrom: c.validFrom ?? null,
      validTo: c.validTo ?? null,
      restrictions: c.restrictions,
    })),
  );
  return { dropped: dropped.length };
}

export default async function driversRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('drivers.read');
  const canWrite = app.requirePermission('drivers.write');
  // Отбор идёт под тем же правом, что и справочник, хотя персональных данных в ответе нет.
  // Право «вести статусы заявок ТС» сюда не годится: с ADR 0038 оно есть и у арендодателя, а он
  // водителей нашего парка не назначает — лист выписывается только на собственные машины.

  /**
   * Категории документа — ими заполняется форма. Справочник наполнен миграциями (0058 и 0123) и не
   * меняется, поэтому отдельного CRUD у него нет: список нужен только на чтение.
   *
   * Вид документа — параметром, и категории отдаются только его: буквы у видов одни и те же, и
   * общий список молча позволил бы приписать водительскому «C» тракторного (ADR 0095). Умолчание —
   * водительское: так эту ручку зовёт форма, заведённая до второго вида документа.
   */
  r.get(
    '/license-categories',
    {
      preHandler: [app.authenticate, canRead],
      schema: {
        querystring: z.object({
          type: z.enum(CREDENTIAL_TYPE_CODES).optional().default('driver_license'),
        }),
      },
    },
    async (req) => {
      const { credentialTypeIds } = await loadDirectoryIds();
      return db
        .select({
          id: qualificationCategories.id,
          code: qualificationCategories.code,
          name: qualificationCategories.name,
          description: qualificationCategories.description,
        })
        .from(qualificationCategories)
        .where(
          and(
            eq(qualificationCategories.credentialTypeId, credentialTypeIds[req.query.type]),
            eq(qualificationCategories.isActive, true),
          ),
        )
        .orderBy(asc(qualificationCategories.sortOrder));
    },
  );

  /**
   * Должности справочника — список для фильтра (ADR 0095).
   *
   * Справочника должностей в базе нет и не заводится: должность приходит из кадровой выгрузки
   * свободным текстом (`person_employments.job_title`), и портал ей не хозяин. Поэтому список
   * собирается из самих карточек и группируется нормализованным значением — тем же выражением, что
   * сравнивает фильтр списка: «Машинист  экскаватора» с двумя пробелами и «машинист экскаватора» —
   * одна должность, а не две.
   *
   * Количество здесь не украшение: по нему администратор и замечает опечатку кадровой выгрузки —
   * должность-двойник с единицей рядом стоит в списке отдельной строкой. По той же причине
   * перечисляются все должности, а не только знакомые порталу: незнакомую видно, и по ней
   * пополняют `JOB_TITLE_CREDENTIALS`. Пустая должность в список не идёт — фильтровать по ней
   * нечего.
   */
  r.get(
    '/job-titles',
    { preHandler: [app.authenticate, canRead] },
    async (): Promise<DriverJobTitleDto[]> => {
      // Человек, а не трудовое отношение: у одного бывает два действующих договора с одной
      // должностью, и в счётчике он должен остаться одним.
      const people = sql<number>`count(DISTINCT ${persons.id})`;
      const rows = await db
        .select({
          // Написание — как в кадрах: нормализованное значение годится для сравнения, но в
          // выпадающем списке «машинист экскаватора» с маленькой буквы выглядит опечаткой портала.
          jobTitle: sql<string>`min(${personEmployments.jobTitle})`,
          count: people,
        })
        .from(persons)
        .innerJoin(
          personEmployments,
          and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
        )
        .where(
          and(
            isNull(persons.deletedAt),
            driverCondition(),
            sql`btrim(${personEmployments.jobTitle}) <> ''`,
          ),
        )
        .groupBy(jobTitleKeySql)
        // Частые сверху: фильтром пользуются ради «машиниста экскаватора», а не ради строки,
        // которая встретилась однажды. Равные — по алфавиту, иначе порядок плавал бы между
        // запросами.
        .orderBy(sql`${people} DESC`, sql`${jobTitleKeySql} ASC`);

      return rows.map((row) => ({
        jobTitle: row.jobTitle,
        // Вид документа считается в памяти: правило живёт в контрактах, а SQL нужен только там,
        // где по нему отбирают страницу (`documentsCompleteCondition`).
        credentialTypeCode: requiredCredentialType(row.jobTitle),
        count: Number(row.count),
      }));
    },
  );

  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: driverListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const showDeleted = q.includeDeleted && can(p, 'archive.read');
      // Комплект и категории считаются на сегодня: справочник открывают, чтобы решить сегодняшний
      // вопрос — кого дозаполнить и кем закрывать рейсы, — а не чтобы вспомнить прошлый год.
      const today = todayInMoscow();
      const complete = documentsCompleteCondition(today);
      const documents =
        q.documents === undefined
          ? undefined
          : q.documents === 'complete'
            ? complete
            : sql`NOT (${complete})`;
      const where = and(
        showDeleted ? undefined : isNull(persons.deletedAt),
        driverCondition(),
        documents,
        // Должность сравнивается нормализованной с обеих сторон: в фильтр она приходит написанием
        // из кадров, а в справочнике у соседней карточки то же самое набрано другим регистром.
        q.jobTitle ? eq(jobTitleKeySql, normalizeJobTitle(q.jobTitle)) : undefined,
        q.categoryId ? categoryCondition(q.categoryId, today) : undefined,
        // Ищут по тому, что видят: ФИО, номер СНИЛС (как угодно набранный), табельный и контакты —
        // по ним ищут, когда разбираются, кому ушло (или не ушло) задание на рейс и кому звонить.
        // Телефон — по цифрам, как у учёток: в графе он показан «+7 (926) 123 45 67», а набирают
        // его в поиске как придётся.
        q.search
          ? or(
              searchCondition(q.search, [persons.fullName, persons.snils, persons.email]),
              searchCondition(q.search.replace(/[\s-]/gu, ''), [persons.snils]),
              searchCondition(q.search, [personEmployments.personnelNo]),
              phoneSearchCondition(q.search, persons.phone),
            )
          : undefined,
      );
      const sortCols = {
        fullName: persons.fullName,
        snils: persons.snils,
        personnelNo: personEmployments.personnelNo,
        createdAt: persons.createdAt,
        updatedAt: persons.updatedAt,
      };
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(personSelect)
          .from(persons)
          .leftJoin(
            personEmployments,
            and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
          )
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'fullName'))
          .limit(pg.limit)
          .offset(pg.offset),
        db
          .select({ c: count() })
          .from(persons)
          .leftJoin(
            personEmployments,
            and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
          )
          .where(where),
      ]);

      const licenses = await licensesByPerson(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, licenses.get(row.id) ?? [])),
        total: Number(totalRows[0]!.c),
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );

  /**
   * Кого можно посадить за эту машину в эту дату (ADR 0037). Тем же запросом сервер собирает
   * реквизиты присланного водителя при выписке листа — одна функция в двух применениях.
   *
   * Никого не сужает (ADR 0064): расхождение с требованием машины едет флагом
   * `matchesRequiredCategory` рядом с `requiredCategory`, пробелы комплекта — списком `gaps`.
   * Из этих двух пар форма и складывает пометки в строках и предупреждения под полем.
   */
  r.get(
    '/available',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: driverSelectionQuerySchema },
    },
    async (req): Promise<DriverSelectionDto> => {
      const { vehicleId, on, withTrailer } = req.query;
      const selection = await selectDrivers({ vehicleId, on, withTrailer });
      if (!selection) throw err.notFound('Машина не найдена');

      return {
        requiredCategory: selection.requiredCategoryName,
        // Вид требуемой категории — рядом с самой категорией: «нужна C» без вида документа ничего
        // не значит, и предупреждение о расхождении собирается из обеих сторон (ADR 0095).
        requiredCategoryType: selection.requirement.categoryTypeCode,
        drivers: selection.drivers.map((d) => ({
          personId: d.personId,
          fullName: d.fullName,
          personnelNo: d.personnelNo,
          // Каким документом человек допущен: им подписаны его пробелы в форме — «без номера ВУ»
          // и «без номера УТМ» несут в кабину разные бумаги.
          credentialTypeCode: d.credentialTypeCode,
          licenseNumber: licenseNumberLabel({ series: d.licenseSeries, number: d.licenseNumber }),
          licenseExpiresOn: d.licenseExpiresOn,
          verificationStatus: d.verificationStatus,
          categories: d.categories,
          gaps: d.gaps,
          matchesRequiredCategory: d.matchesRequiredCategory,
          workedRoutes: d.workedRoutes,
          lastWorkedOn: d.lastWorkedOn,
        })),
      };
    },
  );

  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const found = await loadDriver(req.params.id);
      if (!found) throw err.notFound('Водитель не найден');
      assertArchiveVisible(p, found.row.deletedAt, 'Водитель не найден');
      return found.dto;
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createDriverSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const body = req.body;
      // Контрольная сумма — здесь, а не в схеме: формат ловит длину, а опечатку в одной цифре
      // видит только она (приём ИНН контрагента).
      if (!isValidSnils(body.snils)) throw err.validation({ snils: SNILS_CHECKSUM_MESSAGE });
      const { specializationId, credentialTypeIds } = await loadDirectoryIds();

      const id = await db.transaction(async (tx) => {
        const [person] = await tx
          .insert(persons)
          .values({
            lastName: body.lastName,
            firstName: body.firstName,
            middleName: body.middleName,
            snils: body.snils,
            birthDate: body.birthDate ?? null,
            phone: body.phone,
            email: body.email,
            comment: body.comment,
            createdBy: p.id,
          })
          .returning({ id: persons.id });

        await tx.insert(personSpecializations).values({
          personId: person!.id,
          specializationId,
          isPrimary: true,
          ...(body.employedSince ? { startedOn: body.employedSince } : {}),
        });

        // Трудовое отношение заводится всегда: из него берётся табельный номер для бланка, а
        // «водитель без работодателя» — состояние, которого в справочнике не бывает.
        await tx.insert(personEmployments).values({
          personId: person!.id,
          personnelNo: body.personnelNo,
          jobTitle: body.jobTitle,
          ...(body.employedSince ? { startedOn: body.employedSince } : {}),
        });

        // Вид документа приходит из формы, а не выводится из должности карточки: он объявлен в
        // схеме со значением по умолчанию (`driverLicenseInputSchema`), и разобранное тело уже не
        // отличает «прислали водительское» от «не прислали ничего». Подставлять вид по должности
        // здесь значило бы менять смысл присланного `driver_license` — а форма, которая заводит
        // документ, вид спрашивает.
        if (body.license) {
          await insertLicense(
            tx,
            person!.id,
            credentialTypeIds,
            body.license,
            p.id,
            'license.number',
          );
        }
        return person!.id;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.create',
        entityType: 'person',
        entityId: id,
      });
      const created = await loadDriver(id);
      return reply.code(201).send(created!.dto);
    },
  );

  // Наполнение справочника файлом переехало в обмен справочниками (ADR 0073): формат один на все
  // справочники — .xlsx, и вход у него один — «Администрирование → Обмен справочниками». Своего
  // маршрута загрузки у водителей больше нет; правила разбора кадровой строки при этом остались
  // прежними, сменился только источник строк.

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateDriverSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const found = await loadDriver(req.params.id);
      if (!found) throw err.notFound('Водитель не найден');
      if (found.row.deletedAt) throw err.conflict('Водитель удалён');
      if (found.row.version !== body.version) {
        throw err.conflict('Карточку уже изменили — обновите страницу');
      }
      if (body.snils !== undefined && !isValidSnils(body.snils)) {
        throw err.validation({ snils: SNILS_CHECKSUM_MESSAGE });
      }

      await db.transaction(async (tx) => {
        await tx
          .update(persons)
          .set({
            ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
            ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
            ...(body.middleName === undefined ? {} : { middleName: body.middleName }),
            ...(body.snils === undefined ? {} : { snils: body.snils }),
            ...(body.birthDate === undefined ? {} : { birthDate: body.birthDate }),
            ...(body.phone === undefined ? {} : { phone: body.phone }),
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.comment === undefined ? {} : { comment: body.comment }),
            updatedBy: p.id,
            updatedAt: new Date(),
            version: found.row.version + 1,
          })
          .where(eq(persons.id, found.row.id));

        /**
         * ФИО и телефон правит справочник — он их и владелец (ADR 0102): в карточке имя
         * нормализовано и подтверждено документами, а в учётке оно могло быть введено как попало.
         * Поэтому правка карточки доезжает до живой учётки этого человека, а обратно — нет.
         *
         * Только эти два поля: адрес принадлежит учётке (его меняют через подтверждение владения
         * ящиком, ADR 0092), а СНИЛС и дата рождения в учётке не живут вовсе.
         */
        const nameChanged =
          body.lastName !== undefined ||
          body.firstName !== undefined ||
          body.middleName !== undefined;
        if (nameChanged || body.phone !== undefined) {
          await tx
            .update(users)
            .set({
              ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
              ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
              ...(body.middleName === undefined ? {} : { middleName: body.middleName }),
              ...(body.phone === undefined ? {} : { phone: body.phone }),
              updatedAt: new Date(),
            })
            .where(and(eq(users.personId, found.row.id), isNull(users.deletedAt)));
        }

        const employmentChanged =
          body.personnelNo !== undefined ||
          body.jobTitle !== undefined ||
          body.employedSince !== undefined;
        if (employmentChanged) {
          await tx
            .update(personEmployments)
            .set({
              ...(body.personnelNo === undefined ? {} : { personnelNo: body.personnelNo }),
              ...(body.jobTitle === undefined ? {} : { jobTitle: body.jobTitle }),
              ...(body.employedSince ? { startedOn: body.employedSince } : {}),
              updatedAt: new Date(),
            })
            .where(
              and(eq(personEmployments.personId, found.row.id), isNull(personEmployments.endedOn)),
            );
        }
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.update',
        entityType: 'person',
        entityId: found.row.id,
      });
      const updated = await loadDriver(found.row.id);
      return updated!.dto;
    },
  );

  const licenseParams = z.object({ id: z.string().uuid(), licenseId: z.string().uuid() });

  /**
   * Найденный документ этого водителя; чужой документ по прямому id недоступен.
   *
   * Ищется среди обоих видов (ADR 0095): проверяют и аннулируют тракторное удостоверение теми же
   * действиями, что водительское, — а вид едет рядом, потому что им подписано действие в журнале.
   */
  async function loadLicense(personId: string, licenseId: string) {
    const [row] = await db
      .select({
        id: personCredentials.id,
        credentialTypeCode: sql<CredentialTypeCode>`${credentialTypes.code}`,
        series: personCredentials.series,
        number: personCredentials.number,
        revokedAt: personCredentials.revokedAt,
        version: personCredentials.version,
      })
      .from(personCredentials)
      .innerJoin(credentialTypes, eq(credentialTypes.id, personCredentials.credentialTypeId))
      .where(
        and(
          eq(personCredentials.id, licenseId),
          eq(personCredentials.personId, personId),
          isNull(personCredentials.deletedAt),
        ),
      );
    return row ?? null;
  }

  /**
   * Новое удостоверение не стирает старое: замена по истечении срока — обычное дело, а история
   * документов объясняет, по какому листу человек ездил в прошлом году.
   *
   * Вид документа — из тела: у человека бывают оба, и «второй документ» здесь не всегда замена
   * первого. Умолчание схемы — водительское (`driverLicenseInputSchema`); по должности карточки
   * его не подменяют, потому что разобранное тело уже не отличает присланный `driver_license` от
   * неприсланного, а форма вид спрашивает.
   */
  r.post(
    '/:id/licenses',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: driverLicenseInputSchema },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const found = await loadDriver(req.params.id);
      if (!found) throw err.notFound('Водитель не найден');
      if (found.row.deletedAt) throw err.conflict('Водитель удалён');
      // Замена со снятием прежнего убирает заведённое, а не гасит его, — и спрашивается за неё то
      // же право, что за отдельное удаление документа. Иначе право обходилось бы галочкой в форме.
      if (req.body.deletePrevious && !can(p, 'records.purge')) {
        throw err.forbidden('Снять прежнее удостоверение может только администратор');
      }

      const { credentialTypeIds } = await loadDirectoryIds();
      const { dropped } = await db.transaction(async (tx) =>
        insertLicense(tx, found.row.id, credentialTypeIds, req.body, p.id, 'number'),
      );

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.license.add',
        entityType: 'person',
        entityId: found.row.id,
        // Вид документа — в журнале: у человека их два, и «добавлено удостоверение № 000001» без
        // вида не отвечает на вопрос, что именно завели (ADR 0095).
        //
        // Снятие прежнего — там же, а не отдельным событием: замена одна, и «что завели» с «что при
        // этом сняли» читаются вместе (приём `registerPurgeRoute`).
        metadata: {
          number: req.body.number,
          credentialType: req.body.credentialType,
          ...(dropped > 0 ? { deletedPrevious: dropped } : {}),
        },
      });
      const updated = await loadDriver(found.row.id);
      return reply.code(201).send(updated!.dto);
    },
  );

  /**
   * Отметка проверки — учётное действие: проверенный документ отличается от непроверенного не
   * содержимым, а тем, что его сверили с оригиналом. Время проставляется сервером: у всего, что
   * не `unverified`, оно обязано быть (CHECK в БД), а у непроверенного — обязано отсутствовать.
   */
  r.post(
    '/:id/licenses/:licenseId/verify',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: licenseParams, body: verifyDriverLicenseSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const license = await loadLicense(req.params.id, req.params.licenseId);
      if (!license) throw err.notFound('Удостоверение не найдено');

      const unverified = req.body.verificationStatus === 'unverified';
      await db
        .update(personCredentials)
        .set({
          verificationStatus: req.body.verificationStatus,
          verifiedBy: unverified ? null : p.id,
          verifiedAt: unverified ? null : new Date(),
          verificationComment: req.body.verificationComment,
          updatedBy: p.id,
          updatedAt: new Date(),
          version: license.version + 1,
        })
        .where(eq(personCredentials.id, license.id));

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.license.verify',
        entityType: 'person',
        entityId: req.params.id,
        metadata: {
          status: req.body.verificationStatus,
          credentialType: license.credentialTypeCode,
        },
      });
      const updated = await loadDriver(req.params.id);
      return updated!.dto;
    },
  );

  /**
   * Аннулирование: документ был действующим и перестал им быть — это не истечение срока и не
   * удаление записи. С этого момента водитель выпадает из отбора, и причина объясняет почему.
   */
  r.post(
    '/:id/licenses/:licenseId/revoke',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: licenseParams, body: revokeDriverLicenseSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const license = await loadLicense(req.params.id, req.params.licenseId);
      if (!license) throw err.notFound('Удостоверение не найдено');
      if (license.revokedAt) throw err.conflict('Удостоверение уже аннулировано');

      await db
        .update(personCredentials)
        .set({
          revokedAt: new Date(),
          revokeReason: req.body.revokeReason,
          updatedBy: p.id,
          updatedAt: new Date(),
          version: license.version + 1,
        })
        .where(eq(personCredentials.id, license.id));

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.license.revoke',
        entityType: 'person',
        entityId: req.params.id,
        metadata: { reason: req.body.revokeReason, credentialType: license.credentialTypeCode },
      });
      const updated = await loadDriver(req.params.id);
      return updated!.dto;
    },
  );

  /**
   * Удаление документа — правом администратора (`records.purge`, ADR 0021), как и всё, что
   * убирает заведённое насовсем, а не гасит его учётным действием.
   *
   * Аннулирование этого не заменяет: оно означает «документ был и перестал действовать», и
   * аннулированный остаётся в карточке — по нему объясняются прошлогодние листы. Убирают другое —
   * документ, которого у человека не было: опечатку в номере, чужую строку кадровой выгрузки,
   * второй экземпляр того же удостоверения. Оставлять такой рядом с настоящим нельзя: серию и
   * номер держит он же, и настоящий документ после него не заводится вовсе.
   *
   * Пометкой, а не строкой из базы: `deleted_at` снимает документ со всех чтений разом и
   * освобождает номер (индекс частичный), но оставляет след для журнала. Сканы остаются при
   * снятом документе — из карточки они не видны, а из хранилища их уносит удаление водителя.
   */
  r.delete(
    '/:id/licenses/:licenseId',
    {
      preHandler: [app.authenticate, app.requirePermission('records.purge')],
      schema: { params: licenseParams },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const found = await loadDriver(req.params.id);
      if (!found) throw err.notFound('Водитель не найден');
      const license = await loadLicense(req.params.id, req.params.licenseId);
      if (!license) throw err.notFound('Удостоверение не найдено');

      await db
        .update(personCredentials)
        .set({
          deletedAt: new Date(),
          deletedBy: p.id,
          updatedBy: p.id,
          updatedAt: new Date(),
          version: license.version + 1,
        })
        .where(eq(personCredentials.id, license.id));

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.license.delete',
        entityType: 'person',
        entityId: req.params.id,
        // Реквизиты — в журнале: из карточки документ пропал, и без них событие не отвечает на
        // вопрос, какую бумагу убрали.
        metadata: {
          credentialType: license.credentialTypeCode,
          series: license.series,
          number: license.number,
        },
      });
      const updated = await loadDriver(req.params.id);
      return updated!.dto;
    },
  );

  /**
   * Удаление — пометкой: на водителя ссылаются выданные путевые листы и назначения, и стереть
   * его значит потерять, кто был за рулём. Специализация закрывается тем же действием — уволенный
   * перестаёт попадать в отбор, даже если карточку потом восстановят.
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const found = await loadDriver(req.params.id);
      if (!found) throw err.notFound('Водитель не найден');
      if (found.row.deletedAt) return reply.code(204).send();

      const today = new Date().toISOString().slice(0, 10);
      await db.transaction(async (tx) => {
        await tx
          .update(persons)
          .set({ deletedAt: new Date(), deletedBy: p.id, version: found.row.version + 1 })
          .where(eq(persons.id, found.row.id));
        await tx
          .update(personSpecializations)
          .set({ endedOn: today, updatedAt: new Date() })
          .where(
            and(
              eq(personSpecializations.personId, found.row.id),
              isNull(personSpecializations.endedOn),
            ),
          );
        await tx
          .update(personEmployments)
          .set({ endedOn: today, updatedAt: new Date() })
          .where(
            and(eq(personEmployments.personId, found.row.id), isNull(personEmployments.endedOn)),
          );
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.delete',
        entityType: 'person',
        entityId: found.row.id,
      });
      return reply.code(204).send();
    },
  );

  /**
   * Удаление насовсем (ADR 0060) — только из архива. Вместе с человеком уходят его документы,
   * трудовые записи и специализации: они каскадные и без него бессмысленны. Сканы документов
   * каскад не трогает — строки `files` снимаются явно, вместе с задачей удаления из S3.
   *
   * Рейсы и путевые листы держат водителя внешним ключом: того, кто уже ездил, снести нельзя.
   */
  registerPurgeRoute(app, {
    load: async (id) => (await loadDriver(id))?.row,
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      // Учётку внешний ключ не удержит: `users.person_id` объявлен ON DELETE SET NULL и молча
      // отвязал бы человека от его входа в портал. Такое решение принимают в карточке учётки.
      // Считаются живые учётки: удалённая и так ничем не распоряжается, а требовать «сначала
      // почините её» значило бы запереть удаление наглухо — восстанавливать её незачем.
      const accounts = await tx
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.personId, row.id), isNull(users.deletedAt)));
      if (accounts.length > 0) {
        // Совет отвязать выполним не у всякой учётки: у водительской связь с карточкой
        // обязательна (ADR 0102, Р2, CHECK `users_driver_person_check`), и отвязать её нельзя
        // вовсе — путь один, в архив. Правило удаления при этом прежнее и не ослаблено: покажем
        // мы отказ или нет, решает наличие живой учётки, а не её роль.
        throw err.conflict(
          accounts.some((a) => isPersonScopedRole(a.role))
            ? 'На водителя заведена учётная запись — сначала заархивируйте её'
            : 'На водителя заведена учётная запись — сначала отвяжите или удалите её',
        );
      }
      const scans = await tx
        .select({ id: files.id, objectKey: files.objectKey })
        .from(personCredentialFiles)
        .innerJoin(files, eq(personCredentialFiles.fileId, files.id))
        .innerJoin(personCredentials, eq(personCredentials.id, personCredentialFiles.credentialId))
        .where(eq(personCredentials.personId, row.id));
      await tx.delete(persons).where(eq(persons.id, row.id));
      await hardDeleteFiles(tx, scans);
    },
    notFound: 'Водитель не найден',
    stillLive: 'Водитель не в архиве — сначала удалите его',
    subject: 'водителя',
    audit: {
      action: 'driver.purge',
      entityType: 'person',
      // ФИО, но не СНИЛС: журнал должен называть, кого удалили, а не хранить вторую копию
      // персональных данных там, где карточки уже нет.
      metadata: (row) => ({ fullName: row.fullName }),
    },
  });
}
