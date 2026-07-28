import { and, count, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type {
  FileDto,
  WasteRequestVehicleDto,
  WasteRequestVehicleInput,
  WasteVehicleTicketsInput,
} from '@technic/contracts';
import { MAX_TICKETS_PER_VEHICLE, MAX_VEHICLES_PER_REQUEST } from '@technic/contracts';
import { db } from '../db/client';
import {
  containerTypes,
  files,
  wasteRequestVehicleFiles,
  wasteRequestVehicles,
} from '../db/schema';
import { err } from '../lib/errors';
import { assertFilesAttachable, markFilesActive, scheduleFilesDeletion } from './request-files';

// Машины и талоны заявки на вывоз (ADR 0011). Пометка на удаление отделена от удаления:
// первая доступна всем, кто правит заявку, второе — только администратору (проверяет роут).

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** numeric приходит из драйвера строкой — в DTO объём всегда число. */
const toVolume = (v: string): number => Number(v);

async function filesByVehicleIds(ids: string[]): Promise<Map<string, FileDto[]>> {
  const map = new Map<string, FileDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      vehicleId: wasteRequestVehicleFiles.vehicleId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(wasteRequestVehicleFiles)
    .innerJoin(files, eq(wasteRequestVehicleFiles.fileId, files.id))
    .where(and(inArray(wasteRequestVehicleFiles.vehicleId, ids), eq(files.status, 'active')));
  for (const row of rows) {
    const list = map.get(row.vehicleId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.vehicleId, list);
  }
  return map;
}

/**
 * Машины заявок пачкой (паттерн filesByRequestIds). Помеченные на удаление возвращаются тоже:
 * в интерфейсе они видны неактивными, а из сверки объёма их убирает `isDeleted`.
 */
export async function vehiclesByRequestIds(
  ids: string[],
): Promise<Map<string, WasteRequestVehicleDto[]>> {
  const map = new Map<string, WasteRequestVehicleDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: wasteRequestVehicles.id,
      requestId: wasteRequestVehicles.requestId,
      containerTypeId: wasteRequestVehicles.containerTypeId,
      containerTypeName: containerTypes.name,
      volumeM3: wasteRequestVehicles.volumeM3,
      deletedAt: wasteRequestVehicles.deletedAt,
      createdAt: wasteRequestVehicles.createdAt,
    })
    .from(wasteRequestVehicles)
    .innerJoin(containerTypes, eq(wasteRequestVehicles.containerTypeId, containerTypes.id))
    .where(inArray(wasteRequestVehicles.requestId, ids))
    .orderBy(wasteRequestVehicles.createdAt);
  const filesMap = await filesByVehicleIds(rows.map((r) => r.id));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      containerTypeId: row.containerTypeId,
      containerTypeName: row.containerTypeName,
      volumeM3: toVolume(row.volumeM3),
      files: filesMap.get(row.id) ?? [],
      isDeleted: row.deletedAt != null,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.requestId, list);
  }
  return map;
}

/** Количество машин, участвующих в сверке объёма (помеченные на удаление не в счёт). */
export async function countActiveVehicles(tx: Tx, requestId: string): Promise<number> {
  const [row] = await tx
    .select({ c: count() })
    .from(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), isNull(wasteRequestVehicles.deletedAt)),
    );
  return Number(row!.c);
}

/**
 * Заводит машины заявки вместе с талонами. Объём рейса не приходит с клиента: он равен
 * вместимости типа из справочника и сохраняется снимком — вместимость типа потом могут
 * уточнить, а закрытые заявки должны остаться с теми цифрами, по которым их принимали.
 */
export async function insertVehicles(
  tx: Tx,
  requestId: string,
  inputs: WasteRequestVehicleInput[],
  actorId: string,
): Promise<void> {
  if (inputs.length === 0) return;
  const existing = await tx
    .select({ c: count() })
    .from(wasteRequestVehicles)
    .where(eq(wasteRequestVehicles.requestId, requestId));
  if (Number(existing[0]!.c) + inputs.length > MAX_VEHICLES_PER_REQUEST) {
    throw err.badRequest(`Не более ${MAX_VEHICLES_PER_REQUEST} машин на заявку`);
  }

  const typeIds = [...new Set(inputs.map((v) => v.containerTypeId))];
  const types = await tx
    .select({
      id: containerTypes.id,
      name: containerTypes.name,
      kind: containerTypes.type,
      volumeM3: containerTypes.volumeM3,
    })
    .from(containerTypes)
    .where(inArray(containerTypes.id, typeIds));
  if (types.length !== typeIds.length) throw err.badRequest('Тип машины не найден');
  const volumeByType = new Map(types.map((t) => [t.id, t]));

  for (const input of inputs) {
    const type = volumeByType.get(input.containerTypeId)!;
    // Вывоз оформляется самосвалами — контейнерный тип в машине означал бы другую операцию.
    if (type.kind !== 'truck') {
      throw err.badRequest(`«${type.name}» — не самосвал: вывоз выполняется самосвалами`, {
        vehicles: 'Выберите тип вида «Самосвал»',
      });
    }
    if (type.volumeM3 == null || type.volumeM3 <= 0) {
      throw err.badRequest(
        `У типа «${type.name}» не задана вместимость — укажите её в справочнике`,
        { vehicles: 'У выбранного типа нет вместимости' },
      );
    }
    const [row] = await tx
      .insert(wasteRequestVehicles)
      .values({
        requestId,
        containerTypeId: input.containerTypeId,
        volumeM3: String(type.volumeM3),
        createdBy: actorId,
      })
      .returning({ id: wasteRequestVehicles.id });
    if (input.fileIds.length === 0) continue;
    // Талоны проходят те же проверки, что и вложения заявки: свои, живые, ещё не привязанные.
    await assertFilesAttachable(tx, input.fileIds, actorId);
    await tx
      .insert(wasteRequestVehicleFiles)
      .values(input.fileIds.map((fileId) => ({ vehicleId: row!.id, fileId })));
    await markFilesActive(tx, input.fileIds);
  }
}

/**
 * Активные машины, к которым не приложено ни одного живого талона — в порядке заведения.
 * Возвращаются названия типов: ими ошибка объясняет, каких именно рейсов не хватает бумаги.
 * Считается по состоянию заявки, а не по телу запроса: талон мог прийти с прошлым закрытием.
 */
export async function vehiclesMissingTickets(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ name: containerTypes.name })
    .from(wasteRequestVehicles)
    .innerJoin(containerTypes, eq(wasteRequestVehicles.containerTypeId, containerTypes.id))
    .where(
      and(
        eq(wasteRequestVehicles.requestId, requestId),
        isNull(wasteRequestVehicles.deletedAt),
        // Удалённый файл талоном не считается: строка связи живёт до hard-delete машины.
        notExists(
          tx
            .select({ one: sql`1` })
            .from(wasteRequestVehicleFiles)
            .innerJoin(files, eq(wasteRequestVehicleFiles.fileId, files.id))
            .where(
              and(
                eq(wasteRequestVehicleFiles.vehicleId, wasteRequestVehicles.id),
                eq(files.status, 'active'),
              ),
            ),
        ),
      ),
    )
    .orderBy(wasteRequestVehicles.createdAt);
  return rows.map((r) => r.name);
}

/**
 * Догрузка талонов к уже заведённым машинам (ADR 0020). Нужна при повторном закрытии: машины
 * заведены прошлым закрытием, и если талона у них нет, приложить его было бы некуда — заводить
 * рейс заново значило бы терять его место в истории заявки.
 */
export async function attachVehicleTickets(
  tx: Tx,
  requestId: string,
  entries: readonly WasteVehicleTicketsInput[],
  actorId: string,
): Promise<void> {
  if (entries.length === 0) return;
  const ids = entries.map((e) => e.vehicleId);
  const rows = await tx
    .select({ id: wasteRequestVehicles.id, deletedAt: wasteRequestVehicles.deletedAt })
    .from(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
  if (rows.length !== new Set(ids).size) throw err.badRequest('Машина не найдена в этой заявке');
  // Помеченная на удаление машина в сверке не участвует — талон на ней повис бы мимо факта.
  if (rows.some((r) => r.deletedAt != null)) {
    throw err.badRequest('Машина помечена на удаление — талон к ней не прикладывается', {
      vehicleTickets: 'Верните машину в заявку или уберите её талон',
    });
  }
  for (const entry of entries) {
    const [existing] = await tx
      .select({ c: count() })
      .from(wasteRequestVehicleFiles)
      .innerJoin(files, eq(wasteRequestVehicleFiles.fileId, files.id))
      .where(
        and(eq(wasteRequestVehicleFiles.vehicleId, entry.vehicleId), eq(files.status, 'active')),
      );
    if (Number(existing!.c) + entry.fileIds.length > MAX_TICKETS_PER_VEHICLE) {
      throw err.badRequest(`Не более ${MAX_TICKETS_PER_VEHICLE} талонов на машину`);
    }
    // Те же проверки, что и у талонов новой машины: свои, живые, ещё не привязанные.
    await assertFilesAttachable(tx, entry.fileIds, actorId);
    await tx
      .insert(wasteRequestVehicleFiles)
      .values(entry.fileIds.map((fileId) => ({ vehicleId: entry.vehicleId, fileId })));
    await markFilesActive(tx, entry.fileIds);
  }
}

/** Машины заявки по id — с проверкой, что все они принадлежат именно ей. */
async function assertVehiclesOfRequest(tx: Tx, requestId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: wasteRequestVehicles.id })
    .from(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
  if (rows.length !== new Set(ids).size) throw err.badRequest('Машина не найдена в этой заявке');
}

/** Пометка на удаление: строка выпадает из сверки объёма, но остаётся в истории заявки. */
export async function markVehiclesDeleted(
  tx: Tx,
  requestId: string,
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await assertVehiclesOfRequest(tx, requestId, ids);
  await tx
    .update(wasteRequestVehicles)
    .set({ deletedAt: new Date(), deletedBy: actorId, updatedAt: new Date() })
    .where(
      and(
        eq(wasteRequestVehicles.requestId, requestId),
        inArray(wasteRequestVehicles.id, ids),
        isNull(wasteRequestVehicles.deletedAt),
      ),
    );
}

/** Снятие пометки — обратная операция, доступна тем же ролям. */
export async function restoreVehicles(tx: Tx, requestId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await assertVehiclesOfRequest(tx, requestId, ids);
  await tx
    .update(wasteRequestVehicles)
    .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
}

/**
 * Полное удаление (только администратор): строка уходит вместе с талонами. Файлы помечаются
 * удалёнными и вычищаются из S3 отложенно — тем же путём, что и вложения заявки.
 */
export async function hardDeleteVehicles(tx: Tx, requestId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await assertVehiclesOfRequest(tx, requestId, ids);
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(wasteRequestVehicleFiles)
    .innerJoin(files, eq(wasteRequestVehicleFiles.fileId, files.id))
    .where(inArray(wasteRequestVehicleFiles.vehicleId, ids));
  // Связи снимает каскад по vehicle_id; сами файлы каскад не трогает — их гасим явно.
  await tx
    .delete(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
  await scheduleFilesDeletion(tx, linked, false);
}

/** Талоны заявки — под hard-delete самой заявки (файлы удаляются вместе с ней). */
export async function vehicleFilesOfRequest(
  tx: Tx,
  requestId: string,
): Promise<{ id: string; objectKey: string }[]> {
  return tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(wasteRequestVehicleFiles)
    .innerJoin(files, eq(wasteRequestVehicleFiles.fileId, files.id))
    .innerJoin(
      wasteRequestVehicles,
      eq(wasteRequestVehicleFiles.vehicleId, wasteRequestVehicles.id),
    )
    .where(eq(wasteRequestVehicles.requestId, requestId));
}
