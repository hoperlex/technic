import { and, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { files, jobs, requestFiles, vehicleRequestFiles, waybillFiles } from '../db/schema';
import { err } from '../lib/errors';
import { JOB_DELETE_S3_OBJECT } from '../lib/jobs';

// Общий файловый сервис для обоих модулей заявок («Вывоз мусора» и «Заказ ТС»).
// Гарантирует кросс-модульную уникальность привязки (файл — максимум в одной заявке)
// и единые правила удаления из S3 через outbox-задачи.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * fileId, уже куда-то привязанные: вложение или талон заявки вывоза (request_files, ADR 0024),
 * вложение заявки на технику либо скан, подшитый к путевому листу (миграция 0087).
 *
 * Список таблиц обязан быть полным. Файл, прошедший мимо этой проверки, оказался бы привязан
 * дважды — и удаление одной из записей унесло бы его у второй: скан заполненного бланка исчез бы
 * из журнала строгой отчётности вместе с чужой заявкой.
 */
async function linkedFileIds(tx: Tx, fileIds: string[]): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const [waste, vehicle, waybill] = await Promise.all([
    tx
      .select({ fileId: requestFiles.fileId })
      .from(requestFiles)
      .where(inArray(requestFiles.fileId, fileIds)),
    tx
      .select({ fileId: vehicleRequestFiles.fileId })
      .from(vehicleRequestFiles)
      .where(inArray(vehicleRequestFiles.fileId, fileIds)),
    tx
      .select({ fileId: waybillFiles.fileId })
      .from(waybillFiles)
      .where(inArray(waybillFiles.fileId, fileIds)),
  ]);
  return new Set([...waste, ...vehicle, ...waybill].map((r) => r.fileId));
}

/**
 * Валидирует пригодность файлов к привязке: принадлежат загрузившему, не удалены,
 * не превышен лимит батча и файлы ещё не прикреплены ни к одной заявке (мусор/ТС).
 * `FOR UPDATE` сериализует конкурентные попытки привязать один и тот же файл.
 */
export async function assertFilesAttachable(
  tx: Tx,
  fileIds: string[],
  uploaderId: string,
): Promise<void> {
  if (fileIds.length === 0) return;
  if (fileIds.length > config.files.maxPerRequest) {
    throw err.badRequest(`Не более ${config.files.maxPerRequest} файлов`);
  }
  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(
      and(inArray(files.id, fileIds), eq(files.uploadedBy, uploaderId), isNull(files.deletedAt)),
    )
    .for('update');
  if (rows.length !== fileIds.length) {
    throw err.badRequest('Некоторые файлы недоступны или не принадлежат вам');
  }
  const linked = await linkedFileIds(tx, fileIds);
  if (linked.size > 0) throw err.badRequest('Файл уже прикреплён к заявке');
}

/** Проверка суммарного лимита файлов на заявку. */
export function assertTotalWithinLimit(existingCount: number, addCount: number): void {
  if (existingCount + addCount > config.files.maxPerRequest) {
    throw err.badRequest(`Не более ${config.files.maxPerRequest} файлов на заявку`);
  }
}

/** Помечает файлы активными (после успешной привязки). */
export async function markFilesActive(tx: Tx, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  await tx.update(files).set({ status: 'active' }).where(inArray(files.id, fileIds));
}

/** Признак существования файла в связях. Возвращает true, если прикреплён к любой заявке. */
export async function isFileLinked(fileId: string): Promise<boolean> {
  const [waste, vehicle] = await Promise.all([
    db
      .select({ f: requestFiles.fileId })
      .from(requestFiles)
      .where(eq(requestFiles.fileId, fileId))
      .limit(1),
    db
      .select({ f: vehicleRequestFiles.fileId })
      .from(vehicleRequestFiles)
      .where(eq(vehicleRequestFiles.fileId, fileId))
      .limit(1),
  ]);
  return waste.length > 0 || vehicle.length > 0;
}

/**
 * Помечает файлы удалёнными (status='deleted') и ставит задачу удаления из S3.
 * immediate=false — отложенно (+30 дней, при отвязке); true — немедленно.
 */
export async function scheduleFilesDeletion(
  tx: Tx,
  fileRows: { id: string; objectKey: string }[],
  immediate = false,
): Promise<void> {
  if (fileRows.length === 0) return;
  const ids = fileRows.map((f) => f.id);
  await tx
    .update(files)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(inArray(files.id, ids));
  const runAt = immediate ? new Date() : new Date(Date.now() + S3_DELETE_DELAY_MS);
  for (const f of fileRows) {
    await tx.insert(jobs).values({
      type: JOB_DELETE_S3_OBJECT,
      payload: { objectKey: f.objectKey },
      nextRunAt: runAt,
    });
  }
}

/**
 * Физически удаляет строки files (при hard-delete заявки, когда связи уже сняты каскадом)
 * и ставит немедленную задачу удаления из S3.
 */
export async function hardDeleteFiles(
  tx: Tx,
  fileRows: { id: string; objectKey: string }[],
): Promise<void> {
  if (fileRows.length === 0) return;
  await tx.delete(files).where(
    inArray(
      files.id,
      fileRows.map((f) => f.id),
    ),
  );
  for (const f of fileRows) {
    await tx.insert(jobs).values({
      type: JOB_DELETE_S3_OBJECT,
      payload: { objectKey: f.objectKey },
      nextRunAt: new Date(),
    });
  }
}
