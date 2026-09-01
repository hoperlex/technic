import { and, count, eq, inArray } from 'drizzle-orm';
import { files, mechRequestFiles } from '../db/schema';
import {
  assertFilesAttachable,
  assertTotalWithinLimit,
  markFilesActive,
  scheduleFilesDeletion,
} from './request-files';
import type { MechTx } from './mech-request-dto';

// Вложения заявки на механизацию — полный контур (план `docs/mechanization-module-plan.md`, Р14).
//
// Модуль, о котором не знает `file_is_linked(uuid)`, отдаёт свои вложения загрузившему их человеку
// БЕССРОЧНО: `decideFileAccess` считает такой файл ничьим, а ничей файл доступен автору загрузки.
// Ветка функции завелась миграцией 0238, но её одной мало — путей осиротения три, и закрыты они
// должны быть все:
//
// | Путь                           | Что делать                                                   |
// | ------------------------------ | ------------------------------------------------------------ |
// | снятие вложения правкой        | снять связь и `scheduleFilesDeletion` (отложенно)            |
// | физическое удаление «Новой»    | собрать файлы join'ом → удалить заявку → `hardDeleteFiles`   |
// | `records.purge` архивной       | то же самое                                                   |
//
// Разница между отложенным и немедленным удалением не косметическая: отвязанный правкой файл человек
// мог снять по ошибке и приложить обратно, а удаляемая заявка уносит свои файлы сразу —
// восстанавливать нечего.

export async function linkMechRequestFiles(
  tx: MechTx,
  requestId: string,
  fileIds: string[],
  uploaderId: string,
  /** Считать ли общий предел на заявку: при заведении файлов ещё нет, при правке — уже есть. */
  enforceTotal = false,
): Promise<void> {
  if (fileIds.length === 0) return;
  await assertFilesAttachable(tx, fileIds, uploaderId);
  if (enforceTotal) {
    const [c] = await tx
      .select({ c: count() })
      .from(mechRequestFiles)
      .where(eq(mechRequestFiles.requestId, requestId));
    assertTotalWithinLimit(Number(c!.c), fileIds.length);
  }
  await tx.insert(mechRequestFiles).values(fileIds.map((fileId) => ({ requestId, fileId })));
  await markFilesActive(tx, fileIds);
}

/**
 * Первый и самый частый путь: **обычное снятие вложения правкой**. Снять только строку связи мало —
 * запись в `files` осталась бы живой и ничьей, а автор загрузки получил бы к ней доступ обратно, в
 * том числе после того, как сама заявка перестала быть ему видна (сменились роль, объект, отдел).
 *
 * Это та же дыра, что пропущенная ветка `file_is_linked`, с третьего конца.
 */
export async function unlinkMechRequestFiles(
  tx: MechTx,
  requestId: string,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(mechRequestFiles)
    .innerJoin(files, eq(mechRequestFiles.fileId, files.id))
    .where(
      and(eq(mechRequestFiles.requestId, requestId), inArray(mechRequestFiles.fileId, fileIds)),
    );
  if (linked.length === 0) return;
  const ids = linked.map((l) => l.id);
  await tx
    .delete(mechRequestFiles)
    .where(and(eq(mechRequestFiles.requestId, requestId), inArray(mechRequestFiles.fileId, ids)));
  await scheduleFilesDeletion(tx, linked, false);
}

/**
 * Второй и третий пути — физическое удаление «Новой» и `purge` архивной заявки. Набор собирается
 * join'ом ДО удаления заявки: каскад снимет `mech_request_files`, и защищённый `hardDeleteFiles`
 * увидит действительно свободные строки.
 */
export async function collectMechRequestFiles(
  tx: MechTx,
  requestId: string,
): Promise<{ id: string; objectKey: string }[]> {
  return tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(mechRequestFiles)
    .innerJoin(files, eq(mechRequestFiles.fileId, files.id))
    .where(eq(mechRequestFiles.requestId, requestId));
}
