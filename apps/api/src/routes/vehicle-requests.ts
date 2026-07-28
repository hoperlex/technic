import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  changeVehicleRequestStatusSchema,
  createVehicleRequestSchema,
  type FileDto,
  formatVehicleRequestNumber,
  REQUEST_STATUSES,
  updateVehicleRequestSchema,
  type VehicleRequestDto,
  type VehicleRequestSummaryDto,
  type VehicleRequestType,
  vehicleRequestListQuerySchema,
  vehicleRequestSummaryQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  files,
  freightTransportRequestDetails,
  specialEquipmentRequestDetails,
  users,
  vehicleKinds,
  vehicleRequestFiles,
  vehicleRequestStatusHistory,
  vehicleRequests,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import {
  assertShtabScope,
  assertTransitionAllowed,
  canChangeStatus,
  requestVisibilityWhere,
} from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  assertFilesAttachable,
  assertTotalWithinLimit,
  hardDeleteFiles,
  markFilesActive,
  scheduleFilesDeletion,
} from '../services/request-files';
import { diffVehicleRequests } from '../services/vehicle-request-diff';
import { loadVehicleRequestHistory } from '../services/vehicle-request-history';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

// Вид ТС, ожидаемый для типа заявки (совпадает с кодами vehicle_kinds).
const KIND_BY_REQUEST_TYPE: Record<VehicleRequestType, string> = {
  special_equipment: 'special_equipment',
  freight_transport: 'freight_transport',
};

const requestSelect = {
  id: vehicleRequests.id,
  num: vehicleRequests.num,
  requestType: vehicleRequests.requestType,
  objectId: vehicleRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  // Плоская модель (ADR 0005): тип ТС — напрямую vehicle_type_id.
  vehicleTypeId: vehicleRequests.vehicleTypeId,
  vehicleTypeName: vehicleTypes.name,
  status: vehicleRequests.status,
  comment: vehicleRequests.comment,
  // Причина отмены живёт в истории статусов; актуальна последняя и только у отменённых заявок.
  cancelReason: sql<string | null>`
    CASE WHEN ${vehicleRequests.status} = 'cancelled' THEN (
      SELECT h.comment
      FROM ${vehicleRequestStatusHistory} h
      WHERE h.vehicle_request_id = ${vehicleRequests.id} AND h.to_status = 'cancelled'
      ORDER BY h.changed_at DESC
      LIMIT 1
    ) END`.as('cancel_reason'),
  version: vehicleRequests.version,
  createdBy: vehicleRequests.createdBy,
  createdByName: users.fullName,
  createdAt: vehicleRequests.createdAt,
  updatedAt: vehicleRequests.updatedAt,
  deletedAt: vehicleRequests.deletedAt,
  dateFrom: specialEquipmentRequestDetails.dateFrom,
  dateTo: specialEquipmentRequestDetails.dateTo,
  scheduledAt: freightTransportRequestDetails.scheduledAt,
  scheduledTimeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
  volumeM3: freightTransportRequestDetails.volumeM3,
  weightTons: freightTransportRequestDetails.weightTons,
  loadingLocation: freightTransportRequestDetails.loadingLocation,
  unloadingLocation: freightTransportRequestDetails.unloadingLocation,
  loadingAddress: freightTransportRequestDetails.loadingAddress,
  unloadingAddress: freightTransportRequestDetails.unloadingAddress,
};

function baseQuery() {
  return db
    .select(requestSelect)
    .from(vehicleRequests)
    .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
    .innerJoin(vehicleTypes, eq(vehicleRequests.vehicleTypeId, vehicleTypes.id))
    .innerJoin(users, eq(vehicleRequests.createdBy, users.id))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
    )
    .leftJoin(
      freightTransportRequestDetails,
      eq(vehicleRequests.id, freightTransportRequestDetails.requestId),
    );
}

type RequestRow = Awaited<ReturnType<typeof baseQuery>>[number];

/** numeric из pg приходит строкой — приводим к числу с проверкой конечности. */
function toNum(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** number → строка для колонки numeric. */
function numToDb(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

async function filesByRequestIds(ids: string[]): Promise<Map<string, FileDto[]>> {
  const map = new Map<string, FileDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: vehicleRequestFiles.vehicleRequestId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(vehicleRequestFiles)
    .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
    .where(and(inArray(vehicleRequestFiles.vehicleRequestId, ids), eq(files.status, 'active')));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.requestId, list);
  }
  return map;
}

function toDto(r: RequestRow, fileList: FileDto[]): VehicleRequestDto {
  const base = {
    id: r.id,
    num: r.num,
    displayNumber: formatVehicleRequestNumber(r.num),
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    vehicleTypeId: r.vehicleTypeId,
    vehicleTypeName: r.vehicleTypeName,
    status: r.status,
    comment: r.comment,
    cancelReason: r.cancelReason || null,
    files: fileList,
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
  if (r.requestType === 'special_equipment') {
    return {
      ...base,
      requestType: 'special_equipment',
      dateFrom: r.dateFrom ?? '',
      dateTo: r.dateTo ?? null,
    };
  }
  return {
    ...base,
    requestType: 'freight_transport',
    scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : '',
    scheduledTimeUnspecified: r.scheduledTimeUnspecified ?? false,
    volumeM3: toNum(r.volumeM3),
    weightTons: toNum(r.weightTons),
    loadingLocation: r.loadingLocation ?? '',
    unloadingLocation: r.unloadingLocation ?? '',
    loadingAddress: r.loadingAddress ?? null,
    unloadingAddress: r.unloadingAddress ?? null,
  };
}

async function getDto(id: string): Promise<VehicleRequestDto | null> {
  const [row] = await baseQuery().where(eq(vehicleRequests.id, id));
  if (!row) return null;
  const filesMap = await filesByRequestIds([id]);
  return toDto(row, filesMap.get(id) ?? []);
}

async function assertObjectActive(tx: Tx, objectId: string): Promise<void> {
  const [o] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!o) throw err.badRequest('Объект не найден');
  if (!o.isActive) throw err.badRequest('Объект неактивен');
}

/**
 * Плоская модель (ADR 0005): выбран активный тип ТС активного вида, совпадающего с типом
 * заявки. Иначе — отказ.
 */
async function resolveVehicleType(
  tx: Tx,
  typeId: string,
  requestType: VehicleRequestType,
): Promise<void> {
  const [row] = await tx
    .select({
      isActive: vehicleTypes.isActive,
      kindCode: vehicleKinds.code,
      kindActive: vehicleKinds.isActive,
    })
    .from(vehicleTypes)
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .where(eq(vehicleTypes.id, typeId));
  if (!row) throw err.badRequest('Тип ТС не найден');
  if (!row.isActive) throw err.badRequest('Тип ТС неактивен');
  if (!row.kindActive) throw err.badRequest('Вид ТС неактивен');
  if (row.kindCode !== KIND_BY_REQUEST_TYPE[requestType]) {
    throw err.unprocessable('Тип ТС не относится к выбранному виду заявки');
  }
}

async function attachFiles(
  tx: Tx,
  vehicleRequestId: string,
  fileIds: string[],
  uploaderId: string,
  enforceTotal = false,
): Promise<void> {
  if (fileIds.length === 0) return;
  await assertFilesAttachable(tx, fileIds, uploaderId);
  if (enforceTotal) {
    const [c] = await tx
      .select({ c: count() })
      .from(vehicleRequestFiles)
      .where(eq(vehicleRequestFiles.vehicleRequestId, vehicleRequestId));
    assertTotalWithinLimit(Number(c!.c), fileIds.length);
  }
  await tx
    .insert(vehicleRequestFiles)
    .values(fileIds.map((fileId) => ({ vehicleRequestId, fileId })));
  await markFilesActive(tx, fileIds);
}

async function detachFiles(tx: Tx, vehicleRequestId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(vehicleRequestFiles)
    .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
    .where(
      and(
        eq(vehicleRequestFiles.vehicleRequestId, vehicleRequestId),
        inArray(vehicleRequestFiles.fileId, fileIds),
      ),
    );
  if (linked.length === 0) return;
  const ids = linked.map((l) => l.id);
  await tx
    .delete(vehicleRequestFiles)
    .where(
      and(
        eq(vehicleRequestFiles.vehicleRequestId, vehicleRequestId),
        inArray(vehicleRequestFiles.fileId, ids),
      ),
    );
  await scheduleFilesDeletion(tx, linked, false);
}

/** Спецтехника: пересечение периодов. */
function specialDateConds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  const conds: (SQL | undefined)[] = [];
  if (dateTo) conds.push(sql`${specialEquipmentRequestDetails.dateFrom} <= ${dateTo}::date`);
  if (dateFrom) {
    conds.push(
      sql`coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom}) >= ${dateFrom}::date`,
    );
  }
  return conds;
}

/** Грузоперевозка: день в Europe/Moscow. */
function freightDateConds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  const conds: (SQL | undefined)[] = [];
  if (dateFrom) {
    conds.push(
      gte(freightTransportRequestDetails.scheduledAt, new Date(`${dateFrom}T00:00:00.000+03:00`)),
    );
  }
  if (dateTo) {
    conds.push(
      lte(freightTransportRequestDetails.scheduledAt, new Date(`${dateTo}T23:59:59.999+03:00`)),
    );
  }
  return conds;
}

/**
 * Календарный диапазон (YYYY-MM-DD). Тип задан — правило своего типа; тип не задан
 * (единый список «Заказ автотехники») — строка проходит, если попадает в диапазон по
 * своему типу: OR двух правил, каждое отсекает чужие строки по NULL в detail-колонках.
 */
function dateFilters(
  requestType: VehicleRequestType | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  if (!dateFrom && !dateTo) return [];
  if (requestType === 'special_equipment') return specialDateConds(dateFrom, dateTo);
  if (requestType === 'freight_transport') return freightDateConds(dateFrom, dateTo);
  return [
    or(and(...specialDateConds(dateFrom, dateTo)), and(...freightDateConds(dateFrom, dateTo))),
  ];
}

export default async function vehicleRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Модуль «Заказ ТС» оператору вывоза мусора недоступен целиком (ADR 0010): роли перечислены
  // явно, чтобы новая роль по умолчанию не получала доступ.
  const auth = {
    preHandler: [app.authenticate, app.requireRoles('admin', 'manager', 'dispatcher', 'shtab')],
  };

  // ── Список (единый по обоим типам; requestType — необязательное сужение) ──
  r.get('/', { ...auth, schema: { querystring: vehicleRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const showDeleted = q.includeDeleted && p.role === 'admin';
    const where = and(
      q.requestType ? eq(vehicleRequests.requestType, q.requestType) : undefined,
      showDeleted ? undefined : isNull(vehicleRequests.deletedAt),
      requestVisibilityWhere(p, vehicleRequests.objectId),
      q.status ? eq(vehicleRequests.status, q.status) : undefined,
      q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
      q.vehicleTypeId ? eq(vehicleRequests.vehicleTypeId, q.vehicleTypeId) : undefined,
      q.num ? eq(vehicleRequests.num, q.num) : undefined,
      ...dateFilters(q.requestType, q.dateFrom, q.dateTo),
      searchCondition(q.search, [
        vehicleRequests.comment,
        constructionObjects.name,
        constructionObjects.code,
      ]),
    );
    // Сортировка во всех столбцах. «Срок» и «объём/масса» у типов заявки лежат в разных
    // detail-таблицах, поэтому сводятся coalesce: у строки заполнена ровно одна из колонок.
    // Объём и масса — разные единицы, но в одном столбце: сортируем по тому, что указано.
    const sortCols = {
      num: vehicleRequests.num,
      requestType: vehicleRequests.requestType,
      objectName: constructionObjects.name,
      createdByName: users.fullName,
      vehicleTypeName: vehicleTypes.name,
      term: sql`coalesce(${freightTransportRequestDetails.scheduledAt}, ${specialEquipmentRequestDetails.dateFrom}::timestamptz)`,
      amount: sql`coalesce(${freightTransportRequestDetails.volumeM3}, ${freightTransportRequestDetails.weightTons})`,
      loadingLocation: freightTransportRequestDetails.loadingLocation,
      unloadingLocation: freightTransportRequestDetails.unloadingLocation,
      status: vehicleRequests.status,
      comment: vehicleRequests.comment,
      createdAt: vehicleRequests.createdAt,
    };
    const pg = pageParams(q);
    const rows = await baseQuery()
      .where(where)
      .orderBy(
        orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'),
        asc(vehicleRequests.num),
        asc(vehicleRequests.id),
      )
      .limit(pg.limit)
      .offset(pg.offset);
    const [totalRow] = await db
      .select({ c: count() })
      .from(vehicleRequests)
      .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
      .leftJoin(
        specialEquipmentRequestDetails,
        eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
      )
      .leftJoin(
        freightTransportRequestDetails,
        eq(vehicleRequests.id, freightTransportRequestDetails.requestId),
      )
      .where(where);
    const filesMap = await filesByRequestIds(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toDto(row, filesMap.get(row.id) ?? [])),
      total: Number(totalRow!.c),
      page: pg.page,
      pageSize: pg.pageSize,
    };
  });

  /**
   * Сводка «сколько заявок в каком статусе» для виджета над таблицей. Считается по тем же
   * правилам видимости, что и список: штаб видит только свой объект. Удалённые в счёт не идут —
   * в списке их тоже нет (админский includeDeleted сводку не расширяет).
   */
  r.get(
    '/summary',
    { ...auth, schema: { querystring: vehicleRequestSummaryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const rows = await db
        .select({ status: vehicleRequests.status, c: count() })
        .from(vehicleRequests)
        .where(
          and(
            isNull(vehicleRequests.deletedAt),
            requestVisibilityWhere(p, vehicleRequests.objectId),
            req.query.objectId ? eq(vehicleRequests.objectId, req.query.objectId) : undefined,
            req.query.requestType
              ? eq(vehicleRequests.requestType, req.query.requestType)
              : undefined,
          ),
        )
        .groupBy(vehicleRequests.status);
      const summary = Object.fromEntries(
        REQUEST_STATUSES.map((s) => [s, 0]),
      ) as VehicleRequestSummaryDto;
      for (const row of rows) summary[row.status] = Number(row.c);
      return summary;
    },
  );

  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const dto = await getDto(req.params.id);
    if (!dto || dto.deletedAt) {
      if (!dto || p.role !== 'admin') throw err.notFound('Заявка не найдена');
    }
    assertShtabScope(p, dto!.objectId);
    return dto;
  });

  // История заявки: создание, правки, смены статусов (ADR 0015). Доступна тем же, кто видит саму
  // заявку — отдельного права на неё нет: это те же события, что и в карточке, только по времени.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [row] = await db
      .select({
        id: vehicleRequests.id,
        objectId: vehicleRequests.objectId,
        deletedAt: vehicleRequests.deletedAt,
        createdAt: vehicleRequests.createdAt,
        createdBy: vehicleRequests.createdBy,
        createdByName: users.fullName,
      })
      .from(vehicleRequests)
      .innerJoin(users, eq(vehicleRequests.createdBy, users.id))
      .where(eq(vehicleRequests.id, req.params.id));
    // Архивная заявка видна только администратору — как и сама карточка (GET /:id).
    if (!row || (row.deletedAt && p.role !== 'admin')) throw err.notFound('Заявка не найдена');
    assertShtabScope(p, row.objectId);
    return loadVehicleRequestHistory(row.id, {
      at: row.createdAt,
      actorId: row.createdBy,
      actorName: row.createdByName,
    });
  });

  // ── Создание ──
  r.post('/', { ...auth, schema: { body: createVehicleRequestSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const body = req.body;
    assertShtabScope(p, body.objectId);

    const createdId = await db.transaction(async (tx) => {
      await assertObjectActive(tx, body.objectId);
      await resolveVehicleType(tx, body.vehicleTypeId, body.requestType);
      const [row] = await tx
        .insert(vehicleRequests)
        .values({
          requestType: body.requestType,
          objectId: body.objectId,
          vehicleTypeId: body.vehicleTypeId,
          status: 'new',
          comment: body.comment,
          createdBy: p.id,
        })
        .returning({ id: vehicleRequests.id });
      const id = row!.id;
      if (body.requestType === 'special_equipment') {
        await tx.insert(specialEquipmentRequestDetails).values({
          requestId: id,
          dateFrom: body.dateFrom,
          dateTo: body.dateTo ?? null,
        });
      } else {
        await tx.insert(freightTransportRequestDetails).values({
          requestId: id,
          scheduledAt: new Date(body.scheduledAt),
          scheduledTimeUnspecified: body.scheduledTimeUnspecified,
          volumeM3: numToDb(body.volumeM3),
          weightTons: numToDb(body.weightTons),
          loadingLocation: body.loadingLocation,
          unloadingLocation: body.unloadingLocation,
          loadingAddress: body.loadingAddress ?? null,
          unloadingAddress: body.unloadingAddress ?? null,
        });
      }
      await tx.insert(vehicleRequestStatusHistory).values({
        vehicleRequestId: id,
        fromStatus: null,
        toStatus: 'new',
        changedBy: p.id,
      });
      await attachFiles(tx, id, body.fileIds, p.id);
      return id;
    });

    await writeAudit({
      actorUserId: p.id,
      action: 'vehicle_request.create',
      entityType: 'vehicle_request',
      entityId: createdId,
      metadata: {
        requestType: body.requestType,
        objectId: body.objectId,
        vehicleTypeId: body.vehicleTypeId,
      },
    });
    reply.code(201);
    return (await getDto(createdId))!;
  });

  // ── Обновление ──
  r.patch(
    '/:id',
    { ...auth, schema: { params: idParams, body: updateVehicleRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      // Состояние «до» берётся сразу как DTO: по нему не только проверки, но и дифф для
      // истории — названия справочников там уже собраны (см. vehicle-request-history).
      const before = await getDto(id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      if (before.requestType !== body.requestType) {
        throw err.unprocessable('Тип заявки изменить нельзя');
      }
      assertShtabScope(p, before.objectId);
      if (p.role === 'shtab' && before.status !== 'new') {
        throw err.forbidden('Штаб может редактировать заявку только в статусе «Новая»');
      }

      const objectId = body.objectId ?? before.objectId;
      const nextTypeId = body.vehicleTypeId ?? before.vehicleTypeId;

      await db.transaction(async (tx) => {
        if (body.objectId && body.objectId !== before.objectId) {
          assertShtabScope(p, body.objectId);
          await assertObjectActive(tx, body.objectId);
        }
        if (body.vehicleTypeId && body.vehicleTypeId !== before.vehicleTypeId) {
          await resolveVehicleType(tx, body.vehicleTypeId, before.requestType);
        }

        const [updated] = await tx
          .update(vehicleRequests)
          .set({
            objectId,
            vehicleTypeId: nextTypeId,
            comment: body.comment ?? before.comment,
            updatedBy: p.id,
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(vehicleRequests.id, id), eq(vehicleRequests.version, body.version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();

        if (body.requestType === 'special_equipment') {
          const [ex] = await tx
            .select()
            .from(specialEquipmentRequestDetails)
            .where(eq(specialEquipmentRequestDetails.requestId, id));
          const dateFrom = body.dateFrom ?? ex!.dateFrom;
          const dateTo = body.dateTo !== undefined ? body.dateTo : ex!.dateTo;
          if (dateTo && dateTo < dateFrom) {
            throw err.badRequest('Дата окончания раньше даты начала');
          }
          await tx
            .update(specialEquipmentRequestDetails)
            .set({ dateFrom, dateTo })
            .where(eq(specialEquipmentRequestDetails.requestId, id));
        } else {
          const [ex] = await tx
            .select()
            .from(freightTransportRequestDetails)
            .where(eq(freightTransportRequestDetails.requestId, id));
          const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : ex!.scheduledAt;
          const volumeM3 = body.volumeM3 !== undefined ? numToDb(body.volumeM3) : ex!.volumeM3;
          const weightTons =
            body.weightTons !== undefined ? numToDb(body.weightTons) : ex!.weightTons;
          if (volumeM3 == null && weightTons == null) {
            throw err.badRequest('Укажите объём или массу');
          }
          await tx
            .update(freightTransportRequestDetails)
            .set({
              scheduledAt,
              // Признак меняется только вместе с датой — иначе остаётся прежним.
              scheduledTimeUnspecified: body.scheduledAt
                ? (body.scheduledTimeUnspecified ?? false)
                : ex!.scheduledTimeUnspecified,
              volumeM3,
              weightTons,
              loadingLocation: body.loadingLocation ?? ex!.loadingLocation,
              unloadingLocation: body.unloadingLocation ?? ex!.unloadingLocation,
              // Метаданные адреса шлются вместе со строкой; null явно сбрасывает верификацию.
              loadingAddress:
                body.loadingAddress !== undefined ? body.loadingAddress : ex!.loadingAddress,
              unloadingAddress:
                body.unloadingAddress !== undefined ? body.unloadingAddress : ex!.unloadingAddress,
            })
            .where(eq(freightTransportRequestDetails.requestId, id));
        }

        if (body.removeFileIds?.length) await detachFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) await attachFiles(tx, id, body.addFileIds, p.id, true);
      });

      const after = (await getDto(id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.update',
        entityType: 'vehicle_request',
        entityId: id,
        // Перечень изменённых полей — то, ради чего история отличает правку от «заявку трогали».
        metadata: { changes: diffVehicleRequests(before, after) },
      });
      return after;
    },
  );

  // ── Смена статуса ──
  r.patch(
    '/:id/status',
    { ...auth, schema: { params: idParams, body: changeVehicleRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      if (!canChangeStatus(p)) throw err.forbidden('Недостаточно прав для смены статуса');
      const { status, comment, version } = req.body;
      const [existing] = await db
        .select()
        .from(vehicleRequests)
        .where(eq(vehicleRequests.id, req.params.id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      if (existing.status === status) return (await getDto(existing.id))!;
      assertTransitionAllowed(existing.status, status, p.role);
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(vehicleRequests)
          .set({ status, updatedBy: p.id, version: existing.version + 1, updatedAt: new Date() })
          .where(and(eq(vehicleRequests.id, existing.id), eq(vehicleRequests.version, version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(vehicleRequestStatusHistory).values({
          vehicleRequestId: existing.id,
          fromStatus: existing.status,
          toStatus: status,
          changedBy: p.id,
          comment,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.status',
        entityType: 'vehicle_request',
        entityId: existing.id,
        metadata: { from: existing.status, to: status, comment },
      });
      return (await getDto(existing.id))!;
    },
  );

  // ── Удаление (hard для «Новая», иначе soft) ──
  r.delete('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = req.params;
    const [existing] = await db.select().from(vehicleRequests).where(eq(vehicleRequests.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
    assertShtabScope(p, existing.objectId);
    if (p.role === 'shtab' && existing.status !== 'new') {
      throw err.forbidden('Штаб может удалять заявку только в статусе «Новая»');
    }

    if (existing.status === 'new') {
      await db.transaction(async (tx) => {
        const linked = await tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(vehicleRequestFiles)
          .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
          .where(eq(vehicleRequestFiles.vehicleRequestId, id));
        // Детали, файловые связи и история удаляются каскадом (onDelete cascade).
        await tx.delete(vehicleRequests).where(eq(vehicleRequests.id, id));
        await hardDeleteFiles(tx, linked);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.hard_delete',
        entityType: 'vehicle_request',
        entityId: id,
      });
      return { ok: true, mode: 'hard' };
    }

    await db
      .update(vehicleRequests)
      .set({
        deletedAt: new Date(),
        deletedBy: p.id,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(vehicleRequests.id, id));
    await writeAudit({
      actorUserId: p.id,
      action: 'vehicle_request.soft_delete',
      entityType: 'vehicle_request',
      entityId: id,
    });
    return { ok: true, mode: 'soft' };
  });

  // ── Восстановление (admin) ──
  r.post(
    '/:id/restore',
    { preHandler: [app.authenticate, app.requireRoles('admin')], schema: { params: idParams } },
    async (req) => {
      const [existing] = await db
        .select()
        .from(vehicleRequests)
        .where(eq(vehicleRequests.id, req.params.id));
      if (!existing) throw err.notFound('Заявка не найдена');
      if (existing.deletedAt) {
        await db
          .update(vehicleRequests)
          .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
          .where(eq(vehicleRequests.id, existing.id));
        await writeAudit({
          actorUserId: requirePrincipal(req).id,
          action: 'vehicle_request.restore',
          entityType: 'vehicle_request',
          entityId: existing.id,
        });
      }
      return (await getDto(existing.id))!;
    },
  );
}
