import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  can,
  createDriverSchema,
  type DriverDto,
  type DriverLicenseDto,
  driverLicenseInputSchema,
  driverListQuerySchema,
  type DriverSelectionDto,
  driverSelectionQuerySchema,
  type DriversImportReportDto,
  driversImportSchema,
  isValidSnils,
  licenseNumberLabel,
  revokeDriverLicenseSchema,
  SNILS_CHECKSUM_MESSAGE,
  updateDriverSchema,
  verifyDriverLicenseSchema,
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
  users,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { assertArchiveVisible } from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { selectDrivers } from '../services/drivers';
import { DriverImportError } from '../services/driver-import';
import { applyDriverImport, DirectoriesNotSeededError } from '../services/driver-import-apply';

/**
 * Справочник водителей (ADR 0037, ADR 0008).
 *
 * Отдельной таблицы водителей нет: карточка собирает физлицо, его специализацию, трудовое
 * отношение и водительское удостоверение с категориями. Заводить их четырьмя экранами значило бы
 * дать остановиться на полпути — водитель без документа в отбор не попадёт и молча пропадёт из
 * формы перевода заявки в работу.
 *
 * Право своё, а не `directories.*`: в карточке лежат персональные данные, и открывать их каждому,
 * кому нужен список типов ТС, нельзя.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

const DRIVER_SPECIALIZATION_CODE = 'driver';
const DRIVER_LICENSE_CODE = 'driver_license';

/** Справочные идентификаторы, без которых водителя не завести (наполняет миграция 0058). */
async function loadDirectoryIds(): Promise<{ specializationId: string; licenseTypeId: string }> {
  const [specialization] = await db
    .select({ id: specializations.id })
    .from(specializations)
    .where(eq(specializations.code, DRIVER_SPECIALIZATION_CODE));
  const [licenseType] = await db
    .select({ id: credentialTypes.id })
    .from(credentialTypes)
    .where(eq(credentialTypes.code, DRIVER_LICENSE_CODE));

  if (!specialization || !licenseType) {
    throw err.conflict(
      'Справочник специализаций и видов документов не наполнен: примените миграцию 0058',
    );
  }
  return { specializationId: specialization.id, licenseTypeId: licenseType.id };
}

interface PersonRow {
  id: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  birthDate: string | null;
  phone: string;
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

/** Удостоверения найденных людей — добором: join'ить их к списку значило бы размножить строки. */
async function licensesByPerson(personIds: string[]): Promise<Map<string, DriverLicenseDto[]>> {
  const map = new Map<string, DriverLicenseDto[]>();
  if (personIds.length === 0) return map;

  const rows = await db
    .select({
      id: personCredentials.id,
      personId: personCredentials.personId,
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
    .where(
      and(
        inArray(personCredentials.personId, personIds),
        eq(credentialTypes.code, DRIVER_LICENSE_CODE),
        isNull(personCredentials.deletedAt),
      ),
    )
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
  snils: persons.snils,
  comment: persons.comment,
  version: persons.version,
  createdAt: persons.createdAt,
  updatedAt: persons.updatedAt,
  deletedAt: persons.deletedAt,
  ...employmentJoin,
};

/** Только водители: специализация действующая — уволенного из справочника не показывают. */
function driverCondition() {
  return sql`EXISTS (
    SELECT 1 FROM ${personSpecializations} ps
    JOIN ${specializations} s ON s.id = ps.specialization_id
    WHERE ps.person_id = ${persons.id}
      AND ps.ended_on IS NULL
      AND s.code = ${DRIVER_SPECIALIZATION_CODE}
  )`;
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

/** Документ водителя вместе с категориями — одной транзакцией: документ без категорий бесполезен. */
async function insertLicense(
  tx: Tx,
  personId: string,
  licenseTypeId: string,
  license: NonNullable<z.infer<typeof createDriverSchema>['license']>,
): Promise<void> {
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
    })
    .returning({ id: personCredentials.id });

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
}

export default async function driversRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('drivers.read');
  const canWrite = app.requirePermission('drivers.write');
  // Отбор идёт под тем же правом, что и справочник, хотя персональных данных в ответе нет.
  // Право «вести статусы заявок ТС» сюда не годится: с ADR 0038 оно есть и у арендодателя, а он
  // водителей нашего парка не назначает — лист выписывается только на собственные машины.

  /**
   * Категории водительского удостоверения — ими заполняется форма. Справочник наполнен миграцией
   * и не меняется, поэтому отдельного CRUD у него нет: список нужен только на чтение.
   */
  r.get('/license-categories', { preHandler: [app.authenticate, canRead] }, async () => {
    const { licenseTypeId } = await loadDirectoryIds();
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
          eq(qualificationCategories.credentialTypeId, licenseTypeId),
          eq(qualificationCategories.isActive, true),
        ),
      )
      .orderBy(asc(qualificationCategories.sortOrder));
  });

  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: driverListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const showDeleted = q.includeDeleted && can(p, 'archive.read');
      const where = and(
        showDeleted ? undefined : isNull(persons.deletedAt),
        driverCondition(),
        // Ищут по тому, что видят: ФИО, номер СНИЛС (как угодно набранный) и табельный.
        q.search
          ? or(
              searchCondition(q.search, [persons.fullName, persons.snils]),
              searchCondition(q.search.replace(/[\s-]/gu, ''), [persons.snils]),
              searchCondition(q.search, [personEmployments.personnelNo]),
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
   * Кто может сесть за эту машину в эту дату (ADR 0037). Тем же отбором сервер проверяет
   * присланного водителя при переводе заявки в работу — одна функция в двух применениях.
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
        drivers: selection.drivers.map((d) => ({
          personId: d.personId,
          fullName: d.fullName,
          personnelNo: d.personnelNo,
          licenseNumber: licenseNumberLabel({ series: d.licenseSeries, number: d.licenseNumber }),
          licenseExpiresOn: d.licenseExpiresOn,
          verificationStatus: d.verificationStatus,
          categories: d.categories,
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
      const { specializationId, licenseTypeId } = await loadDirectoryIds();

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

        if (body.license) await insertLicense(tx, person!.id, licenseTypeId, body.license);
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

  /**
   * Наполнение справочника кадровой выгрузкой (ADR 0047).
   *
   * Тот же разбор и та же запись, что у `seed:drivers` на сервере, — но доступ к серверу нужен не
   * всякому, кто ведёт справочник, а выгрузка приходит от кадровика тогда, когда пришла.
   *
   * Право то же, что у заведения водителя руками: загрузка заводит ровно тех же людей теми же
   * записями, отличаясь только количеством. Отдельное право означало бы, что кому-то можно
   * завести двадцать восемь человек по одному, но нельзя — файлом.
   */
  r.post(
    '/import',
    { preHandler: [app.authenticate, canWrite], schema: { body: driversImportSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { dryRun, file } = req.body;

      let report: DriversImportReportDto;
      try {
        report = await applyDriverImport(file, { dryRun, actorUserId: p.id });
      } catch (e) {
        // Разбор упал — это про содержимое присланного файла, и сказать об этом надо дословно:
        // «Петров Пётр: СНИЛС не проходит проверку контрольной суммы» человек исправит, «422» — нет.
        if (e instanceof DriverImportError) throw err.unprocessable(e.message);
        if (e instanceof DirectoriesNotSeededError) throw err.conflict(e.message);
        throw e;
      }

      // Пишется только состоявшееся наполнение: dry-run базу не менял. Поимённого состава в
      // метаданных нет намеренно — заведённые люди и так видны в справочнике с автором записи,
      // а аудит-лог не место для второго хранилища ФИО (ADR 0037 п. 13).
      if (!dryRun) {
        await writeAudit({
          actorUserId: p.id,
          action: 'driver.import',
          entityType: 'person',
          metadata: {
            created: report.created.length,
            skipped: report.skipped.length,
            source: file.source ?? '',
            department: file.department ?? '',
          },
        });
      }
      return report;
    },
  );

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
            ...(body.comment === undefined ? {} : { comment: body.comment }),
            updatedBy: p.id,
            updatedAt: new Date(),
            version: found.row.version + 1,
          })
          .where(eq(persons.id, found.row.id));

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

  /** Найденный документ этого водителя; чужой документ по прямому id недоступен. */
  async function loadLicense(personId: string, licenseId: string) {
    const [row] = await db
      .select({
        id: personCredentials.id,
        revokedAt: personCredentials.revokedAt,
        version: personCredentials.version,
      })
      .from(personCredentials)
      .innerJoin(credentialTypes, eq(credentialTypes.id, personCredentials.credentialTypeId))
      .where(
        and(
          eq(personCredentials.id, licenseId),
          eq(personCredentials.personId, personId),
          eq(credentialTypes.code, DRIVER_LICENSE_CODE),
          isNull(personCredentials.deletedAt),
        ),
      );
    return row ?? null;
  }

  /**
   * Новое удостоверение не стирает старое: замена по истечении срока — обычное дело, а история
   * документов объясняет, по какому листу человек ездил в прошлом году.
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

      const { licenseTypeId } = await loadDirectoryIds();
      await db.transaction(async (tx) => {
        await insertLicense(tx, found.row.id, licenseTypeId, req.body);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'driver.license.add',
        entityType: 'person',
        entityId: found.row.id,
        metadata: { number: req.body.number },
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
        metadata: { status: req.body.verificationStatus },
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
        metadata: { reason: req.body.revokeReason },
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
}
