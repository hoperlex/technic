import {
  newItemBlocker,
  type UpdateWeeklyRequestBody,
  vehicleClassificationKey,
  vehicleClassificationLabel,
  type VehicleClassificationDto,
  type WeeklyItemWarning,
  type WeeklyRequestItemDto,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';

/** A decision for an order already present on the construction site. */
export interface WeeklyOrderDecision {
  kind: 'extend' | 'leave' | null;
  /** The extension end date; empty when the server did not offer a valid extension. */
  dateTo: string;
}

/** A saved or suggested order in the “stays” and “leaves” sections. */
export interface WeeklyOrderRow {
  requestId: string;
  displayNumber: string;
  title: string;
  effectiveDateTo: string;
  /** `null` means that extending this order is not a valid choice. */
  suggestedDateTo: string | null;
  /** Server-owned explanation of why extension is unavailable. */
  extendBlockedReason: string | null;
  warnings: WeeklyItemWarning[];
  /** A saved row whose source order no longer belongs to the current suggestion. */
  staleReason: string | null;
  /** Saved item id used to attach row-level 422 errors. */
  itemId: string | null;
}

/** An additional vehicle classification requested for the target week. */
export interface WeeklyNewRow {
  key: string;
  classificationKey?: string;
  dateFrom: string;
  dateTo: string;
  responsibleName: string;
  responsiblePhone: string;
  deliveryNeeded: boolean;
  deliveryFrom: string;
  comment: string;
  itemId: string | null;
}

export interface WeeklyCompositionState {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
  newRows: WeeklyNewRow[];
}

function orderTitle(order: WeeklySuggestionOrderDto): string {
  const classification = vehicleClassificationLabel({
    typeName: order.vehicleTypeName,
    categoryName: order.vehicleCategoryName,
  });
  const vehicle = order.vehicleLabel ? ` · ${order.vehicleLabel}` : '';
  const rental = order.ownership && order.ownership !== 'own' ? ' (аренда)' : '';
  return `${classification}${vehicle}${rental}`;
}

/** Keep saved rows visible when their source order disappears from a refreshed suggestion. */
function staleRow(
  item: WeeklyRequestItemDto,
  reason: string | null,
  suggestionKnown: boolean,
): WeeklyOrderRow {
  const lastDate = item.sourceDateTo || item.sourceDateFrom || item.expectedDateTo || '';
  return {
    requestId: item.sourceRequestId!,
    displayNumber: item.sourceDisplayNumber ?? '—',
    title: item.currentVehicleLabel ?? '—',
    effectiveDateTo: lastDate,
    suggestedDateTo: item.dateTo ?? lastDate,
    // The source order is absent, so only the server-provided stale reason may forbid it; the
    // client must not invent a second extension rule.
    extendBlockedReason: null,
    warnings: item.warnings,
    staleReason: suggestionKnown
      ? (reason ?? 'Заказа больше нет в срезе площадки — решите строку заново')
      : null,
    itemId: item.id,
  };
}

/** Start an additional row with the whole target week selected. */
export function emptyWeeklyNewRow(weekStart: string, weekEnd: string): WeeklyNewRow {
  return {
    key: `new-${Math.random().toString(36).slice(2)}`,
    dateFrom: weekStart,
    dateTo: weekEnd,
    responsibleName: '',
    responsiblePhone: '',
    deliveryNeeded: false,
    deliveryFrom: '',
    comment: '',
    itemId: null,
  };
}

/**
 * Overlay saved decisions on the current site suggestion. Defaults belong only to the editable
 * state; the saved-state snapshot must stay default-free so dirty detection remains truthful.
 */
export function buildWeeklyCompositionState(
  request: WeeklyVehicleRequestDto,
  suggestion: WeeklySuggestionDto | undefined,
  withDefaults: boolean,
): WeeklyCompositionState {
  const itemsByOrder = new Map(
    request.items
      .filter((item) => item.sourceRequestId)
      .map((item) => [item.sourceRequestId!, item]),
  );
  const blockedReasons = new Map(
    (suggestion?.blocked ?? []).map((item) => [item.requestId, item.reason]),
  );
  const candidates = [...(suggestion?.extend ?? []), ...(suggestion?.leaving ?? [])];
  const rows: WeeklyOrderRow[] = [];
  const decisions: Record<string, WeeklyOrderDecision> = {};

  for (const order of candidates) {
    const savedItem = itemsByOrder.get(order.requestId);
    rows.push({
      requestId: order.requestId,
      displayNumber: order.displayNumber,
      title: orderTitle(order),
      effectiveDateTo: order.effectiveDateTo,
      suggestedDateTo: order.suggestedDateTo,
      extendBlockedReason: order.extendBlockedReason,
      warnings: order.warnings,
      staleReason: null,
      itemId: savedItem?.id ?? null,
    });
    const savedKind = savedItem && savedItem.kind !== 'new' ? savedItem.kind : null;
    decisions[order.requestId] = {
      kind: savedKind ?? (withDefaults && !savedItem && order.included ? 'extend' : null),
      // Never invent a date when the server offered none; that would re-enable an invalid choice.
      dateTo: savedItem?.dateTo ?? order.suggestedDateTo ?? '',
    };
  }

  for (const item of request.items) {
    if (!item.sourceRequestId || decisions[item.sourceRequestId]) continue;
    rows.push(
      staleRow(item, blockedReasons.get(item.sourceRequestId) ?? null, suggestion !== undefined),
    );
    decisions[item.sourceRequestId] = {
      kind: item.kind === 'new' ? null : item.kind,
      dateTo: item.dateTo ?? item.expectedDateTo ?? '',
    };
  }

  const newRows = request.items
    .filter((item) => item.kind === 'new')
    .map((item) => ({
      key: item.id,
      classificationKey:
        item.vehicleTypeId != null
          ? vehicleClassificationKey(item.vehicleTypeId, item.vehicleCategoryId)
          : undefined,
      dateFrom: item.dateFrom ?? request.weekStart,
      dateTo: item.dateTo ?? request.weekEnd,
      responsibleName: item.responsibleName,
      responsiblePhone: item.responsiblePhone,
      deliveryNeeded: item.deliveryNeeded,
      deliveryFrom: item.deliveryFrom,
      comment: item.comment,
      itemId: item.id,
    }));

  return { rows, decisions, newRows };
}

/** Serialize only explicit decisions because an unchecked order means “not decided”, not leave. */
export function serializeWeeklyComposition(
  state: WeeklyCompositionState,
  classifications: Map<string, VehicleClassificationDto>,
): UpdateWeeklyRequestBody['items'] {
  const items: UpdateWeeklyRequestBody['items'] = [];
  for (const row of state.rows) {
    const decision = state.decisions[row.requestId];
    if (!decision?.kind) continue;
    items.push(
      decision.kind === 'extend'
        ? { kind: 'extend', sourceRequestId: row.requestId, dateTo: decision.dateTo }
        : { kind: 'leave', sourceRequestId: row.requestId },
    );
  }
  for (const row of state.newRows) {
    const classification = row.classificationKey
      ? classifications.get(row.classificationKey)
      : undefined;
    if (!classification) continue;
    items.push({
      kind: 'new',
      vehicleTypeId: classification.vehicleTypeId,
      vehicleCategoryId: classification.vehicleCategoryId,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
      responsibleName: row.responsibleName,
      responsiblePhone: row.responsiblePhone,
      deliveryNeeded: row.deliveryNeeded,
      deliveryFrom: row.deliveryFrom,
      comment: row.comment,
    });
  }
  return items;
}

/** Reuse the server contract's blocker so the form never develops a second validation rule. */
export function weeklyNewRowIssues(
  rows: WeeklyNewRow[],
  request: WeeklyVehicleRequestDto,
  classifications: Map<string, VehicleClassificationDto>,
  today: string,
): Map<string, string> {
  const issues = new Map<string, string>();
  const scope = {
    objectId: request.objectId,
    weekStart: request.weekStart,
    weekEnd: request.weekEnd,
    objectIsActive: true,
    today,
  };
  for (const row of rows) {
    const classification = row.classificationKey
      ? classifications.get(row.classificationKey)
      : undefined;
    if (!classification) {
      issues.set(row.key, 'Выберите тип или категорию техники');
      continue;
    }
    // The query returns active options only; category presence is encoded by the option itself.
    const blocker = newItemBlocker(
      {
        vehicleTypeId: classification.vehicleTypeId,
        vehicleCategoryId: classification.vehicleCategoryId,
        dateFrom: row.dateFrom,
        dateTo: row.dateTo,
        responsibleName: row.responsibleName,
        responsiblePhone: row.responsiblePhone,
        deliveryNeeded: row.deliveryNeeded,
        deliveryFrom: row.deliveryFrom,
      },
      scope,
      {
        typeIsActive: true,
        categoryIsActive: classification.vehicleCategoryId ? true : null,
        hasCategories: !!classification.vehicleCategoryId,
      },
    );
    if (blocker) issues.set(row.key, blocker);
  }
  return issues;
}
