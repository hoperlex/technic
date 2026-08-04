import { and, type AnyColumn, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import {
  buildVehicleCategoryName,
  formatSpecValue,
  type VehicleCategoryValueDto,
  type VehicleCategoryValueInput,
  type VehicleTypeSpecDto,
} from '@technic/contracts';
// Только для вывода типа транзакции: связь с пулом не нужна, чистые проверки должны быть
// импортируемы без поднятой БД.
import type { db } from '../db/client';
import {
  vehicleCategories,
  vehicleCategorySpecValues,
  vehicleSpecs,
  vehicleTypeSpecs,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';

// Категории типа ТС (ADR 0016). Правила живут здесь, а не в маршрутах: один и тот же набор
// инвариантов нужен и при заведении категории, и при смене состава ТТХ у типа — сложись он
// в двух местах, они бы разошлись.
//
// Канонизацию набора значений приложение НЕ дублирует: сигнатуру всегда считает SQL-функция
// vehicle_category_signature (приём из ADR 0007 §2). Иначе смысл уникального индекса
// «одна комбинация значений = одна категория» разошёлся бы с кодом.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающее соединение: подходит и пул, и транзакция. */
type Reader = Pick<Tx, 'select' | 'execute'>;

/**
 * Блокировка строки типа сериализует все правки его ТТХ и категорий: состав характеристик и
 * кортежи значений — один инвариант, менять их параллельно нельзя (идиома ADR 0003 §8).
 */
export async function lockType(
  tx: Tx,
  typeId: string,
): Promise<{ id: string; name: string; isActive: boolean }> {
  const [type] = await tx
    .select({ id: vehicleTypes.id, name: vehicleTypes.name, isActive: vehicleTypes.isActive })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, typeId))
    .for('update');
  if (!type) throw err.notFound('Тип ТС не найден');
  return type;
}

export async function loadTypeSpecs(
  conn: Reader,
  typeId: string,
): Promise<(VehicleTypeSpecDto & { specId: string })[]> {
  const rows = await conn
    .select({
      specId: vehicleSpecs.id,
      code: vehicleSpecs.code,
      name: vehicleSpecs.name,
      shortName: vehicleSpecs.shortName,
      unit: vehicleSpecs.unit,
      decimals: vehicleSpecs.decimals,
      minValue: vehicleSpecs.minValue,
      maxValue: vehicleSpecs.maxValue,
      sortOrder: vehicleTypeSpecs.sortOrder,
      isActive: vehicleSpecs.isActive,
    })
    .from(vehicleTypeSpecs)
    .innerJoin(vehicleSpecs, eq(vehicleTypeSpecs.specId, vehicleSpecs.id))
    .where(eq(vehicleTypeSpecs.vehicleTypeId, typeId))
    .orderBy(asc(vehicleTypeSpecs.sortOrder), asc(vehicleSpecs.name));

  return rows.map((r) => ({
    specId: r.specId,
    code: r.code,
    name: r.name,
    shortName: r.shortName,
    unit: r.unit,
    decimals: Number(r.decimals),
    minValue: r.minValue == null ? null : Number(r.minValue),
    maxValue: r.maxValue == null ? null : Number(r.maxValue),
    sortOrder: r.sortOrder,
    isActive: r.isActive,
  }));
}

/** Значение вписывается в справочные ограничения ТТХ: масштаб и границы. */
export function assertValueFitsSpec(
  value: number,
  spec: Pick<VehicleTypeSpecDto, 'name' | 'unit' | 'decimals' | 'minValue' | 'maxValue'>,
): void {
  if (Number(value.toFixed(spec.decimals)) !== value) {
    throw err.unprocessable(
      `«${spec.name}»: знаков после запятой допустимо ${spec.decimals}, получено больше`,
    );
  }
  if (spec.minValue != null && value < spec.minValue) {
    throw err.unprocessable(
      `«${spec.name}»: значение меньше минимума ${formatSpecValue(spec.minValue, spec)}`,
    );
  }
  if (spec.maxValue != null && value > spec.maxValue) {
    throw err.unprocessable(
      `«${spec.name}»: значение больше максимума ${formatSpecValue(spec.maxValue, spec)}`,
    );
  }
}

/**
 * Набор значений покрывает РОВНО все ТТХ типа. Полнота — единственный инвариант, который нельзя
 * выразить ключом (лишние и чужие значения запрещает составной FK), поэтому проверяется здесь;
 * отложенный триггер в БД перепроверяет то же самое на COMMIT.
 */
export function checkedValues(
  values: readonly VehicleCategoryValueInput[],
  specs: readonly (VehicleTypeSpecDto & { specId: string })[],
): Map<string, number> {
  if (specs.length === 0) {
    throw err.unprocessable(
      'У типа не задано ни одного ТТХ: категории появляются после добавления характеристик',
    );
  }
  const bySpec = new Map(values.map((v) => [v.specId, v.value]));
  const missing = specs.filter((s) => !bySpec.has(s.specId));
  if (missing.length > 0) {
    throw err.unprocessable(`Не заданы значения ТТХ: ${missing.map((s) => s.name).join(', ')}`);
  }
  const known = new Set(specs.map((s) => s.specId));
  if (values.some((v) => !known.has(v.specId))) {
    throw err.unprocessable('Передано значение по ТТХ, не привязанному к этому типу');
  }
  for (const s of specs) assertValueFitsSpec(bySpec.get(s.specId)!, s);
  return bySpec;
}

/** Значения категории в виде DTO — из уже проверенного набора, без повторного чтения из БД. */
export function valueDtos(
  specs: readonly (VehicleTypeSpecDto & { specId: string })[],
  values: Map<string, number>,
): VehicleCategoryValueDto[] {
  return specs.map((s) => ({
    specId: s.specId,
    code: s.code,
    name: s.name,
    shortName: s.shortName,
    unit: s.unit,
    decimals: s.decimals,
    sortOrder: s.sortOrder,
    value: values.get(s.specId)!,
  }));
}

/** Значение для колонки numeric(14,4): масштаб берётся из справочника ТТХ. */
export function valueToColumn(value: number, spec: { decimals: number }): string {
  return value.toFixed(spec.decimals);
}

/** Сигнатуру считает БД — той же функцией, что стоит за уникальным индексом. */
export async function signatureOf(
  conn: Reader,
  specs: readonly (VehicleTypeSpecDto & { specId: string })[],
  values: Map<string, number>,
): Promise<string> {
  const payload: Record<string, string> = {};
  for (const s of specs) payload[s.code] = valueToColumn(values.get(s.specId)!, s);
  const res = await conn.execute<{ sig: string }>(
    sql`SELECT vehicle_category_signature(${JSON.stringify(payload)}::jsonb) AS sig`,
  );
  return res.rows[0]!.sig;
}

export async function assertSignatureFree(
  conn: Reader,
  typeId: string,
  signature: string,
  excludeId?: string,
): Promise<void> {
  const rows = await conn
    .select({ id: vehicleCategories.id, name: vehicleCategories.name })
    .from(vehicleCategories)
    .where(
      and(
        eq(vehicleCategories.vehicleTypeId, typeId),
        eq(vehicleCategories.specSignature, signature),
      ),
    );
  const clash = rows.find((r) => r.id !== excludeId);
  if (clash) {
    throw err.conflict(`Категория с таким набором значений уже есть: «${clash.name}»`);
  }
}

/**
 * Уникальность наименования внутри типа держит сервис, а не индекс (ADR 0016 §11): имя производно
 * и массово перезаписывается при смене состава ТТХ.
 */
export async function assertNameFree(
  conn: Reader,
  typeId: string,
  name: string,
  excludeId?: string,
): Promise<void> {
  const rows = await conn
    .select({ id: vehicleCategories.id })
    .from(vehicleCategories)
    .where(
      and(
        eq(vehicleCategories.vehicleTypeId, typeId),
        sql`lower(btrim(${vehicleCategories.name})) = lower(btrim(${name}))`,
      ),
    );
  if (rows.some((r) => r.id !== excludeId)) {
    throw err.conflict(`Категория с наименованием «${name}» уже есть у этого типа`);
  }
}

export async function valuesByCategoryIds(
  conn: Reader,
  categoryIds: string[],
): Promise<Map<string, VehicleCategoryValueDto[]>> {
  const map = new Map<string, VehicleCategoryValueDto[]>();
  if (categoryIds.length === 0) return map;
  const rows = await conn
    .select({
      categoryId: vehicleCategorySpecValues.categoryId,
      specId: vehicleSpecs.id,
      code: vehicleSpecs.code,
      name: vehicleSpecs.name,
      shortName: vehicleSpecs.shortName,
      unit: vehicleSpecs.unit,
      decimals: vehicleSpecs.decimals,
      sortOrder: vehicleTypeSpecs.sortOrder,
      value: vehicleCategorySpecValues.valueNum,
    })
    .from(vehicleCategorySpecValues)
    .innerJoin(vehicleSpecs, eq(vehicleCategorySpecValues.specId, vehicleSpecs.id))
    .innerJoin(
      vehicleTypeSpecs,
      and(
        eq(vehicleTypeSpecs.vehicleTypeId, vehicleCategorySpecValues.vehicleTypeId),
        eq(vehicleTypeSpecs.specId, vehicleCategorySpecValues.specId),
      ),
    )
    .where(inArray(vehicleCategorySpecValues.categoryId, categoryIds))
    .orderBy(asc(vehicleTypeSpecs.sortOrder), asc(vehicleSpecs.name));

  for (const r of rows) {
    const list = map.get(r.categoryId) ?? [];
    list.push({
      specId: r.specId,
      code: r.code,
      name: r.name,
      shortName: r.shortName,
      unit: r.unit,
      decimals: Number(r.decimals),
      sortOrder: r.sortOrder,
      value: Number(r.value),
    });
    map.set(r.categoryId, list);
  }
  return map;
}

/**
 * Значения ТТХ категории одним объектом — `{ "lift_capacity": 25 }` — подзапросом к колонке с
 * идентификатором категории (ADR 0059).
 *
 * Ими портал считает «крупнее или меньше заказанного» (`compareVehicleSize`): сравнение — правило
 * контрактов, и данные для него обязаны приезжать вместе со строкой, которую человек читает. Здесь
 * подзапросом, а не пачкой (`valuesByCategoryIds`), потому что спрашивают его три разные выборки —
 * заявки, техника, рейсы, — и в каждой это одна колонка к уже собранному запросу.
 *
 * `NULL` — у категории нет значений (у типа нет ТТХ) либо категория не проставлена вовсе. Числа
 * приезжают числами: `numeric` внутри `jsonb` остаётся JSON-числом.
 */
export function categorySpecsSql(categoryIdColumn: AnyColumn | SQL): SQL<SpecValuesRow | null> {
  return sql<SpecValuesRow | null>`(
    SELECT jsonb_object_agg(${vehicleSpecs.code}, ${vehicleCategorySpecValues.valueNum})
    FROM ${vehicleCategorySpecValues}
    JOIN ${vehicleSpecs} ON ${vehicleSpecs.id} = ${vehicleCategorySpecValues.specId}
    WHERE ${vehicleCategorySpecValues.categoryId} = ${categoryIdColumn}
  )`;
}

/** Что отдаёт `categorySpecsSql`: тот же тип, что ждут контракты (`VehicleSpecValues`). */
type SpecValuesRow = Record<string, number>;

/**
 * Пересчёт сигнатур и авто-имён всех категорий типа — после смены состава ТТХ. Сигнатуры считает
 * один UPDATE той же SQL-функцией; наименования собирает приложение (формат общий с интерфейсом).
 */
export async function refreshTypeCategories(
  tx: Tx,
  typeId: string,
  typeName: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE vehicle_categories c
    SET spec_signature = agg.sig, updated_at = now()
    FROM (
      SELECT v.category_id AS category_id,
             vehicle_category_signature(jsonb_object_agg(s.code, v.value_num)) AS sig
      FROM vehicle_category_spec_values v
      JOIN vehicle_specs s ON s.id = v.spec_id
      WHERE v.vehicle_type_id = ${typeId}
      GROUP BY v.category_id
    ) agg
    WHERE c.id = agg.category_id AND c.spec_signature IS DISTINCT FROM agg.sig
  `);

  const auto = await tx
    .select({ id: vehicleCategories.id, name: vehicleCategories.name })
    .from(vehicleCategories)
    .where(
      and(eq(vehicleCategories.vehicleTypeId, typeId), eq(vehicleCategories.isAutoName, true)),
    );
  if (auto.length === 0) return;

  const values = await valuesByCategoryIds(
    tx,
    auto.map((c) => c.id),
  );
  for (const c of auto) {
    const name = buildVehicleCategoryName(typeName, values.get(c.id) ?? []);
    if (name === c.name) continue;
    await tx
      .update(vehicleCategories)
      .set({ name, updatedAt: new Date() })
      .where(eq(vehicleCategories.id, c.id));
  }
}

/**
 * Сигнатуры, которые получились бы у категорий типа БЕЗ указанного ТТХ. Нужны до отвязки:
 * выброшенная координата может схлопнуть две категории в одинаковый кортеж, и такую отвязку
 * нужно остановить до потери данных, а не ловить уникальным индексом после.
 */
export async function signaturesWithoutSpec(
  tx: Tx,
  typeId: string,
  specId: string,
): Promise<Map<string, string>> {
  const res = await tx.execute<{ category_id: string; sig: string }>(sql`
    SELECT v.category_id AS category_id,
           vehicle_category_signature(jsonb_object_agg(s.code, v.value_num)) AS sig
    FROM vehicle_category_spec_values v
    JOIN vehicle_specs s ON s.id = v.spec_id
    WHERE v.vehicle_type_id = ${typeId} AND v.spec_id <> ${specId}
    GROUP BY v.category_id
  `);
  return new Map(res.rows.map((r) => [r.category_id, r.sig]));
}
