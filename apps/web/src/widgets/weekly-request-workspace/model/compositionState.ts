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

/*
 * The weekly request composition in the user's hands: a decision for each vehicle standing on site
 * and the list of what is needed additionally (section 5 steps 2-4).
 *
 * Logic is kept apart from markup on purpose: the rule "an unchecked box is a 'leaves' row, not a
 * missing row" (R10) and the rule "a row without a decision is not sent" are needed by three blocks
 * and the action bar alike, and split across components they would drift in behaviour.
 *
 * The composition goes to the server whole (the array is rewritten), so here too it is assembled
 * whole from two sources: the portal suggestion (what stands on site) and already saved rows.
 */

/** Decision for a standing vehicle: stays until a date, leaves, or not decided yet. */
export interface WeeklyOrderDecision {
  kind: 'extend' | 'leave' | null;
  /** Extension end date, meaningful only for "stays". Empty: there is nothing to extend it with. */
  dateTo: string;
}

/** A saved or suggested order in the “stays” and “leaves” sections. */
export interface WeeklyOrderRow {
  requestId: string;
  displayNumber: string;
  /** "Экскаватор-погрузчик · JCB 3CX · А123АА (аренда)". */
  title: string;
  /** The order's effective term end now; the extension is counted from it. */
  effectiveDateTo: string;
  /**
   * Default extension date, the Sunday of the week; null means there is nothing to extend (see
   * extendBlockedReason). Exactly null, not "today" and not Sunday: if the form filled in a date
   * the server immediately rejects, "Stays" would become available again.
   */
  suggestedDateTo: string | null;
  /**
   * Why "Stays" is unavailable for this vehicle; null means available. Computed by the server with
   * the same predicate it later refuses with (extendBlocker); the rule is not repeated here.
   */
  extendBlockedReason: string | null;
  warnings: WeeklyItemWarning[];
  /**
   * The row remains from the previous composition while its order is gone from the suggestion
   * (cancelled, closed, taken away). The reason is shown in the row: dropping it silently would
   * change the document's composition without explanation.
   */
  staleReason: string | null;
  /** Saved row id: per-row 422 refusal reasons arrive keyed by it (section 9). */
  itemId: string | null;
}

/** A "needed additionally" row of the form: classifier position, term and contact. */
export interface WeeklyNewRow {
  key: string;
  /** Classifier position key "type:category" (ADR 0028). */
  classificationKey?: string;
  dateFrom: string;
  dateTo: string;
  responsibleName: string;
  responsiblePhone: string;
  deliveryNeeded: boolean;
  deliveryFrom: string;
  comment: string;
  /** Saved row id, for per-row refusal reasons. */
  itemId: string | null;
}

export interface WeeklyCompositionState {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
  newRows: WeeklyNewRow[];
}

// Order label in a composition row: what was ordered and which vehicle stands on it.
function orderTitle(order: WeeklySuggestionOrderDto): string {
  const classification = vehicleClassificationLabel({
    typeName: order.vehicleTypeName,
    categoryName: order.vehicleCategoryName,
  });
  const vehicle = order.vehicleLabel ? ` · ${order.vehicleLabel}` : '';
  const rental = order.ownership && order.ownership !== 'own' ? ' (аренда)' : '';
  return `${classification}${vehicle}${rental}`;
}

/**
 * A composition row whose order did not come in the suggestion, built from what the row itself
 * remembers.
 *
 * suggestionKnown tells whether there was a suggestion at all: it is not asked for an applied
 * request or for a role without the right to create weeks, and declaring every row lost there would
 * be a lie.
 */
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
    // The order is not in the suggestion, so there is nobody to ask about extension validity, and
    // forbidding "Stays" here on our own is not allowed: the row's reason is already staleReason.
    extendBlockedReason: null,
    warnings: item.warnings,
    staleReason: suggestionKnown
      ? (reason ?? 'Заказа больше нет в срезе площадки — решите строку заново')
      : null,
    itemId: item.id,
  };
}

/** An empty "needed additionally" row: the default term is the whole week (section 5 step 3). */
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
 * Initial state: the portal suggestion with already saved decisions laid over it.
 *
 * The default comes from the suggestion (included): a week is more often extended than cut, but a
 * vehicle with nothing to extend (its term already runs to Sunday) arrives WITHOUT a decision: only
 * "Leaves" is available to it, and "keep it further" is decided by next week's request.
 *
 * withDefaults: the screen is built with defaults, the saved-composition snapshot without them, so
 * dirty detection compares against what is really on the server.
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
      // A date the server did not offer is not invented: for a vehicle whose term already runs to
      // Sunday the field stays empty, and "Stays" is not offered to it at all.
      dateTo: savedItem?.dateTo ?? order.suggestedDateTo ?? '',
    };
  }

  // Saved rows missing from the suggestion: the order was cancelled, closed or left. The row stays
  // visible with a reason, otherwise the document's composition would change silently.
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

/** The composition in the request body: rows without a decision are not sent at all. */
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

/**
 * Why a new row would be refused, by the same predicate the server checks (newItemBlocker). The
 * check sits in the form not instead of the server's but before it: a retired vehicle type must be
 * learned before approval, not by a refusal at it.
 */
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
    // Positions are queried active, so a retired one cannot be here; category presence is seen from
    // the position itself: a type with categories is not listed as a separate classifier row.
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
