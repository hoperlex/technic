import type { ContainerKind, WasteTariffDto } from '@technic/contracts';

/** Labels shared by the tariff editor and the matrix target column. */
export const wasteTariffKindLabels: Record<ContainerKind, string> = {
  cont: 'Любой контейнер',
  truck: 'Любой самосвал',
};

/**
 * Assemble the price directory as “row = waste × vehicle, column = operator” (ADR 0026). A flat
 * tariff list repeats the same pair for every operator and makes the rate comparison—the reason
 * this directory exists—needlessly difficult.
 */

/** One grid row: a waste/vehicle pair and each operator's price for it. */
export interface WasteTariffGridRow {
  key: string;
  wasteTypeId: string;
  wasteTypeName: string;
  /** Exactly one tariff target is present: a concrete vehicle type or a whole vehicle kind. */
  containerTypeId: string | null;
  containerTypeName: string | null;
  containerKind: ContainerKind | null;
  /** Tariff positions for this pair, keyed by operator id. */
  byOperator: Record<string, WasteTariffDto>;
}

/** The waste-type/vehicle pair is both the semantic identity and the table row key. */
export function wasteTariffRowKey(tariff: {
  wasteTypeId: string;
  containerTypeId: string | null;
  containerKind: ContainerKind | null;
}): string {
  return `${tariff.wasteTypeId}::${tariff.containerTypeId ?? `kind:${tariff.containerKind}`}`;
}

/**
 * Group tariff positions into grid rows. Whole-kind prices precede concrete types within a waste
 * type, so adjacent rows read as “the general price, then its exceptions”, matching the exact-
 * tariff precedence rule from ADR 0009.
 */
export function buildWasteTariffGrid(tariffs: readonly WasteTariffDto[]): WasteTariffGridRow[] {
  const rows = new Map<string, WasteTariffGridRow>();
  for (const tariff of tariffs) {
    const key = wasteTariffRowKey(tariff);
    const row = rows.get(key) ?? {
      key,
      wasteTypeId: tariff.wasteTypeId,
      wasteTypeName: tariff.wasteTypeName,
      containerTypeId: tariff.containerTypeId,
      containerTypeName: tariff.containerTypeName,
      containerKind: tariff.containerKind,
      byOperator: {},
    };
    row.byOperator[tariff.operatorCounterpartyId] = tariff;
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
 * Show every active operator, so a price can be created, plus inactive operators that already own
 * prices. Hiding the latter would make their surviving tariff rows invisible and uneditable even
 * though the pricing resolver correctly ignores them.
 */
export function wasteTariffColumnOperators<T extends { id: string; isActive: boolean }>(
  operators: readonly T[],
  tariffs: readonly WasteTariffDto[],
): T[] {
  const priced = new Set(tariffs.map((tariff) => tariff.operatorCounterpartyId));
  return operators.filter((operator) => operator.isActive || priced.has(operator.id));
}
