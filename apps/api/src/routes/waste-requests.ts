import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  assignWasteOperatorSchema,
  changeWasteRequestStatusSchema,
  createWasteRequestSchema,
  type FileDto,
  MIN_WASTE_VOLUME_M3,
  type RequestType,
  updateWasteRequestSchema,
  type WasteRequestDto,
  type WasteRequestVehicleDto,
  wasteRequestListQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  containerTypes,
  counterparties,
  files,
  presentContainers,
  requestFiles,
  requestStatusHistory,
  users,
  wasteRequests,
  wasteTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import {
  assertNotOperator,
  assertOperatorScope,
  assertShtabScope,
  assertTransitionAllowed,
  canChangeStatus,
  canManageRequests,
  operatorVisibilityWhere,
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
import { priceWasteRequest, toNum } from '../services/waste-pricing';
import {
  countActiveVehicles,
  hardDeleteVehicles,
  insertVehicles,
  markVehiclesDeleted,
  restoreVehicles,
  vehicleFilesOfRequest,
  vehiclesByRequestIds,
} from '../services/waste-request-vehicles';
import { assertOperatorServesObject } from '../services/object-operators';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

const requestSelect = {
  id: wasteRequests.id,
  num: wasteRequests.num,
  objectId: wasteRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  requestType: wasteRequests.requestType,
  containerTypeId: wasteRequests.containerTypeId,
  containerTypeName: containerTypes.name,
  wasteTypeId: wasteRequests.wasteTypeId,
  wasteTypeName: wasteTypes.name,
  volumeM3: wasteRequests.volumeM3,
  pricePerM3: wasteRequests.pricePerM3,
  amount: wasteRequests.amount,
  deliveryAt: wasteRequests.deliveryAt,
  deliveryTimeUnspecified: wasteRequests.deliveryTimeUnspecified,
  comment: wasteRequests.comment,
  status: wasteRequests.status,
  // Причина отмены живёт в истории статусов; в списке нужна последняя и только у отменённых
  // заявок — после отката администратором прежняя причина к текущему статусу не относится.
  cancelReason: sql<string | null>`
    CASE WHEN ${wasteRequests.status} = 'cancelled' THEN (
      SELECT h.comment
      FROM ${requestStatusHistory} h
      WHERE h.request_id = ${wasteRequests.id} AND h.to_status = 'cancelled'
      ORDER BY h.changed_at DESC
      LIMIT 1
    ) END`.as('cancel_reason'),
  // Кто вывозит (ADR 0010): контрагент-оператор; он же определяет видимость заявки для оператора.
  operatorCounterpartyId: wasteRequests.operatorCounterpartyId,
  operatorName: counterparties.name,
  version: wasteRequests.version,
  createdBy: wasteRequests.createdBy,
  createdByName: users.fullName,
  createdAt: wasteRequests.createdAt,
  updatedAt: wasteRequests.updatedAt,
  deletedAt: wasteRequests.deletedAt,
};

type RequestRow = Awaited<ReturnType<typeof baseQuery>>[number];

async function filesByRequestIds(ids: string[]): Promise<Map<string, FileDto[]>> {
  const map = new Map<string, FileDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: requestFiles.requestId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(requestFiles)
    .innerJoin(files, eq(requestFiles.fileId, files.id))
    .where(and(inArray(requestFiles.requestId, ids), eq(files.status, 'active')));
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

function toDto(
  r: RequestRow,
  fileList: FileDto[],
  vehicles: WasteRequestVehicleDto[] = [],
): WasteRequestDto {
  return {
    id: r.id,
    num: r.num,
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    requestType: r.requestType,
    containerTypeId: r.containerTypeId,
    containerTypeName: r.containerTypeName,
    wasteTypeId: r.wasteTypeId,
    wasteTypeName: r.wasteTypeName,
    volumeM3: r.volumeM3,
    pricePerM3: toNum(r.pricePerM3),
    amount: toNum(r.amount),
    operatorCounterpartyId: r.operatorCounterpartyId,
    operatorName: r.operatorName,
    deliveryAt: r.deliveryAt.toISOString(),
    deliveryTimeUnspecified: r.deliveryTimeUnspecified,
    comment: r.comment,
    status: r.status,
    // Пустой комментарий отмены (история до миграции 0024) читается как «причина не указана».
    cancelReason: r.cancelReason || null,
    files: fileList,
    vehicles,
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

// Справочники присоединяются left join: тип контейнера/машины опционален в зависимости от типа
// заявки, тип мусора есть только у тарифицируемых операций (ADR 0009), а оператор может быть
// ещё не назначен (ADR 0010).
function baseQuery() {
  return db
    .select(requestSelect)
    .from(wasteRequests)
    .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
    .leftJoin(containerTypes, eq(wasteRequests.containerTypeId, containerTypes.id))
    .leftJoin(wasteTypes, eq(wasteRequests.wasteTypeId, wasteTypes.id))
    .leftJoin(counterparties, eq(wasteRequests.operatorCounterpartyId, counterparties.id))
    .innerJoin(users, eq(wasteRequests.createdBy, users.id));
}

/**
 * Оператор заявки — контрагент типа «Оператор» (ADR 0010). Подрядчик в этом поле означал бы,
 * что заявку увидит не тот, кто её выполняет: видимость оператора считается по этой колонке.
 */
async function assertOperatorAssignable(
  tx: Tx,
  counterpartyId: string,
  objectId: string,
): Promise<void> {
  const [cp] = await tx
    .select({
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  if (!cp || cp.deletedAt) throw err.badRequest('Контрагент не найден');
  if (cp.type !== 'operator') {
    throw err.badRequest('Оператором заявки может быть только контрагент типа «Оператор»', {
      operatorCounterpartyId: 'Нужен контрагент типа «Оператор»',
    });
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  // Исполнитель должен работать на объекте заявки (ADR 0010, миграция 0027).
  await assertOperatorServesObject(tx, objectId, counterpartyId);
}

/** Нормализованный набор «предметных» колонок заявки, включая снимок цены (ADR 0009). */
interface RequestSubject {
  containerTypeId: string | null;
  wasteTypeId: string | null;
  volumeM3: number | null;
  wasteTariffId: string | null;
  pricePerM3: string | null;
}

/** Присутствует ли контейнер этого типа на объекте (по view наличия present_containers). */
async function isTypePresent(tx: Tx, objectId: string, containerTypeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: presentContainers.id })
    .from(presentContainers)
    .where(
      and(
        eq(presentContainers.objectId, objectId),
        eq(presentContainers.containerTypeId, containerTypeId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Проверяет и нормализует поля заявки по её типу:
 *  - установка — сверяет тип контейнера (type='cont'), тарификации нет;
 *  - замена/снятие — сверяет, что контейнер этого типа присутствует на объекте (view наличия);
 *  - вывоз — сверяет тип из справочника (любой: машина или контейнер).
 * Для тарифицируемых операций (замена/снятие/вывоз) дополнительно требует тип мусора и объём,
 * подбирает тариф и возвращает снимок цены (ADR 0009). Лишние поля обнуляет.
 */
async function resolveSubject(
  tx: Tx,
  input: {
    requestType: RequestType;
    objectId: string;
    containerTypeId: string | null;
    wasteTypeId: string | null;
    volumeM3: number | null;
  },
): Promise<RequestSubject> {
  if (input.requestType === 'container_install') {
    if (!input.containerTypeId) throw err.badRequest('Выберите тип контейнера');
    const [ct] = await tx
      .select({ type: containerTypes.type })
      .from(containerTypes)
      .where(eq(containerTypes.id, input.containerTypeId));
    if (!ct) throw err.badRequest('Тип контейнера не найден');
    if (ct.type !== 'cont') throw err.badRequest('Для установки нужен тип контейнера');
    return {
      containerTypeId: input.containerTypeId,
      wasteTypeId: null,
      volumeM3: null,
      wasteTariffId: null,
      pricePerM3: null,
    };
  }

  if (input.requestType === 'container_replace') {
    if (!input.containerTypeId) throw err.badRequest('Выберите тип контейнера для замены');
    if (!(await isTypePresent(tx, input.objectId, input.containerTypeId))) {
      throw err.badRequest('На объекте нет контейнера этого типа для замены');
    }
  } else if (input.requestType === 'container_removal') {
    if (!input.containerTypeId) throw err.badRequest('Выберите тип контейнера для снятия');
    if (!(await isTypePresent(tx, input.objectId, input.containerTypeId))) {
      throw err.badRequest('На объекте нет контейнера этого типа для снятия');
    }
  } else {
    // waste_removal — принимаем любой тип из справочника (машина или контейнер)
    if (!input.containerTypeId) throw err.badRequest('Выберите тип машины/контейнера');
    const [mt] = await tx
      .select({ id: containerTypes.id })
      .from(containerTypes)
      .where(eq(containerTypes.id, input.containerTypeId));
    if (!mt) throw err.badRequest('Тип не найден');
  }

  // Тарифицируемые операции: объём и тип мусора обязательны, цена берётся из прайса.
  if (!input.wasteTypeId) throw err.badRequest('Выберите тип мусора');
  if (input.volumeM3 == null) throw err.badRequest('Укажите объём');
  if (input.volumeM3 < MIN_WASTE_VOLUME_M3) {
    throw err.badRequest(`Объём не меньше ${MIN_WASTE_VOLUME_M3} м³`);
  }
  const [wt] = await tx
    .select({ id: wasteTypes.id, isActive: wasteTypes.isActive })
    .from(wasteTypes)
    .where(eq(wasteTypes.id, input.wasteTypeId));
  if (!wt) throw err.badRequest('Тип мусора не найден');
  if (!wt.isActive) throw err.badRequest('Тип мусора неактивен');

  const pricing = await priceWasteRequest({
    requestType: input.requestType,
    wasteTypeId: input.wasteTypeId,
    containerTypeId: input.containerTypeId,
    volumeM3: input.volumeM3,
  });

  return {
    containerTypeId: input.containerTypeId,
    wasteTypeId: input.wasteTypeId,
    volumeM3: input.volumeM3,
    wasteTariffId: pricing.wasteTariffId,
    pricePerM3: pricing.pricePerM3,
  };
}

async function getRequestDto(id: string): Promise<WasteRequestDto | null> {
  const [row] = await baseQuery().where(eq(wasteRequests.id, id));
  if (!row) return null;
  const [filesMap, vehiclesMap] = await Promise.all([
    filesByRequestIds([id]),
    vehiclesByRequestIds([id]),
  ]);
  return toDto(row, filesMap.get(id) ?? [], vehiclesMap.get(id) ?? []);
}

async function linkFiles(
  tx: Tx,
  requestId: string,
  fileIds: string[],
  uploaderId: string,
  enforceTotal = false,
): Promise<void> {
  if (fileIds.length === 0) return;
  await assertFilesAttachable(tx, fileIds, uploaderId);
  if (enforceTotal) {
    const [c] = await tx
      .select({ c: count() })
      .from(requestFiles)
      .where(eq(requestFiles.requestId, requestId));
    assertTotalWithinLimit(Number(c!.c), fileIds.length);
  }
  await tx.insert(requestFiles).values(fileIds.map((fileId) => ({ requestId, fileId })));
  await markFilesActive(tx, fileIds);
}

async function unlinkFiles(tx: Tx, requestId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(requestFiles)
    .innerJoin(files, eq(requestFiles.fileId, files.id))
    .where(and(eq(requestFiles.requestId, requestId), inArray(requestFiles.fileId, fileIds)));
  if (linked.length === 0) return;
  const ids = linked.map((l) => l.id);
  await tx
    .delete(requestFiles)
    .where(and(eq(requestFiles.requestId, requestId), inArray(requestFiles.fileId, ids)));
  await scheduleFilesDeletion(tx, linked, false);
}

export default async function wasteRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { preHandler: [app.authenticate] };

  r.get('/', { ...auth, schema: { querystring: wasteRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const showDeleted = q.includeDeleted && p.role === 'admin';
    const where = and(
      showDeleted ? undefined : isNull(wasteRequests.deletedAt),
      requestVisibilityWhere(p, wasteRequests.objectId),
      operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
      q.status ? eq(wasteRequests.status, q.status) : undefined,
      q.objectId ? eq(wasteRequests.objectId, q.objectId) : undefined,
      q.containerTypeId ? eq(wasteRequests.containerTypeId, q.containerTypeId) : undefined,
      q.operatorCounterpartyId
        ? eq(wasteRequests.operatorCounterpartyId, q.operatorCounterpartyId)
        : undefined,
      q.requestType ? eq(wasteRequests.requestType, q.requestType) : undefined,
      q.num ? eq(wasteRequests.num, q.num) : undefined,
      q.deliveryFrom ? gte(wasteRequests.deliveryAt, q.deliveryFrom) : undefined,
      q.deliveryTo ? lte(wasteRequests.deliveryAt, q.deliveryTo) : undefined,
      searchCondition(q.search, [
        wasteRequests.comment,
        constructionObjects.name,
        constructionObjects.code,
      ]),
    );
    const sortCols = {
      objectName: constructionObjects.name,
      createdByName: users.fullName,
      containerTypeName: containerTypes.name,
      requestType: wasteRequests.requestType,
      deliveryAt: wasteRequests.deliveryAt,
      status: wasteRequests.status,
      operatorName: counterparties.name,
      createdAt: wasteRequests.createdAt,
    };
    const p2 = pageParams(q);
    const rows = await baseQuery()
      .where(where)
      .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
      .limit(p2.limit)
      .offset(p2.offset);
    const [totalRow] = await db
      .select({ c: count() })
      .from(wasteRequests)
      .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
      .where(where);
    const [filesMap, vehiclesMap] = await Promise.all([
      filesByRequestIds(rows.map((row) => row.id)),
      vehiclesByRequestIds(rows.map((row) => row.id)),
    ]);
    return {
      items: rows.map((row) =>
        toDto(row, filesMap.get(row.id) ?? [], vehiclesMap.get(row.id) ?? []),
      ),
      total: Number(totalRow!.c),
      page: p2.page,
      pageSize: p2.pageSize,
    };
  });

  // Наличие контейнеров на площадках (view present_containers): присутствующие заявки установки.
  r.get(
    '/present',
    { ...auth, schema: { querystring: wasteRequestListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const where = and(
        isNull(wasteRequests.deletedAt),
        requestVisibilityWhere(p, wasteRequests.objectId),
        operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
        inArray(wasteRequests.id, db.select({ id: presentContainers.id }).from(presentContainers)),
        q.objectId ? eq(wasteRequests.objectId, q.objectId) : undefined,
        searchCondition(q.search, [constructionObjects.name, constructionObjects.code]),
      );
      const sortCols = {
        objectName: constructionObjects.name,
        containerTypeName: containerTypes.name,
        deliveryAt: wasteRequests.deliveryAt,
        createdAt: wasteRequests.createdAt,
      };
      const p2 = pageParams(q);
      const rows = await baseQuery()
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
        .limit(p2.limit)
        .offset(p2.offset);
      const [totalRow] = await db
        .select({ c: count() })
        .from(wasteRequests)
        .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
        .where(where);
      const filesMap = await filesByRequestIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, filesMap.get(row.id) ?? [])),
        total: Number(totalRow!.c),
        page: p2.page,
        pageSize: p2.pageSize,
      };
    },
  );

  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const dto = await getRequestDto(req.params.id);
    if (!dto) throw err.notFound('Заявка не найдена');
    assertShtabScope(p, dto.objectId);
    assertOperatorScope(p, dto.operatorCounterpartyId);
    return dto;
  });

  r.post('/', { ...auth, schema: { body: createWasteRequestSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const body = req.body;
    // Оператор — исполнитель, а не заказчик: заявки он только просматривает и закрывает (ADR 0010).
    assertNotOperator(p, 'Оператор не может создавать заявки');
    assertShtabScope(p, body.objectId);
    const created = await db.transaction(async (tx) => {
      const subject = await resolveSubject(tx, {
        requestType: body.requestType,
        objectId: body.objectId,
        containerTypeId: body.containerTypeId ?? null,
        wasteTypeId: body.wasteTypeId ?? null,
        volumeM3: body.volumeM3 ?? null,
      });
      if (body.operatorCounterpartyId) {
        await assertOperatorAssignable(tx, body.operatorCounterpartyId, body.objectId);
      }
      const [row] = await tx
        .insert(wasteRequests)
        .values({
          objectId: body.objectId,
          requestType: body.requestType,
          ...subject,
          operatorCounterpartyId: body.operatorCounterpartyId ?? null,
          deliveryAt: body.deliveryAt,
          deliveryTimeUnspecified: body.deliveryTimeUnspecified,
          comment: body.comment,
          status: 'new',
          createdBy: p.id,
        })
        .returning({ id: wasteRequests.id });
      await tx.insert(requestStatusHistory).values({
        requestId: row!.id,
        fromStatus: null,
        toStatus: 'new',
        changedBy: p.id,
      });
      await linkFiles(tx, row!.id, body.fileIds, p.id);
      return row!;
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'waste_request.create',
      entityType: 'waste_request',
      entityId: created.id,
    });
    reply.code(201);
    return (await getRequestDto(created.id))!;
  });

  r.patch(
    '/:id',
    { ...auth, schema: { params: idParams, body: updateWasteRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      const [existing] = await db.select().from(wasteRequests).where(eq(wasteRequests.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      assertNotOperator(p, 'Оператор не может редактировать заявки');
      assertShtabScope(p, existing.objectId);
      if (p.role === 'shtab' && existing.status !== 'new') {
        throw err.forbidden('Штаб может редактировать заявку только в статусе «Новая»');
      }
      if (body.objectId) assertShtabScope(p, body.objectId);

      const rt = body.requestType ?? existing.requestType;
      const objectId = body.objectId ?? existing.objectId;
      const operatorCounterpartyId =
        body.operatorCounterpartyId !== undefined
          ? body.operatorCounterpartyId
          : existing.operatorCounterpartyId;
      await db.transaction(async (tx) => {
        const subject = await resolveSubject(tx, {
          requestType: rt,
          objectId,
          containerTypeId:
            body.containerTypeId !== undefined ? body.containerTypeId : existing.containerTypeId,
          wasteTypeId: body.wasteTypeId !== undefined ? body.wasteTypeId : existing.wasteTypeId,
          volumeM3: body.volumeM3 !== undefined ? body.volumeM3 : existing.volumeM3,
        });
        // Проверяем и при переносе заявки на другой объект: пара «оператор — объект» могла
        // разойтись, даже если исполнителя не меняли.
        if (
          operatorCounterpartyId &&
          (operatorCounterpartyId !== existing.operatorCounterpartyId ||
            objectId !== existing.objectId)
        ) {
          await assertOperatorAssignable(tx, operatorCounterpartyId, objectId);
        }
        const [updated] = await tx
          .update(wasteRequests)
          .set({
            objectId,
            requestType: rt,
            ...subject,
            operatorCounterpartyId,
            deliveryAt: body.deliveryAt ?? existing.deliveryAt,
            // Признак меняется только вместе с датой — иначе остаётся прежним.
            deliveryTimeUnspecified: body.deliveryAt
              ? (body.deliveryTimeUnspecified ?? false)
              : existing.deliveryTimeUnspecified,
            comment: body.comment ?? existing.comment,
            updatedBy: p.id,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(wasteRequests.id, id), eq(wasteRequests.version, body.version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
        if (body.removeFileIds?.length) await unlinkFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) await linkFiles(tx, id, body.addFileIds, p.id, true);
        // Машины заявки (ADR 0011). Пометку ставит и снимает любой, кто правит заявку; удалить
        // запись насовсем может только администратор — ошибочно снятый талон иначе не заметить.
        if (body.deleteVehicleIds?.length && p.role !== 'admin') {
          throw err.forbidden('Удалить машину насовсем может только администратор');
        }
        if (body.addVehicles?.length) await insertVehicles(tx, id, body.addVehicles, p.id);
        if (body.markDeletedVehicleIds?.length) {
          await markVehiclesDeleted(tx, id, body.markDeletedVehicleIds, p.id);
        }
        if (body.restoreVehicleIds?.length) await restoreVehicles(tx, id, body.restoreVehicleIds);
        if (body.deleteVehicleIds?.length) await hardDeleteVehicles(tx, id, body.deleteVehicleIds);
        // Выполненная заявка без единой машины означала бы вывоз без подтверждения — то же
        // требование, что и при закрытии.
        if (existing.status === 'done' && (await countActiveVehicles(tx, id)) === 0) {
          throw err.badRequest('У выполненной заявки должна остаться хотя бы одна машина', {
            vehicles: 'Оставьте хотя бы одну машину',
          });
        }
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.update',
        entityType: 'waste_request',
        entityId: id,
      });
      return (await getRequestDto(id))!;
    },
  );

  // Назначение (или снятие) оператора вывоза — отдельно от общего PATCH: тот пересчитывает
  // предмет заявки и тариф, а смена исполнителя предмета не касается (ADR 0010).
  r.patch(
    '/:id/operator',
    { ...auth, schema: { params: idParams, body: assignWasteOperatorSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      if (!canManageRequests(p)) throw err.forbidden('Оператора назначает диспетчер или менеджер');
      const { operatorCounterpartyId, version } = req.body;
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      await db.transaction(async (tx) => {
        if (operatorCounterpartyId) {
          await assertOperatorAssignable(tx, operatorCounterpartyId, existing.objectId);
        }
        const [updated] = await tx
          .update(wasteRequests)
          .set({
            operatorCounterpartyId,
            updatedBy: p.id,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(wasteRequests.id, existing.id), eq(wasteRequests.version, version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.assign_operator',
        entityType: 'waste_request',
        entityId: existing.id,
        metadata: { operatorCounterpartyId },
      });
      return (await getRequestDto(existing.id))!;
    },
  );

  r.patch(
    '/:id/status',
    { ...auth, schema: { params: idParams, body: changeWasteRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      if (!canChangeStatus(p)) throw err.forbidden('Недостаточно прав для смены статуса');
      const { status, comment, vehicles, version } = req.body;
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      assertShtabScope(p, existing.objectId);
      assertOperatorScope(p, existing.operatorCounterpartyId);
      if (existing.status === status) return (await getRequestDto(existing.id))!;
      assertTransitionAllowed(existing.status, status, p.role);
      await db.transaction(async (tx) => {
        // Закрытие заявки — это предъявление факта вывоза: машины заводятся тем же запросом,
        // и «Выполнена» без единой машины не проходит. При повторном закрытии (после отката
        // администратором) хватает уже заведённых — заново их вносить не нужно (ADR 0011).
        if (status === 'done') {
          await insertVehicles(tx, existing.id, vehicles, p.id);
          if ((await countActiveVehicles(tx, existing.id)) === 0) {
            throw err.badRequest('Укажите хотя бы одну машину с объёмом вывоза', {
              vehicles: 'Добавьте машину',
            });
          }
        }
        const [updated] = await tx
          .update(wasteRequests)
          .set({ status, updatedBy: p.id, version: existing.version + 1, updatedAt: new Date() })
          .where(and(eq(wasteRequests.id, existing.id), eq(wasteRequests.version, version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(requestStatusHistory).values({
          requestId: existing.id,
          fromStatus: existing.status,
          toStatus: status,
          changedBy: p.id,
          comment,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.status',
        entityType: 'waste_request',
        entityId: existing.id,
        metadata: { from: existing.status, to: status, comment },
      });
      return (await getRequestDto(existing.id))!;
    },
  );

  r.delete('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = req.params;
    const [existing] = await db.select().from(wasteRequests).where(eq(wasteRequests.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
    assertNotOperator(p, 'Оператор не может удалять заявки');
    assertShtabScope(p, existing.objectId);
    if (p.role === 'shtab' && existing.status !== 'new') {
      throw err.forbidden('Штаб может удалять заявку только в статусе «Новая»');
    }

    if (existing.status === 'new') {
      // hard delete + физическое удаление файлов (вложений заявки и талонов её машин)
      await db.transaction(async (tx) => {
        const linked = await tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(requestFiles)
          .innerJoin(files, eq(requestFiles.fileId, files.id))
          .where(eq(requestFiles.requestId, id));
        const tickets = await vehicleFilesOfRequest(tx, id);
        // Машины уходят каскадом вместе с заявкой, но строки files каскад не трогает.
        await tx.delete(wasteRequests).where(eq(wasteRequests.id, id));
        await hardDeleteFiles(tx, [...linked, ...tickets]);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.hard_delete',
        entityType: 'waste_request',
        entityId: id,
      });
      return { ok: true, mode: 'hard' };
    }

    await db
      .update(wasteRequests)
      .set({
        deletedAt: new Date(),
        deletedBy: p.id,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(wasteRequests.id, id));
    await writeAudit({
      actorUserId: p.id,
      action: 'waste_request.soft_delete',
      entityType: 'waste_request',
      entityId: id,
    });
    return { ok: true, mode: 'soft' };
  });

  r.post(
    '/:id/restore',
    { preHandler: [app.authenticate, app.requireRoles('admin')], schema: { params: idParams } },
    async (req) => {
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing) throw err.notFound('Заявка не найдена');
      if (existing.deletedAt) {
        await db
          .update(wasteRequests)
          .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
          .where(eq(wasteRequests.id, existing.id));
        await writeAudit({
          actorUserId: requirePrincipal(req).id,
          action: 'waste_request.restore',
          entityType: 'waste_request',
          entityId: existing.id,
        });
      }
      return (await getRequestDto(existing.id))!;
    },
  );
}
