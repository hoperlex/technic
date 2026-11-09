import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type FileDto,
  formatMechRequestNumber,
  type MechLessorReceiptVersionDto,
  type MechRequestDto,
  type MechRequestExtensionDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  files,
  mechModels,
  mechRequestExtensions,
  mechRequestFiles,
  mechRequestLessorReceipts,
  mechRequestStatusHistory,
  mechRequests,
  users,
} from '../db/schema';
import { fileView } from './file-view';
import {
  loadMechLessorReceipts,
  mechLessorReceiptFileOf,
  mechLessorReceiptVersionCounts,
  toMechLessorReceiptVersionDto,
} from './mech-lessor-receipt';

// Как заявка на механизацию выглядит наружу (план `docs/mechanization-module-plan.md`). Отдельно от
// маршрутов, потому что карточку собирают восемь ручек, и половина из них — внутри транзакции
// мутации: снимок «до» для диффа истории и снимок исчезающей строки для журнала берутся ПОД замком,
// то есть тем же соединением, что и запись.

export type MechTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Кто читает: обычное соединение или транзакция. Общий тип нужен ровно затем, чтобы снимок «до»
 * читался внутри транзакции: прочитанный до неё, он относился бы к состоянию, которое замок ещё не
 * держал (Р21).
 */
export type MechReader = MechTx | typeof db;

/** Кто отправил заявку в архив (ADR 0070) — второй join на users: первый занят автором заявки. */
const deleters = alias(users, 'mech_deleters');

/**
 * Кто завизировал аренду (план визы, Р1) — третий join на ту же таблицу. Именованный alias
 * обязателен: без него два соединения с `users` затирают друг другу колонки, и в карточке имя
 * автора встало бы на место подписи.
 */
const approvers = alias(users, 'mech_approvers');

/*
 * Who asked for the current extension and who decided it (ADR 0171, stage 3) — the fourth and
 * fifth join on `users`, named for the same reason as the two above: unnamed, the joins would
 * overwrite each other's columns and the card would show the author's name as the visa holder's.
 */
const extensionRequesters = alias(users, 'mech_extension_requesters');
const extensionDeciders = alias(users, 'mech_extension_deciders');

/*
 * The current lessor receipt version (lessor receipt plan, P16): at most one per request by the
 * partial unique index, so the outer join never multiplies rows of the list. Its file and the two
 * names on it (author and visa holder) under their own aliases, for the reason given above; the
 * current version is never retired, so it has no retirer to join.
 */
const currentLessorReceipts = alias(mechRequestLessorReceipts, 'mech_current_lessor_receipts');
const currentLessorReceiptFiles = alias(files, 'mech_current_lessor_receipt_files');
const lessorReceiptCreators = alias(users, 'mech_lessor_receipt_creators');
const lessorReceiptDeciders = alias(users, 'mech_lessor_receipt_deciders');

/** numeric в БД принимает и отдаёт строку; `null` остаётся `null`. */
export function toNum(v: string | null): number | null {
  return v == null ? null : Number(v);
}

/** Обратно: `numeric` принимает строку — так значение доезжает до БД без округления по пути. */
export function numToDb(v: number | null): string | null {
  return v == null ? null : String(v);
}

const requestSelect = {
  id: mechRequests.id,
  num: mechRequests.num,
  objectId: mechRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  objectAddress: constructionObjects.address,
  departmentId: mechRequests.departmentId,
  departmentCode: departments.code,
  departmentName: departments.name,
  mechModelId: mechRequests.mechModelId,
  // Наименование модели приходит JOIN'ом, а не снимком (ADR 0156): справочник переименовали —
  // переименовалось и в старых заявках, как везде в портале. Снимками хранятся только деньги.
  mechModelName: mechModels.name,
  plannedFrom: mechRequests.plannedFrom,
  plannedTo: mechRequests.plannedTo,
  responsibleName: mechRequests.responsibleName,
  responsiblePhone: mechRequests.responsiblePhone,
  comment: mechRequests.comment,
  status: mechRequests.status,
  // Виза площадки (план визы, Р1): кто и когда подписал. Имя — соединением, а не снимком: человек
  // мог сменить фамилию, и карточка обязана показывать сегодняшнюю.
  approvedBy: mechRequests.approvedBy,
  approvedByName: approvers.fullName,
  approvedAt: mechRequests.approvedAt,
  // Причина отмены живёт в истории статусов; в карточке нужна последняя и только у отменённых
  // заявок — после отката прежняя причина к текущему статусу не относится.
  cancelReason: sql<string | null>`
    CASE WHEN ${mechRequests.status} = 'cancelled' THEN (
      SELECT h.comment
      FROM ${mechRequestStatusHistory} h
      WHERE h.request_id = ${mechRequests.id} AND h.to_status = 'cancelled'
      ORDER BY h.changed_at DESC
      LIMIT 1
    ) END`.as('mech_cancel_reason'),
  lessorId: mechRequests.lessorId,
  lessorName: counterparties.name,
  lessorType: mechRequests.lessorType,
  rate: mechRequests.rate,
  rateUnit: mechRequests.rateUnit,
  actualFrom: mechRequests.actualFrom,
  actualTo: mechRequests.actualTo,
  actualUnits: mechRequests.actualUnits,
  finalCost: mechRequests.finalCost,
  version: mechRequests.version,
  createdBy: mechRequests.createdBy,
  createdByName: users.fullName,
  createdAt: mechRequests.createdAt,
  updatedAt: mechRequests.updatedAt,
  deletedAt: mechRequests.deletedAt,
  deletedByName: deleters.fullName,
  // The current extension request, one row per request by its primary key — so the outer join
  // never multiplies rows of the list. Empty columns mean "never asked through the visa".
  extensionStatus: mechRequestExtensions.status,
  extensionNewPlannedTo: mechRequestExtensions.newPlannedTo,
  extensionPreviousPlannedTo: mechRequestExtensions.previousPlannedTo,
  extensionReason: mechRequestExtensions.reason,
  extensionRequestedBy: mechRequestExtensions.requestedBy,
  extensionRequestedByName: extensionRequesters.fullName,
  extensionRequestedAt: mechRequestExtensions.requestedAt,
  extensionDecidedBy: mechRequestExtensions.decidedBy,
  extensionDecidedByName: extensionDeciders.fullName,
  extensionDecidedAt: mechRequestExtensions.decidedAt,
  extensionDecisionComment: mechRequestExtensions.decisionComment,
  lessorReceiptRequired: mechRequests.lessorReceiptRequired,
  lessorReceiptId: currentLessorReceipts.id,
  lessorReceiptVersionNo: currentLessorReceipts.versionNo,
  lessorReceiptStatus: currentLessorReceipts.status,
  lessorReceiptFileId: currentLessorReceipts.fileId,
  lessorReceiptFileName: currentLessorReceiptFiles.filename,
  lessorReceiptFileContentType: currentLessorReceiptFiles.contentType,
  lessorReceiptFileSize: currentLessorReceiptFiles.size,
  lessorReceiptFileQuarantinedAt: currentLessorReceiptFiles.quarantinedAt,
  lessorReceiptCreatedBy: currentLessorReceipts.createdBy,
  lessorReceiptCreatedByName: lessorReceiptCreators.fullName,
  lessorReceiptCreatedAs: currentLessorReceipts.createdAs,
  lessorReceiptCreatedAt: currentLessorReceipts.createdAt,
  lessorReceiptDecidedBy: currentLessorReceipts.decidedBy,
  lessorReceiptDecidedByName: lessorReceiptDeciders.fullName,
  lessorReceiptDecidedAt: currentLessorReceipts.decidedAt,
  lessorReceiptDecisionComment: currentLessorReceipts.decisionComment,
  // From the grouped subquery joined below, not a correlated subquery here: see
  // `mechLessorReceiptVersionCounts` for why. No row in it means no versions.
  lessorReceiptVersionCount: sql<number>`coalesce(${mechLessorReceiptVersionCounts.versionCount}, 0)`,
};

/**
 * Площадка присоединяется внутренним соединением — она есть у каждой заявки и является осью области
 * (Р17). Отдел, арендодатель и модель — внешним: первого нет у заявки самой площадки, второго нет,
 * пока не договорились, а третьей нет у заявки старше Э2, чьё написание в справочнике не нашлось
 * (ADR 0156). Внешнее соединение с моделью после уборки Э3 не послабление, а единственный
 * работающий вариант: заказчик выбрал снять написания, и заявка без модели теперь законна навсегда
 * — внутреннее соединение потеряло бы её из списка молча, вместе с деньгами, которые по ней шли.
 */
export function mechBaseQuery(reader: MechReader = db) {
  return reader
    .select(requestSelect)
    .from(mechRequests)
    .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
    .leftJoin(departments, eq(mechRequests.departmentId, departments.id))
    .leftJoin(counterparties, eq(mechRequests.lessorId, counterparties.id))
    .leftJoin(mechModels, eq(mechRequests.mechModelId, mechModels.id))
    .leftJoin(deleters, eq(mechRequests.deletedBy, deleters.id))
    .leftJoin(approvers, eq(mechRequests.approvedBy, approvers.id))
    .leftJoin(mechRequestExtensions, eq(mechRequestExtensions.requestId, mechRequests.id))
    .leftJoin(extensionRequesters, eq(mechRequestExtensions.requestedBy, extensionRequesters.id))
    .leftJoin(extensionDeciders, eq(mechRequestExtensions.decidedBy, extensionDeciders.id))
    .leftJoin(
      currentLessorReceipts,
      and(
        eq(currentLessorReceipts.requestId, mechRequests.id),
        isNull(currentLessorReceipts.retiredAt),
      ),
    )
    .leftJoin(
      currentLessorReceiptFiles,
      eq(currentLessorReceipts.fileId, currentLessorReceiptFiles.id),
    )
    .leftJoin(lessorReceiptCreators, eq(currentLessorReceipts.createdBy, lessorReceiptCreators.id))
    .leftJoin(lessorReceiptDeciders, eq(currentLessorReceipts.decidedBy, lessorReceiptDeciders.id))
    .leftJoin(
      mechLessorReceiptVersionCounts,
      eq(mechLessorReceiptVersionCounts.requestId, mechRequests.id),
    )
    .innerJoin(users, eq(mechRequests.createdBy, users.id));
}

export type MechRequestRow = Awaited<ReturnType<typeof mechBaseQuery>>[number];

/** Живые вложения заявок пачкой: страница списка спрашивает их одним запросом, а не по строке. */
export async function mechFilesByRequestIds(
  reader: MechReader,
  ids: string[],
): Promise<Map<string, FileDto[]>> {
  const map = new Map<string, FileDto[]>();
  if (ids.length === 0) return map;
  const rows = await reader
    .select({
      requestId: mechRequestFiles.requestId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
      // Карантин читается вместе с именем: имя скрытого документа наружу не уходит, и решает это
      // общее правило (`fileView`), а не этот сборщик (Р6, п. 4).
      quarantinedAt: files.quarantinedAt,
    })
    .from(mechRequestFiles)
    .innerJoin(files, eq(mechRequestFiles.fileId, files.id))
    .where(and(inArray(mechRequestFiles.requestId, ids), eq(files.status, 'active')));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push(fileView(row));
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * The extension half of the row, or `null` when there is none. Asked by the status column: it is
 * `NOT NULL` in the table, so an empty one means the outer join found no row.
 */
function extensionOf(r: MechRequestRow): MechRequestExtensionDto | null {
  if (!r.extensionStatus) return null;
  return {
    status: r.extensionStatus,
    newPlannedTo: r.extensionNewPlannedTo!,
    previousPlannedTo: r.extensionPreviousPlannedTo!,
    reason: r.extensionReason!,
    requestedBy: r.extensionRequestedBy!,
    // `RESTRICT` on the author keeps the account; the fallback is only the shape of the type.
    requestedByName: r.extensionRequestedByName ?? '—',
    requestedAt: r.extensionRequestedAt!.toISOString(),
    decidedBy: r.extensionDecidedBy,
    decidedByName: r.extensionDecidedByName,
    decidedAt: r.extensionDecidedAt ? r.extensionDecidedAt.toISOString() : null,
    decisionComment: r.extensionDecisionComment ?? '',
  };
}

/**
 * The current lessor receipt version from the joined columns, through the same mapper the card's
 * versions go through (`toMechLessorReceiptVersionDto`), so a list row and the card cannot describe
 * one version differently. Asked by the id: it is the primary key, so empty means no current row.
 */
function currentLessorReceiptOf(r: MechRequestRow): MechLessorReceiptVersionDto | null {
  if (!r.lessorReceiptId) return null;
  return toMechLessorReceiptVersionDto({
    id: r.lessorReceiptId,
    versionNo: r.lessorReceiptVersionNo!,
    status: r.lessorReceiptStatus!,
    file: mechLessorReceiptFileOf({
      fileId: r.lessorReceiptFileId,
      fileName: r.lessorReceiptFileName,
      fileContentType: r.lessorReceiptFileContentType,
      fileSize: r.lessorReceiptFileSize,
      fileQuarantinedAt: r.lessorReceiptFileQuarantinedAt,
    }),
    createdBy: r.lessorReceiptCreatedBy!,
    createdByName: r.lessorReceiptCreatedByName,
    createdAs: r.lessorReceiptCreatedAs!,
    createdAt: r.lessorReceiptCreatedAt!,
    decidedBy: r.lessorReceiptDecidedBy,
    decidedByName: r.lessorReceiptDecidedByName,
    decidedAt: r.lessorReceiptDecidedAt,
    decisionComment: r.lessorReceiptDecisionComment ?? '',
    retiredAt: null,
    retiredByName: null,
    retiredReason: null,
  });
}

/**
 * `lessorReceiptRetired` — the retired versions, newest first, which only the card loads; list
 * rows pass nothing and carry `null` (see `MechRequestDto.lessorReceiptRetired`).
 */
export function toMechRequestDto(
  r: MechRequestRow,
  requestFiles: FileDto[],
  lessorReceiptRetired: MechLessorReceiptVersionDto[] | null = null,
): MechRequestDto {
  return {
    id: r.id,
    num: r.num,
    displayNumber: formatMechRequestNumber(r.num),
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    objectAddress: r.objectAddress,
    departmentId: r.departmentId,
    departmentCode: r.departmentCode,
    departmentName: r.departmentName,
    mechModelId: r.mechModelId,
    mechModelName: r.mechModelName,
    plannedFrom: r.plannedFrom,
    plannedTo: r.plannedTo,
    responsibleName: r.responsibleName,
    responsiblePhone: r.responsiblePhone,
    comment: r.comment,
    status: r.status,
    approvedBy: r.approvedBy,
    approvedByName: r.approvedByName,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    // Пустой комментарий отмены читается как «причина не указана».
    cancelReason: r.cancelReason || null,
    lessorId: r.lessorId,
    lessorName: r.lessorName,
    lessorType: r.lessorType,
    rate: toNum(r.rate),
    rateUnit: r.rateUnit,
    actualFrom: r.actualFrom,
    actualTo: r.actualTo,
    actualUnits: toNum(r.actualUnits),
    finalCost: toNum(r.finalCost),
    files: requestFiles,
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    deletedByName: r.deletedByName,
    extension: extensionOf(r),
    lessorReceiptRequired: r.lessorReceiptRequired,
    lessorReceipt: currentLessorReceiptOf(r),
    lessorReceiptVersionCount: Number(r.lessorReceiptVersionCount),
    lessorReceiptRetired,
  };
}

/**
 * One request's card, with its retired lessor receipt versions (newest first). Deletion is not
 * filtered: the caller decides about the archive (ADR 0070).
 */
export async function loadMechRequestDto(
  reader: MechReader,
  id: string,
): Promise<MechRequestDto | null> {
  const [row] = await mechBaseQuery(reader).where(eq(mechRequests.id, id));
  if (!row) return null;
  const filesMap = await mechFilesByRequestIds(reader, [id]);
  const retired = (await loadMechLessorReceipts(reader, id))
    .filter((version) => version.retiredAt !== null)
    .reverse()
    .map(toMechLessorReceiptVersionDto);
  return toMechRequestDto(row, filesMap.get(id) ?? [], retired);
}
