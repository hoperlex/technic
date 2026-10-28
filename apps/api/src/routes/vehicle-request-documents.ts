import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addVehicleRequestDocumentSchema,
  canAddVehicleRequestDocument,
  canRemoveVehicleRequestDocument,
  requestStatusLabels,
  uuidSchema,
  VEHICLE_REQUEST_DOCUMENT_LIMIT,
  type RequestStatus,
  type VehicleRequestDocumentDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  files,
  users,
  vehicleRequestAssignments,
  vehicleRequestFiles,
  vehicleRequests,
  vehicles,
} from '../db/schema';
import { assertArchiveVisible, assertLessorScope, assertRequestScope } from '../lib/access';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { fileView } from '../services/file-view';
import { changeSet, dateKeyRu, EMPTY } from '../services/request-diff';
import {
  assertFilesAttachable,
  markFilesActive,
  scheduleFilesDeletion,
} from '../services/request-files';

/**
 * Documents of a vehicle request (plan `docs/vehicle-rental-completion-documents-plan.md`, D5–D8).
 *
 * The card's documents table reads here: the requester's attachments and the typed, dated paper in
 * one list (D8). Paper is added and removed by these doors only; the request editor keeps its own
 * attachments and never sees a document (`vehicle_request_files.kind`). Who may add and remove is
 * the contracts' predicates; what this file adds is the request's visibility — the object or
 * department scope and the lessor's own requests — and the status read under the request lock.
 *
 * Download needs nothing here: `GET /files/:id/download` follows `vehicle_request_files` with the
 * same scope, the lessor's included, for both kinds.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: uuidSchema });
const fileParams = z.object({ id: uuidSchema, fileId: uuidSchema });

const NOT_FOUND = 'Заявка не найдена';

/** The request as the doors check it: its scope, its lessor and its status. */
interface DocumentTarget {
  id: string;
  status: RequestStatus;
}

/**
 * Reads the request with what its visibility is decided by and refuses an unseen one. `tx` given —
 * the request row is locked: the status a document is checked against must be the one the link is
 * written under, or a request rolled back to «Новая» meanwhile would take a document it refuses.
 */
async function loadTarget(p: Principal, requestId: string, tx?: Tx): Promise<DocumentTarget> {
  const query = (tx ?? db)
    .select({
      id: vehicleRequests.id,
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      lessorId: vehicles.lessorId,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  const [row] = tx ? await query.for('update', { of: vehicleRequests }) : await query;
  if (!row) throw err.notFound(NOT_FOUND);
  // Reading an archived request is the archive's right; adding paper to one is nobody's — it is
  // restored first, like every other change to it.
  if (tx && row.deletedAt) throw err.notFound(NOT_FOUND);
  assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
  assertRequestScope(p, row);
  assertLessorScope(p, row.lessorId);
  return { id: row.id, status: row.status };
}

/**
 * The merged table: attachments and documents, by the date the table shows (the typed date of a
 * document, the upload of an attachment), then by when they were added — a stable order for two
 * papers of one day.
 */
async function readDocuments(requestId: string): Promise<VehicleRequestDocumentDto[]> {
  const rows = await db
    .select({
      kind: vehicleRequestFiles.kind,
      docType: vehicleRequestFiles.docType,
      docDate: vehicleRequestFiles.docDate,
      addedAt: vehicleRequestFiles.addedAt,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
      // The name of a quarantined file does not leave the server; `fileView` decides it.
      quarantinedAt: files.quarantinedAt,
      uploadedBy: files.uploadedBy,
      uploadedByName: users.fullName,
    })
    .from(vehicleRequestFiles)
    .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(and(eq(vehicleRequestFiles.vehicleRequestId, requestId), eq(files.status, 'active')))
    .orderBy(
      asc(
        sql`coalesce(${vehicleRequestFiles.docDate}, (${vehicleRequestFiles.addedAt} AT TIME ZONE 'Europe/Moscow')::date)`,
      ),
      asc(vehicleRequestFiles.addedAt),
    );
  return rows.map((row) => ({
    kind: row.kind,
    file: fileView(row),
    docType: row.docType,
    docDate: row.docDate,
    addedAt: row.addedAt.toISOString(),
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByName ?? '',
  }));
}

/** «УПД от 14.10.2026» — how the history names a document next to its file. */
function documentTitle(docType: string, docDate: string): string {
  return `${docType} от ${dateKeyRu(docDate)}`;
}

export default async function vehicleRequestDocumentRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: [app.authenticate, app.requirePermission('vehicleRequests.read')] };
  /*
   * Adding and removing paper is running the request (D7): the guard is the permission of the
   * status corridor, which the lessor holds through its counterparty type. The status itself and
   * the uploader are asked inside, under the lock.
   */
  const write = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'vehicleRequests.status',
        'Документы к заявке добавляет тот, кто её ведёт',
      ),
    ],
  };

  r.get('/:id/documents', { ...read, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const target = await loadTarget(p, req.params.id);
    return { items: await readDocuments(target.id) };
  });

  r.post(
    '/:id/documents',
    { ...write, schema: { params: idParams, body: addVehicleRequestDocumentSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { fileId, docType, docDate } = req.body;
      const added = await db.transaction(async (tx) => {
        const target = await loadTarget(p, req.params.id, tx);
        if (!canAddVehicleRequestDocument(p, target)) {
          throw err.unprocessable(
            `Документы добавляют к заявке в работе, выполненной или отменённой — эта в статусе «${requestStatusLabels[target.status]}»`,
          );
        }
        const [c] = await tx
          .select({ c: count() })
          .from(vehicleRequestFiles)
          .where(
            and(
              eq(vehicleRequestFiles.vehicleRequestId, target.id),
              eq(vehicleRequestFiles.kind, 'document'),
            ),
          );
        if (Number(c!.c) >= VEHICLE_REQUEST_DOCUMENT_LIMIT) {
          throw err.unprocessable(
            `К заявке приложено ${VEHICLE_REQUEST_DOCUMENT_LIMIT} документов — больше добавить нельзя`,
          );
        }
        // The file must be the caller's own upload and linked nowhere yet: the shared rule of every
        // attachment, and the reason `files.uploaded_by` is who added the document.
        await assertFilesAttachable(tx, [fileId], p.id);
        await tx
          .insert(vehicleRequestFiles)
          .values({ vehicleRequestId: target.id, fileId, kind: 'document', docType, docDate });
        await markFilesActive(tx, [fileId]);
        const [file] = await tx
          .select({ filename: files.filename })
          .from(files)
          .where(eq(files.id, fileId));
        return { requestId: target.id, filename: file?.filename ?? '' };
      });
      const diff = changeSet();
      diff.changed('document', EMPTY, documentTitle(docType, docDate));
      diff.fileList('filesAdded', [{ id: fileId, filename: added.filename }]);
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.document_add',
        entityType: 'vehicle_request',
        entityId: added.requestId,
        metadata: { changes: diff.changes },
      });
      return { items: await readDocuments(added.requestId) };
    },
  );

  r.delete('/:id/documents/:fileId', { ...write, schema: { params: fileParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { fileId } = req.params;
    const removed = await db.transaction(async (tx) => {
      const target = await loadTarget(p, req.params.id, tx);
      const [link] = await tx
        .select({
          kind: vehicleRequestFiles.kind,
          docType: vehicleRequestFiles.docType,
          docDate: vehicleRequestFiles.docDate,
          objectKey: files.objectKey,
          filename: files.filename,
          uploadedBy: files.uploadedBy,
        })
        .from(vehicleRequestFiles)
        .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
        .where(
          and(
            eq(vehicleRequestFiles.vehicleRequestId, target.id),
            eq(vehicleRequestFiles.fileId, fileId),
          ),
        );
      if (!link) throw err.notFound('Документ не найден');
      if (link.kind !== 'document') {
        throw err.unprocessable('Вложение заявителя снимают в форме редактирования заявки');
      }
      if (!canRemoveVehicleRequestDocument(p, target, link)) {
        throw err.forbidden(
          'Документ снимает тот, кто его добавил, пока заявка в работе или закрыта, либо администратор',
        );
      }
      await tx
        .delete(vehicleRequestFiles)
        .where(
          and(
            eq(vehicleRequestFiles.vehicleRequestId, target.id),
            eq(vehicleRequestFiles.fileId, fileId),
          ),
        );
      await scheduleFilesDeletion(tx, [{ id: fileId, objectKey: link.objectKey }], false);
      return { requestId: target.id, ...link };
    });
    const diff = changeSet();
    diff.changed('document', documentTitle(removed.docType!, removed.docDate!), EMPTY);
    diff.fileList('filesRemoved', [{ id: fileId, filename: removed.filename }]);
    await writeAudit({
      actorUserId: p.id,
      action: 'vehicle_request.document_remove',
      entityType: 'vehicle_request',
      entityId: removed.requestId,
      metadata: { changes: diff.changes },
    });
    return { items: await readDocuments(removed.requestId) };
  });
}
