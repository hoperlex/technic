import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { files, jobs } from '../db/schema';
import { err } from '../lib/errors';
import { JOB_DELETE_S3_OBJECT } from '../lib/jobs';

// Общий файловый сервис для всех модулей заявок («Вывоз мусора», «Заказ ТС», «Обслуживание
// оргтехники», фотографии показаний техники). Гарантирует кросс-модульную уникальность привязки
// (файл — максимум в одном месте) и единые правила удаления из S3 через outbox-задачи.
//
// Перечня таблиц привязки здесь больше нет: он живёт в функции БД `file_is_linked(uuid)`
// (миграция 0133). Обе функции ниже — `linkedFileIds` (пакетно, «можно ли привязать») и
// `isFileLinked` (поштучно, «привязан ли уже») — зовут её, а не перечисляют таблицы сами.
//
// Причина переезда — третий читатель того же перечня: уборка файлов в воркере, которая ставит
// задачу на физическое удаление объекта из S3. Пока копий было две, забытая таблица стоила лишнего
// доступа (так и случилось с `waybill_files`); с появлением уборки та же забытая строка означает
// удалённый документ. Новая связь заводится в одном месте — в миграции, рядом с самой таблицей.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * fileId, уже куда-то привязанные: вложение или талон заявки вывоза (request_files, ADR 0024),
 * вложение заявки на технику, скан, подшитый к путевому листу (миграция 0087), документ заявки на
 * обслуживание оргтехники (service_request_files, миграция 0105) либо фотография показаний
 * (vehicle_reading_files). Перечень — в `file_is_linked(uuid)` (миграция 0133).
 *
 * Список таблиц обязан быть полным. Файл, прошедший мимо этой проверки, оказался бы привязан
 * дважды — и удаление одной из записей унесло бы его у второй: скан заполненного бланка исчез бы
 * из журнала строгой отчётности вместе с чужой заявкой, а акт выполненных работ — вместе с
 * удалённой заявкой вывоза.
 *
 * Запрос идёт от `files`, а не от таблиц связи: так функция БД зовётся один раз на файл, а не по
 * разу на модуль, и добавление следующего модуля не меняет здесь ни строки.
 */
async function linkedFileIds(tx: Tx, fileIds: string[]): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const rows = await tx
    .select({ fileId: files.id })
    .from(files)
    .where(and(inArray(files.id, fileIds), sql`file_is_linked(${files.id})`));
  return new Set(rows.map((r) => r.fileId));
}

/**
 * Валидирует пригодность файлов к привязке: принадлежат загрузившему, не удалены,
 * не превышен лимит батча и файлы ещё не прикреплены ни к одной заявке (мусор/ТС/оргтехника),
 * ни к одному путевому листу и ни к одному показанию.
 * `FOR UPDATE` сериализует конкурентные попытки привязать один и тот же файл — и он же
 * сериализует привязку с уборкой в воркере, которая берёт кандидатов той же блокировкой.
 *
 * `requireActive` — про статус загрузки, а не про права. По умолчанию (заявки) проверки статуса
 * нет исторически: форма заявки грузит файл и сохраняет заявку одним движением, и `pending`
 * означал «загрузка вот-вот завершится». Показаниям этого мало: фотографии приезжают вместе с
 * числами при отправке отчёта, а `pending` — это файл, объекта которого в хранилище может не быть
 * вовсе (загрузку оборвали) и который через сутки заберёт уборка. Отчёт со ссылкой на
 * несуществующий объект внешне неотличим от отчёта с фотографией — до дня, когда её попробуют
 * открыть.
 */
export async function assertFilesAttachable(
  tx: Tx,
  fileIds: string[],
  uploaderId: string,
  options: { requireActive?: boolean } = {},
): Promise<void> {
  if (fileIds.length === 0) return;
  if (fileIds.length > config.files.maxPerRequest) {
    throw err.badRequest(`Не более ${config.files.maxPerRequest} файлов`);
  }
  const rows = await tx
    .select({ id: files.id, status: files.status })
    .from(files)
    .where(
      and(inArray(files.id, fileIds), eq(files.uploadedBy, uploaderId), isNull(files.deletedAt)),
    )
    .for('update');
  if (rows.length !== fileIds.length) {
    throw err.badRequest('Некоторые файлы недоступны или не принадлежат вам');
  }
  if (options.requireActive && rows.some((r) => r.status !== 'active')) {
    throw err.badRequest('Загрузка файла не завершена — дождитесь окончания и повторите');
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

/**
 * Признак существования файла в связях. Возвращает true, если файл прикреплён хоть к чему-нибудь:
 * заявке любого модуля, путевому листу или показанию.
 *
 * Поштучный вариант того же вопроса, на который отвечает `linkedFileIds`, — и раньше это были два
 * независимых перечня таблиц, из-за чего пропуск модуля в одном из них не выглядел поломкой:
 * привязка работает, вложение видно, — но два правила портала переставали действовать разом.
 *
 * Первое: ветка авторства в `decideFileAccess` (routes/files.ts) открывает файл загрузившему,
 * пока он «ещё никуда не привязан», и это самое «не привязан» узнаётся отсюда. Забытая таблица
 * означает, что автор загрузки скачивает вложение по прямой ссылке вечно — в том числе после
 * того, как сама заявка перестала быть ему видна (сменились роль, объект, отдел, контрагент).
 *
 * Второе: `DELETE /files/:id` отказывает в удалении прикреплённого файла. Забытая таблица
 * означает, что автор загрузки в обход заявки уносит из неё документ.
 *
 * Теперь оба варианта спрашивают одну функцию БД, и разъехаться им негде.
 */
export async function isFileLinked(fileId: string): Promise<boolean> {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), sql`file_is_linked(${files.id})`))
    .limit(1);
  return rows.length > 0;
}

/**
 * Помечает файлы удалёнными (status='deleted') и ставит задачу удаления из S3.
 * immediate=false — отложенно (+30 дней, при отвязке); true — немедленно.
 *
 * Основную связь вызывающий к этому моменту уже снял, но это не доказывает, что файл свободен:
 * тот же объект может удерживать журнал качества распознавания или другой модуль. Повторная
 * проверка здесь — последняя граница перед необратимым заданием. Задачи ставятся только по строкам,
 * которые действительно обновились, иначе связанный файл остался бы активным в БД, но всё равно
 * уехал из S3.
 */
export async function scheduleFilesDeletion(
  tx: Tx,
  fileRows: { id: string; objectKey: string }[],
  immediate = false,
): Promise<void> {
  if (fileRows.length === 0) return;
  const ids = fileRows.map((f) => f.id);
  const deletable = await tx
    .update(files)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(and(inArray(files.id, ids), sql`NOT file_is_linked(${files.id})`))
    .returning({ id: files.id, objectKey: files.objectKey });
  const runAt = immediate ? new Date() : new Date(Date.now() + S3_DELETE_DELAY_MS);
  for (const f of deletable) {
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
 *
 * Как и отложенная ветка, повторно спрашивает единый реестр связей в самом удаляющем запросе.
 * `RETURNING` связывает outbox с фактом удаления: файл, который удержала хотя бы одна связь, не
 * получает задачу на снос объекта.
 */
export async function hardDeleteFiles(
  tx: Tx,
  fileRows: { id: string; objectKey: string }[],
): Promise<void> {
  if (fileRows.length === 0) return;
  const deleted = await tx
    .delete(files)
    .where(
      and(
        inArray(
          files.id,
          fileRows.map((f) => f.id),
        ),
        sql`NOT file_is_linked(${files.id})`,
      ),
    )
    .returning({ id: files.id, objectKey: files.objectKey });
  for (const f of deleted) {
    await tx.insert(jobs).values({
      type: JOB_DELETE_S3_OBJECT,
      payload: { objectKey: f.objectKey },
      nextRunAt: new Date(),
    });
  }
}
