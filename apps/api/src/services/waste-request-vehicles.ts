import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { WasteRequestVehicleDto, WasteRequestVehicleInput } from '@technic/contracts';
import { MAX_VEHICLE_ROWS_PER_REQUEST, type WasteVehicleCountInput } from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, wasteRequestVehicles } from '../db/schema';
import { err } from '../lib/errors';
import { resolveWasteTariff } from './waste-pricing';

// Чем вывезли заявку (ADR 0011, ADR 0024). Строка — «тип техники × количество», а не рейс:
// талоны к машинам не крепятся, они общий пул заявки. Пометка на удаление отделена от удаления:
// первая доступна всем, кто правит заявку, второе — только администратору (проверяет роут).

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** numeric приходит из драйвера строкой — в DTO объём и суммы всегда числа. */
const toNum = (v: string | null): number | null => (v == null ? null : Number(v));

/**
 * Машины заявок пачкой (паттерн filesByRequestIds). Помеченные на удаление возвращаются тоже:
 * в интерфейсе они видны неактивными, а из сверки объёма и суммы их убирает `isDeleted`.
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

/** Строки, участвующие в сверке объёма (помеченные на удаление не в счёт). */
export async function countActiveVehicles(tx: Tx, requestId: string): Promise<number> {
  const [row] = await tx
    .select({ c: count() })
    .from(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), isNull(wasteRequestVehicles.deletedAt)),
    );
  return Number(row!.c);
}

/** Типы, уже заведённые у заявки активной строкой: второй строки на тот же тип не бывает. */
async function activeTypeIds(tx: Tx, requestId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ containerTypeId: wasteRequestVehicles.containerTypeId })
    .from(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), isNull(wasteRequestVehicles.deletedAt)),
    );
  return new Set(rows.map((r) => r.containerTypeId));
}

/**
 * Заводит строки факта: тип техники, количество, снимок вместимости и цены.
 *
 * Объём не приходит с клиента — он равен вместимости типа × количество и сохраняется снимком:
 * вместимость типа потом могут уточнить в справочнике, а закрытые заявки должны остаться с теми
 * цифрами, по которым их принимали. Тем же снимком берётся цена по прайсу (ADR 0024): сумма
 * закрытой заявки считается по машинам, и правка прайса её не переписывает.
 *
 * `pricing` — чем и для кого считать цену: тип мусора заявки и её оператор (прайс у каждого
 * оператора свой, ADR 0026). Тип мусора у заявки на вывоз есть всегда (ADR 0019); null
 * остаётся только у заявок, заведённых до тарификации — они закрываются без снимка цены.
 */
export async function insertVehicles(
  tx: Tx,
  requestId: string,
  inputs: WasteRequestVehicleInput[],
  actorId: string,
  pricing: { wasteTypeId: string | null; operatorCounterpartyId: string | null },
): Promise<void> {
  if (inputs.length === 0) return;
  const existing = await tx
    .select({ c: count() })
    .from(wasteRequestVehicles)
    .where(eq(wasteRequestVehicles.requestId, requestId));
  if (Number(existing[0]!.c) + inputs.length > MAX_VEHICLE_ROWS_PER_REQUEST) {
    throw err.badRequest(`Не более ${MAX_VEHICLE_ROWS_PER_REQUEST} строк машин на заявку`);
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
  const typeById = new Map(types.map((t) => [t.id, t]));
  const alreadyThere = await activeTypeIds(tx, requestId);

  for (const input of inputs) {
    const type = typeById.get(input.containerTypeId)!;
    // Вывозят и самосвалами, и контейнерами (ADR 0024) — вид техники строку не ограничивает,
    // но вместимость нужна: из неё считается и объём, и сумма.
    if (type.volumeM3 == null || type.volumeM3 <= 0) {
      throw err.badRequest(
        `У типа «${type.name}» не задана вместимость — укажите её в справочнике`,
        { vehicles: 'У выбранного типа нет вместимости' },
      );
    }
    if (alreadyThere.has(input.containerTypeId)) {
      throw err.badRequest(`«${type.name}» уже указан — измените количество в этой строке`, {
        vehicles: 'Тип уже есть в заявке',
      });
    }
    alreadyThere.add(input.containerTypeId);

    // Цена — по прайсу для пары «тип мусора × этот тип техники» и оператора заявки (ADR 0026).
    // Тарифа нет — закрывать нечем: сумма по факту оказалась бы неполной, а неполная сумма
    // выглядит как полная.
    const tariff = pricing.wasteTypeId
      ? await resolveWasteTariff(
          pricing.wasteTypeId,
          input.containerTypeId,
          pricing.operatorCounterpartyId,
        )
      : null;
    if (pricing.wasteTypeId && !tariff) {
      throw err.unprocessable(`Для «${type.name}» цена в прайсе не задана`, {
        vehicles: `Нет цены для «${type.name}»`,
      });
    }

    await tx.insert(wasteRequestVehicles).values({
      requestId,
      containerTypeId: input.containerTypeId,
      volumeM3: String(type.volumeM3),
      count: input.count,
      wasteTariffId: tariff?.tariffId ?? null,
      pricePerM3: tariff ? String(tariff.pricePerM3) : null,
      createdBy: actorId,
    });
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

/**
 * Правка количества у заведённых строк (ADR 0024): «приехал ещё один такой же самосвал» — это
 * +1 к строке, а не вторая строка того же типа. Цена и вместимость остаются снимком, поэтому
 * сумма строки пересчитывается сама (GENERATED-колонка).
 */
export async function updateVehicleCounts(
  tx: Tx,
  requestId: string,
  entries: readonly WasteVehicleCountInput[],
): Promise<void> {
  if (entries.length === 0) return;
  const ids = entries.map((e) => e.vehicleId);
  await assertVehiclesOfRequest(tx, requestId, ids);
  const rows = await tx
    .select({ id: wasteRequestVehicles.id, deletedAt: wasteRequestVehicles.deletedAt })
    .from(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
  // Помеченная на удаление строка в факте не участвует — количество на ней ушло бы мимо расчёта.
  if (rows.some((r) => r.deletedAt != null)) {
    throw err.badRequest('Машина помечена на удаление — количество у неё не меняется', {
      vehicleCounts: 'Верните машину в заявку',
    });
  }
  for (const entry of entries) {
    await tx
      .update(wasteRequestVehicles)
      .set({ count: entry.count, updatedAt: new Date() })
      .where(eq(wasteRequestVehicles.id, entry.vehicleId));
  }
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

/**
 * Снятие пометки — обратная операция, доступна тем же ролям. Возврат строки на тип, который за
 * это время завели заново, оставил бы у заявки два места с одним типом: расчёт по прайсу
 * сложил бы их как разные машины.
 */
export async function restoreVehicles(tx: Tx, requestId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await assertVehiclesOfRequest(tx, requestId, ids);
  const restoring = await tx
    .select({
      id: wasteRequestVehicles.id,
      containerTypeId: wasteRequestVehicles.containerTypeId,
      name: containerTypes.name,
    })
    .from(wasteRequestVehicles)
    .innerJoin(containerTypes, eq(wasteRequestVehicles.containerTypeId, containerTypes.id))
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
  const active = await activeTypeIds(tx, requestId);
  const clash = restoring.find((r) => active.has(r.containerTypeId));
  if (clash) {
    throw err.badRequest(`«${clash.name}» уже есть в заявке — измените количество в этой строке`, {
      restoreVehicleIds: 'Тип уже есть в заявке',
    });
  }
  await tx
    .update(wasteRequestVehicles)
    .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
}

/** Полное удаление строки (только администратор). Талоны на ней не висят — они у заявки. */
export async function hardDeleteVehicles(tx: Tx, requestId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await assertVehiclesOfRequest(tx, requestId, ids);
  await tx
    .delete(wasteRequestVehicles)
    .where(
      and(eq(wasteRequestVehicles.requestId, requestId), inArray(wasteRequestVehicles.id, ids)),
    );
}
