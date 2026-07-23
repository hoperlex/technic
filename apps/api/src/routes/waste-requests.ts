import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import {
  canTransitionStatus,
  changeWasteRequestStatusSchema,
  createWasteRequestSchema,
  type FileDto,
  MIN_WASTE_VOLUME_M3,
  type RequestType,
  updateWasteRequestSchema,
  type WasteRequestDto,
  wasteRequestListQuerySchema,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  constructionObjects,
  containerTypes,
  files,
  jobs,
  requestFiles,
  requestStatusHistory,
  users,
  wasteRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { canChangeStatus, requestVisibilityWhere } from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { JOB_DELETE_S3_OBJECT } from '../lib/jobs';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });
const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

const requestSelect = {
  id: wasteRequests.id,
  objectId: wasteRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  requestType: wasteRequests.requestType,
  containerTypeId: wasteRequests.containerTypeId,
  containerTypeName: containerTypes.name,
  volumeM3: wasteRequests.volumeM3,
  deliveryAt: wasteRequests.deliveryAt,
  comment: wasteRequests.comment,
  status: wasteRequests.status,
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

function toDto(r: RequestRow, fileList: FileDto[]): WasteRequestDto {
  return {
    id: r.id,
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    requestType: r.requestType,
    containerTypeId: r.containerTypeId,
    containerTypeName: r.containerTypeName,
    volumeM3: r.volumeM3,
    deliveryAt: r.deliveryAt.toISOString(),
    comment: r.comment,
    status: r.status,
    files: fileList,
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

function baseQuery() {
  return db
    .select(requestSelect)
    .from(wasteRequests)
    .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
    // тип контейнера/машины опционален в зависимости от типа заявки
    .leftJoin(containerTypes, eq(wasteRequests.containerTypeId, containerTypes.id))
    .innerJoin(users, eq(wasteRequests.createdBy, users.id));
}

/** Нормализованный набор «предметных» колонок заявки. */
interface RequestSubject {
  containerTypeId: string | null;
  volumeM3: number | null;
}

/**
 * Проверяет и нормализует поля заявки по её типу:
 *  - установка — сверяет тип контейнера (type='cont');
 *  - замена — сверяет, что тип установлен на объекте (есть заявка установки этого типа, кроме cancelled);
 *  - вывоз — сверяет тип из справочника (любой: машина или контейнер) + объём.
 * Лишние поля обнуляет.
 */
async function resolveSubject(
  tx: Tx,
  input: {
    requestType: RequestType;
    objectId: string;
    containerTypeId: string | null;
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
    return { containerTypeId: input.containerTypeId, volumeM3: null };
  }

  if (input.requestType === 'container_replace') {
    if (!input.containerTypeId) throw err.badRequest('Выберите тип контейнера для замены');
    // тип должен быть установлен на объекте: есть заявка установки этого типа (кроме отменённой/удалённой)
    const [inst] = await tx
      .select({ id: wasteRequests.id })
      .from(wasteRequests)
      .where(
        and(
          eq(wasteRequests.objectId, input.objectId),
          eq(wasteRequests.requestType, 'container_install'),
          eq(wasteRequests.containerTypeId, input.containerTypeId),
          isNull(wasteRequests.deletedAt),
          ne(wasteRequests.status, 'cancelled'),
        ),
      )
      .limit(1);
    if (!inst) throw err.badRequest('На объекте нет установленного контейнера этого типа');
    return { containerTypeId: input.containerTypeId, volumeM3: null };
  }

  // waste_removal — принимаем любой тип из справочника (машина или контейнер)
  if (!input.containerTypeId) throw err.badRequest('Выберите тип машины/контейнера');
  const [mt] = await tx
    .select({ id: containerTypes.id })
    .from(containerTypes)
    .where(eq(containerTypes.id, input.containerTypeId));
  if (!mt) throw err.badRequest('Тип не найден');
  if (input.volumeM3 == null) throw err.badRequest('Укажите объём');
  if (input.volumeM3 < MIN_WASTE_VOLUME_M3) {
    throw err.badRequest(`Объём не меньше ${MIN_WASTE_VOLUME_M3} м³`);
  }
  return { containerTypeId: input.containerTypeId, volumeM3: input.volumeM3 };
}

async function getRequestDto(id: string): Promise<WasteRequestDto | null> {
  const [row] = await baseQuery().where(eq(wasteRequests.id, id));
  if (!row) return null;
  const filesMap = await filesByRequestIds([id]);
  return toDto(row, filesMap.get(id) ?? []);
}

async function linkFiles(
  tx: Tx,
  requestId: string,
  fileIds: string[],
  uploaderId: string,
  enforceTotal = false,
): Promise<void> {
  if (fileIds.length === 0) return;
  if (fileIds.length > config.files.maxPerRequest) {
    throw err.badRequest(`Не более ${config.files.maxPerRequest} файлов`);
  }
  const rows = await tx
    .select()
    .from(files)
    .where(and(inArray(files.id, fileIds), eq(files.uploadedBy, uploaderId), isNull(files.deletedAt)));
  if (rows.length !== fileIds.length) {
    throw err.badRequest('Некоторые файлы недоступны или не принадлежат вам');
  }
  const already = await tx
    .select({ fileId: requestFiles.fileId })
    .from(requestFiles)
    .where(inArray(requestFiles.fileId, fileIds));
  if (already.length > 0) throw err.badRequest('Файл уже прикреплён к заявке');
  if (enforceTotal) {
    const [c] = await tx
      .select({ c: count() })
      .from(requestFiles)
      .where(eq(requestFiles.requestId, requestId));
    if (Number(c!.c) + fileIds.length > config.files.maxPerRequest) {
      throw err.badRequest(`Не более ${config.files.maxPerRequest} файлов на заявку`);
    }
  }
  await tx.insert(requestFiles).values(fileIds.map((fileId) => ({ requestId, fileId })));
  await tx.update(files).set({ status: 'active' }).where(inArray(files.id, fileIds));
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
  await tx.update(files).set({ status: 'deleted', deletedAt: new Date() }).where(inArray(files.id, ids));
  for (const l of linked) {
    await tx.insert(jobs).values({
      type: JOB_DELETE_S3_OBJECT,
      payload: { objectKey: l.objectKey },
      nextRunAt: new Date(Date.now() + S3_DELETE_DELAY_MS),
    });
  }
}

function assertShtabScope(p: Principal, objectId: string): void {
  if (p.role === 'shtab' && objectId !== p.constructionObjectId) {
    throw err.forbidden('Штаб работает только со своим объектом');
  }
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
      requestVisibilityWhere(p),
      q.status ? eq(wasteRequests.status, q.status) : undefined,
      q.objectId ? eq(wasteRequests.objectId, q.objectId) : undefined,
      q.containerTypeId ? eq(wasteRequests.containerTypeId, q.containerTypeId) : undefined,
      q.requestType ? eq(wasteRequests.requestType, q.requestType) : undefined,
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
      containerTypeName: containerTypes.name,
      requestType: wasteRequests.requestType,
      deliveryAt: wasteRequests.deliveryAt,
      status: wasteRequests.status,
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
  });

  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const dto = await getRequestDto(req.params.id);
    if (!dto) throw err.notFound('Заявка не найдена');
    assertShtabScope(p, dto.objectId);
    return dto;
  });

  r.post('/', { ...auth, schema: { body: createWasteRequestSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const body = req.body;
    assertShtabScope(p, body.objectId);
    const created = await db.transaction(async (tx) => {
      const subject = await resolveSubject(tx, {
        requestType: body.requestType,
        objectId: body.objectId,
        containerTypeId: body.containerTypeId ?? null,
        volumeM3: body.volumeM3 ?? null,
      });
      const [row] = await tx
        .insert(wasteRequests)
        .values({
          objectId: body.objectId,
          requestType: body.requestType,
          ...subject,
          deliveryAt: body.deliveryAt,
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
      assertShtabScope(p, existing.objectId);
      if (p.role === 'shtab' && existing.status !== 'new') {
        throw err.forbidden('Штаб может редактировать заявку только в статусе «Новая»');
      }
      if (body.objectId) assertShtabScope(p, body.objectId);

      const rt = body.requestType ?? existing.requestType;
      const objectId = body.objectId ?? existing.objectId;
      await db.transaction(async (tx) => {
        const subject = await resolveSubject(tx, {
          requestType: rt,
          objectId,
          containerTypeId:
            body.containerTypeId !== undefined ? body.containerTypeId : existing.containerTypeId,
          volumeM3: body.volumeM3 !== undefined ? body.volumeM3 : existing.volumeM3,
        });
        const [updated] = await tx
          .update(wasteRequests)
          .set({
            objectId,
            requestType: rt,
            ...subject,
            deliveryAt: body.deliveryAt ?? existing.deliveryAt,
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

  r.patch(
    '/:id/status',
    { ...auth, schema: { params: idParams, body: changeWasteRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      if (!canChangeStatus(p)) throw err.forbidden('Недостаточно прав для смены статуса');
      const { status, version } = req.body;
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      if (existing.status === status) return (await getRequestDto(existing.id))!;
      if (!canTransitionStatus(existing.status, status)) {
        throw err.badRequest(`Недопустимый переход статуса: ${existing.status} → ${status}`);
      }
      await db.transaction(async (tx) => {
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
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.status',
        entityType: 'waste_request',
        entityId: existing.id,
        metadata: { from: existing.status, to: status },
      });
      return (await getRequestDto(existing.id))!;
    },
  );

  r.delete('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = req.params;
    const [existing] = await db.select().from(wasteRequests).where(eq(wasteRequests.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
    assertShtabScope(p, existing.objectId);
    if (p.role === 'shtab' && existing.status !== 'new') {
      throw err.forbidden('Штаб может удалять заявку только в статусе «Новая»');
    }

    if (existing.status === 'new') {
      // hard delete + физическое удаление файлов
      await db.transaction(async (tx) => {
        const linked = await tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(requestFiles)
          .innerJoin(files, eq(requestFiles.fileId, files.id))
          .where(eq(requestFiles.requestId, id));
        await tx.delete(wasteRequests).where(eq(wasteRequests.id, id));
        if (linked.length > 0) {
          await tx.delete(files).where(inArray(files.id, linked.map((l) => l.id)));
          for (const l of linked) {
            await tx.insert(jobs).values({
              type: JOB_DELETE_S3_OBJECT,
              payload: { objectKey: l.objectKey },
              nextRunAt: new Date(),
            });
          }
        }
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
      .set({ deletedAt: new Date(), deletedBy: p.id, version: existing.version + 1, updatedAt: new Date() })
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
