import { db } from '../db/client';
import { jobs } from '../db/schema';

export const JOB_DELETE_S3_OBJECT = 'delete_s3_object';
export const JOB_CLEANUP_UPLOADS = 'cleanup_orphan_uploads';
/** Отправка одного письма: тело уже составлено и лежит в `mail_messages` (миграция 0097). */
export const JOB_SEND_EMAIL = 'send_email';
/**
 * Распознавание одного скана-талона вывоза (ADR 0114, решение 4; план — Р11). Единица работы —
 * **файл**, а не страница и не заявка: в транзакции закрытия заявки существует только `fileId`,
 * страницы появляются позже — после скачивания и растеризации у воркера.
 *
 * Полезная нагрузка — `{ requestId, fileId }` и **ничего больше**: версии заявки в задаче нет
 * намеренно (Р11). Правку выполненной заявки закрывают только ролям площадки, и она поднимает
 * `version`, так что сверка по версии молча отменяла бы распознавание из-за правки комментария.
 * Воркер сверяет состояние: заявка `done` и связь `request_files (requestId, fileId, 'ticket')`
 * жива — откат её рвёт, а повторное закрытие тем же листом законно.
 */
export const JOB_RECOGNIZE_WASTE_TICKET_FILE = 'recognize_waste_ticket_file';

/** Транзакция drizzle: ровно то, что даёт `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  /**
   * `tx` — когда задача обязана появиться вместе с тем, ради чего она заведена. У письма это
   * буквально так: строка журнала без задачи никогда не уйдёт, а задача без строки журнала не
   * найдёт, что отправлять. Без `tx` задача пишется отдельным соединением, как и раньше.
   */
  opts: { runAt?: Date; maxAttempts?: number; tx?: Tx } = {},
): Promise<string> {
  const [row] = await (opts.tx ?? db)
    .insert(jobs)
    .values({
      type,
      payload,
      nextRunAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .returning({ id: jobs.id });
  return row!.id;
}
