import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type FileDto, formatMechRequestNumber, type MechRequestDto } from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  files,
  mechRequestFiles,
  mechRequestStatusHistory,
  mechRequests,
  users,
} from '../db/schema';

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
  kindName: mechRequests.kindName,
  plannedFrom: mechRequests.plannedFrom,
  plannedTo: mechRequests.plannedTo,
  responsibleName: mechRequests.responsibleName,
  responsiblePhone: mechRequests.responsiblePhone,
  comment: mechRequests.comment,
  status: mechRequests.status,
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
};

/**
 * Площадка присоединяется внутренним соединением — она есть у каждой заявки и является осью области
 * (Р17). Отдел и арендодатель — внешним: первого нет у заявки самой площадки, второго нет, пока не
 * договорились.
 */
export function mechBaseQuery(reader: MechReader = db) {
  return reader
    .select(requestSelect)
    .from(mechRequests)
    .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
    .leftJoin(departments, eq(mechRequests.departmentId, departments.id))
    .leftJoin(counterparties, eq(mechRequests.lessorId, counterparties.id))
    .leftJoin(deleters, eq(mechRequests.deletedBy, deleters.id))
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
    })
    .from(mechRequestFiles)
    .innerJoin(files, eq(mechRequestFiles.fileId, files.id))
    .where(and(inArray(mechRequestFiles.requestId, ids), eq(files.status, 'active')));
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

export function toMechRequestDto(r: MechRequestRow, requestFiles: FileDto[]): MechRequestDto {
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
    kindName: r.kindName,
    plannedFrom: r.plannedFrom,
    plannedTo: r.plannedTo,
    responsibleName: r.responsibleName,
    responsiblePhone: r.responsiblePhone,
    comment: r.comment,
    status: r.status,
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
  };
}

/** Карточка одной заявки. Удалённость не фильтруется: её разбирает вызывающий (архив, ADR 0070). */
export async function loadMechRequestDto(
  reader: MechReader,
  id: string,
): Promise<MechRequestDto | null> {
  const [row] = await mechBaseQuery(reader).where(eq(mechRequests.id, id));
  if (!row) return null;
  const filesMap = await mechFilesByRequestIds(reader, [id]);
  return toMechRequestDto(row, filesMap.get(id) ?? []);
}
