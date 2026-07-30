import { eq, inArray } from 'drizzle-orm';
import type { WasteRequestVehicleDto } from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, wasteRequestVehicles } from '../db/schema';

// Состав техники прошлых закрытий (миграции 0029, 0042) — только чтение. С ADR 0035 закрытие
// предъявляет фактический объём и стоимость (waste_request_completions), а не перечень машин:
// вывоз тарифицируется самосвалами (ADR 0022), и какими машинами увезли объём, к расчёту
// отношения не имеет. Новых строк здесь не появляется; заведённые остаются в истории заявки —
// по ним её принимали, а объём с суммой перенесены в факт миграцией 0056.

/** numeric приходит из драйвера строкой — в DTO объём и суммы всегда числа. */
const toNum = (v: string | null): number | null => (v == null ? null : Number(v));

/**
 * Машины заявок пачкой (паттерн filesByRequestIds). Помеченные на удаление возвращаются тоже:
 * в истории они видны зачёркнутыми — снятую машину иначе нечем заметить.
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
      containerKind: containerTypes.type,
      volumeM3: wasteRequestVehicles.volumeM3,
      count: wasteRequestVehicles.count,
      pricePerM3: wasteRequestVehicles.pricePerM3,
      amount: wasteRequestVehicles.amount,
      deletedAt: wasteRequestVehicles.deletedAt,
      createdAt: wasteRequestVehicles.createdAt,
    })
    .from(wasteRequestVehicles)
    .innerJoin(containerTypes, eq(wasteRequestVehicles.containerTypeId, containerTypes.id))
    .where(inArray(wasteRequestVehicles.requestId, ids))
    .orderBy(wasteRequestVehicles.createdAt);
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      containerTypeId: row.containerTypeId,
      containerTypeName: row.containerTypeName,
      containerKind: row.containerKind,
      volumeM3: Number(row.volumeM3),
      count: row.count,
      pricePerM3: toNum(row.pricePerM3),
      amount: toNum(row.amount),
      isDeleted: row.deletedAt != null,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.requestId, list);
  }
  return map;
}
