import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  can,
  createUploadSessionSchema,
  fileDownloadQuerySchema,
  type FileDto,
  isInlineViewable,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  files,
  type FileRow,
  requestFiles,
  vehicleRequestAssignments,
  vehicleRequestFiles,
  vehicleRequests,
  vehicles,
  wasteRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import {
  lessorVisibilityWhere,
  operatorVisibilityWhere,
  wasteRequestVisibilityWhere,
  vehicleRequestVisibilityWhere,
} from '../lib/access';
import { isFileLinked } from '../services/request-files';
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

/** Где найден файл: связи проверяются только по тем модулям, которые роли вообще доступны. */
export interface FileLinkage {
  /** Файл связан с видимой пользователю заявкой вывоза (вложение заявки или талон машины). */
  visibleWaste: boolean;
  /** Файл связан с видимой пользователю заявкой на технику. */
  visibleVehicle: boolean;
  /** Файл вообще привязан хоть к чему-нибудь — неважно, видно это пользователю или нет. */
  linkedAnywhere: boolean;
}

/**
 * Решение о доступе к файлу по правам и найденным связям (ADR 0021).
 *
 * Авторство даёт доступ только к ещё не привязанному файлу: так работает форма — файл грузится
 * до сохранения заявки и до этого момента виден лишь тому, кто его выбрал. Как только файл
 * попал в заявку, он живёт по её правилам: иначе загрузивший сохранял бы доступ и после смены
 * роли, объекта или контрагента, а сама заявка ему уже не видна.
 */
export function decideFileAccess(
  p: Principal,
  uploadedBy: string | null,
  linkage: FileLinkage,
): boolean {
  if (linkage.visibleWaste && can(p, 'wasteRequests.read')) return true;
  if (linkage.visibleVehicle && can(p, 'vehicleRequests.read')) return true;
  return !linkage.linkedAnywhere && !!uploadedBy && uploadedBy === p.id;
}

async function canAccessFile(
  p: Principal,
  fileId: string,
  uploadedBy: string | null,
): Promise<boolean> {
  // Связи ищем только по доступным ролям модулям: иначе учётка без роли (и любая новая роль)
  // прошла бы по заявке вывоза — ограничения видимости на неё не действуют, они про штаб и
  // оператора.
  const canReadWaste = can(p, 'wasteRequests.read');
  const canReadVehicle = can(p, 'vehicleRequests.read');

  let visibleWaste = false;
  if (canReadWaste) {
    // Доступ через связанную не удалённую заявку вывоза, видимую пользователю. Талоны с ADR 0024
    // лежат там же (request_files, kind='ticket'), поэтому отдельной ветки для них нет.
    const waste = await db
      .select({ id: wasteRequests.id })
      .from(requestFiles)
      .innerJoin(wasteRequests, eq(requestFiles.requestId, wasteRequests.id))
      .where(
        and(
          eq(requestFiles.fileId, fileId),
          isNull(wasteRequests.deletedAt),
          wasteRequestVisibilityWhere(p, wasteRequests.objectId),
          operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
        ),
      )
      .limit(1);
    visibleWaste = waste.length > 0;
  }

  let visibleVehicle = false;
  if (!visibleWaste && canReadVehicle) {
    const vehicle = await db
      .select({ id: vehicleRequests.id })
      .from(vehicleRequestFiles)
      .innerJoin(vehicleRequests, eq(vehicleRequestFiles.vehicleRequestId, vehicleRequests.id))
      // Назначенная техника нужна не карточке файла, а области видимости: арендодателю видны
      // заявки, на которые вышли его машины (ADR 0038), — и вложения у них те же.
      .leftJoin(
        vehicleRequestAssignments,
        eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
      )
      .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
      .where(
        and(
          eq(vehicleRequestFiles.fileId, fileId),
          isNull(vehicleRequests.deletedAt),
          vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId),
          lessorVisibilityWhere(p, vehicles.lessorId),
        ),
      )
      .limit(1);
    visibleVehicle = vehicle.length > 0;
  }

  // Привязку целиком спрашиваем только у того, кому иначе отказали бы: это три запроса.
  const linkedAnywhere =
    visibleWaste || visibleVehicle
      ? true
      : uploadedBy === p.id
        ? await isFileLinked(fileId)
        : false;

  return decideFileAccess(p, uploadedBy, { visibleWaste, visibleVehicle, linkedAnywhere });
}

export default async function filesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Право на файл не выводится из роли: файл виден тому, кому видна связанная с ним заявка
  // (а свежезагруженный — тому, кто его загрузил). Проверка — в обработчике, по самой записи.
  const auth = {
    preHandler: [app.authenticate, app.authorizeInHandler('файл виден по связанной заявке')],
  };

  r.post(
    '/upload-session',
    { ...auth, schema: { body: createUploadSessionSchema } },
    async (req, reply) => {
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
    },
  );

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
      await db
        .update(files)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(eq(files.id, file.id));
      throw err.badRequest('Файл превышает допустимый размер');
    }
    const [updated] = await db
      .update(files)
      .set({ status: 'active', size: head.size })
      .where(eq(files.id, file.id))
      .returning();
    return toFileDto(updated!);
  });

  /**
   * Ссылка на файл: по умолчанию — скачивание, `disposition=inline` — показ содержимого
   * (портал вставляет такую ссылку в окно просмотра: картинкой или фреймом).
   * Инлайном отдаются только типы, которые браузер показывает сам (фото талона, PDF); всё
   * остальное всё равно уходит вложением — исполняемая разметка на домене хранилища не нужна.
   */
  r.get(
    '/:id/download',
    { ...auth, schema: { params: idParams, querystring: fileDownloadQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
      if (!file || file.status !== 'active' || file.deletedAt) throw err.notFound('Файл не найден');
      if (!(await canAccessFile(p, file.id, file.uploadedBy))) throw err.forbidden();
      const inline = req.query.disposition === 'inline' && isInlineViewable(file.contentType);
      const url = await presignGet(file.objectKey, file.filename, inline ? 'inline' : 'attachment');
      return { url, expiresIn: config.s3.downloadUrlTtl };
    },
  );

  r.delete('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
    if (!file || file.deletedAt) throw err.notFound('Файл не найден');
    // Свой файл удаляет автор загрузки, чужой — тот, кто ведёт заявки.
    if (file.uploadedBy !== p.id && !can(p, 'files.manageAny')) throw err.forbidden();
    // Прикреплённый к заявке файл удаляется только через редактирование заявки.
    if (await isFileLinked(file.id)) {
      throw err.conflict('Файл прикреплён к заявке — удалите его через редактирование заявки');
    }
    await softDeleteFile(file.id, file.objectKey);
    return { ok: true };
  });
}
