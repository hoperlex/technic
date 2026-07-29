import type { ContainerKind, WasteTariffDto } from '@technic/contracts';

/**
 * Сборка справочника цен в таблицу «строка = пара „мусор × техника“, столбец = оператор»
 * (ADR 0026). Плоский список позиций прайса читается плохо: одна и та же пара повторяется
 * столько раз, сколько операторов её возят, и сравнить ставки глазами нельзя — а ради сравнения
 * справочник и открывают.
 */

/** Строка сводной таблицы: пара «что вывозим × чем вывозим» и цены операторов на неё. */
export interface WasteTariffGridRow {
  key: string;
  wasteTypeId: string;
  wasteTypeName: string;
  /** Цель тарифа: конкретный тип техники либо вид целиком — ровно одно из двух. */
  containerTypeId: string | null;
  containerTypeName: string | null;
  containerKind: ContainerKind | null;
  /** Позиции прайса этой пары по операторам: id оператора → его цена. */
  byOperator: Record<string, WasteTariffDto>;
}

/** Ключ строки: пара «тип мусора × техника». Он же rowKey таблицы. */
export function wasteTariffRowKey(t: {
  wasteTypeId: string;
  containerTypeId: string | null;
  containerKind: ContainerKind | null;
}): string {
  return `${t.wasteTypeId}::${t.containerTypeId ?? `kind:${t.containerKind}`}`;
}

/**
 * Группирует позиции прайса в строки таблицы. Порядок строк — по названию типа мусора, внутри
 * типа: сначала цены на вид техники целиком, затем на конкретные типы по названию. Так соседние
 * строки читаются как «общая цена и исключения из неё» — тем же правилом, по которому подбор
 * предпочитает точный тариф (ADR 0009).
 */
export function buildWasteTariffGrid(tariffs: readonly WasteTariffDto[]): WasteTariffGridRow[] {
  const rows = new Map<string, WasteTariffGridRow>();
  for (const t of tariffs) {
    const key = wasteTariffRowKey(t);
    const row = rows.get(key) ?? {
      key,
      wasteTypeId: t.wasteTypeId,
      wasteTypeName: t.wasteTypeName,
      containerTypeId: t.containerTypeId,
      containerTypeName: t.containerTypeName,
      containerKind: t.containerKind,
      byOperator: {},
    };
    row.byOperator[t.operatorCounterpartyId] = t;
    rows.set(key, row);
  }

  return [...rows.values()].sort(
    (a, b) =>
      a.wasteTypeName.localeCompare(b.wasteTypeName, 'ru') ||
      Number(a.containerTypeId != null) - Number(b.containerTypeId != null) ||
      (a.containerTypeName ?? a.containerKind ?? '').localeCompare(
        b.containerTypeName ?? b.containerKind ?? '',
        'ru',
      ),
  );
}

/**
 * Операторы, для которых нужны столбцы: все активные (чтобы цену можно было завести) плюс те,
 * у кого цены уже есть. Неактивный оператор со своим прайсом столбец сохраняет — иначе его цены
 * стали бы невидимыми и неправимыми, хотя из подбора они выпадают сами.
 */
export function wasteTariffColumnOperators<T extends { id: string; isActive: boolean }>(
  operators: readonly T[],
  tariffs: readonly WasteTariffDto[],
): T[] {
  const priced = new Set(tariffs.map((t) => t.operatorCounterpartyId));
  return operators.filter((o) => o.isActive || priced.has(o.id));
}
