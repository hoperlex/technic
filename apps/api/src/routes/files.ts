import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { createUploadSessionSchema, type FileDto } from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { files, type FileRow, requestFiles, wasteRequests } from '../db/schema';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import { requestVisibilityWhere } from '../lib/access';
import type { Principal } from '../auth/principal';
import { buildObjectKey, deleteObject, headObject, presignGet, presignPut } from '../lib/s3';
import { enqueueJob, JOB_DELETE_S3_OBJECT } from '../lib/jobs';

const idParams = z.object({ id: z.string().uuid() });
const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

export function toFileDto(f: FileRow): FileDto {
  return {
    id: f.id,
    filename: f.filename,
    contentType: f.contentType,
    size: f.size,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
  };
}

/** Помечает файл удалённым и планирует физическое удаление из S3 через 30 дней. */
export async function softDeleteFile(fileId: string, objectKey: string): Promise<void> {
  await db
    .update(files)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(files.id, fileId));
  await enqueueJob(
    JOB_DELETE_S3_OBJECT,
    { objectKey },
    { runAt: new Date(Date.now() + S3_DELETE_DELAY_MS) },
  );
}

async function canAccessFile(p: Principal, fileId: string, uploadedBy: string | null): Promise<boolean> {
  if (uploadedBy && uploadedBy === p.id) return true;
  const rows = await db
    .select({ id: wasteRequests.id })
    .from(requestFiles)
    .innerJoin(wasteRequests, eq(requestFiles.requestId, wasteRequests.id))
    .where(and(eq(requestFiles.fileId, fileId), isNull(wasteRequests.deletedAt), requestVisibilityWhere(p)))
    .limit(1);
  return rows.length > 0;
}

export default async function filesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { preHandler: [app.authenticate] };

  r.post('/upload-session', { ...auth, schema: { body: createUploadSessionSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const { filename, contentType, size } = req.body;
    if (size > config.files.maxSize) {
      throw err.badRequest(
        `Файл превышает лимит ${Math.floor(config.files.maxSize / 1024 / 1024)} МБ`,
      );
    }
    const objectKey = buildObjectKey(filename);
    const [file] = await db
      .insert(files)
      .values({
        bucket: config.s3.bucket,
        objectKey,
        filename,
        contentType,
        size,
        status: 'pending',
        uploadedBy: p.id,
      })
      .returning();
    const uploadUrl = await presignPut(objectKey, contentType);
    reply.code(201);
    return { fileId: file!.id, uploadUrl, objectKey, expiresIn: config.s3.uploadUrlTtl };
  });

  r.post('/:id/complete', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
    if (!file || file.deletedAt) throw err.notFound('Файл не найден');
    if (file.uploadedBy !== p.id) throw err.forbidden();
    if (file.status === 'active') return toFileDto(file);

    const head = await headObject(file.objectKey);
    if (!head) throw err.badRequest('Файл не найден в хранилище — загрузка не завершена');
    if (head.size > config.files.maxSize) {
      await deleteObject(file.objectKey);
      await db.update(files).set({ status: 'deleted', deletedAt: new Date() }).where(eq(files.id, file.id));
      throw err.badRequest('Файл превышает допустимый размер');
    }
    const [updated] = await db
      .update(files)
      .set({ status: 'active', size: head.size })
      .where(eq(files.id, file.id))
      .returning();
    return toFileDto(updated!);
  });

  r.get('/:id/download', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
    if (!file || file.status !== 'active' || file.deletedAt) throw err.notFound('Файл не найден');
    if (!(await canAccessFile(p, file.id, file.uploadedBy))) throw err.forbidden();
    const url = await presignGet(file.objectKey, file.filename);
    return { url, expiresIn: config.s3.downloadUrlTtl };
  });

  r.delete('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
    if (!file || file.deletedAt) throw err.notFound('Файл не найден');
    const canManage =
      p.role === 'admin' ||
      p.role === 'manager' ||
      p.role === 'dispatcher' ||
      file.uploadedBy === p.id;
    if (!canManage) throw err.forbidden();
    await softDeleteFile(file.id, file.objectKey);
    return { ok: true };
  });
}
