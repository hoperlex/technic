import {
  type IssueBlocker,
  type PointRoleInput,
  type RoutePointAction,
  routeIssueBlockers,
  routeRequestCapacity,
  suggestPointMerges,
  type TaskRef,
  taskRefKey,
  type TaskRowField,
  type TaskRowOrderGroup,
  taskRowOrderGroups,
  type VehicleRoutePointDto,
  waybillTaskRows,
  type WaybillTaskRow,
  type VehicleRouteDto,
} from '@technic/contracts';

/**
 * The assembled day as the route card sees it: task rows, waybill-issue blockers and merge hints —
 * everything the card computes **from the points** instead of asking the server (section 4.3, R11,
 * R11a, R11b of `docs/route-trips-plan.md`).
 *
 * The rules are not defined here: they live entirely in contracts (`routeIssueBlockers`,
 * `waybillTaskRows`, `suggestPointMerges`), and the portal must not repeat them — the server
 * computes the same rules and answers with the same refusals. This module answers a different
 * question: **what** to feed them and **how** to name the result for a person. Both jobs stay
 * apart from the markup — they would bloat the card, and they are tested with data, not rendering.
 */

/**
 * Task rows of the route composition — what the form capacity is measured by and what must be
 * laid out across points.
 *
 * The server takes them from the composition (`routeTaskRefs`: trips of live requests plus days of
 * linear orders), but the card has **nothing** to take them from there: `VehicleRouteRequestDto`
 * carries no trips — it has the addresses and quantity of the first live trip and not a single
 * `tripId` (`requestsByRoute`). So freight rows are collected from point roles: a role references
 * its task row by a composite key, and a row with at least one end in the route is fully visible
 * from here — including one laid out only halfway, which is exactly what the `rows_unplaced`
 * blocker exists for.
 *
 * This count diverges from the server's in exactly one state: a composition row with **no points
 * at all**. Portal actions cannot reach it — placing a request and scheduling a day create points
 * themselves (R8), and deleting a point refuses on a row's last role (section 7) — but if such a
 * state ever appears in the database, the card stays silent about it while the server refuses at
 * issue time. That is the honest price of one missing DTO field; adding it belongs to stage 8,
 * together with «Задание листа» (waybill task) in the route list.
 *
 * Linear days, by contrast, are read from the composition directly: the composition row has
 * `workDate`, so the card itself reports a day without a point as unplaced.
 */
export function routeCompositionRefs(route: VehicleRouteDto): TaskRef[] {
  const positionOf = new Map(route.requests.map((item) => [item.requestId, item.position]));
  const found = new Map<string, { ref: TaskRef; position: number; tripNum: number }>();
  const add = (ref: TaskRef, position: number, tripNum: number) => {
    const key = taskRefKey(ref);
    if (!found.has(key)) found.set(key, { ref, position, tripNum });
  };

  for (const point of route.points ?? []) {
    for (const action of point.actions) {
      add(action.ref, positionOf.get(action.ref.requestId) ?? 0, action.tripNum);
    }
  }
  // A linear-order day removed from all points still has its composition row, and "unplaced" is
  // about exactly that case. A freight row has no such visibility (see above), and there is
  // nothing to invent it from.
  for (const item of route.requests) {
    if (!item.workDate) continue;
    add({ kind: 'linear', requestId: item.requestId, workDate: item.workDate }, item.position, 0);
  }

  // Composition order, then trip number within a request: the server returns unplaced rows (which
  // have no position of their own in the route) by the same key.
  return [...found.values()]
    .sort((a, b) => a.position - b.position || a.tripNum - b.tripNum)
    .map((item) => item.ref);
}

/**
 * A point role as a request body. A point is edited with its **whole** set of roles (section 7),
 * so an address edit must send back the same roles the point already has — otherwise "fixed the
 * time" would mean "removed all work from the point". The shape matches the DTO: a trip names its
 * request next to the trip (the server uses it to find the composition row and take the lock,
 * R17); a linear day is not asked for a role at all — it is always `work`.
 */
export function pointRoleInputOf(action: RoutePointAction): PointRoleInput {
  return action.kind === 'freight'
    ? {
        kind: 'freight',
        requestId: action.ref.requestId,
        tripId: action.ref.tripId,
        role: action.role,
      }
    : { kind: 'linear', requestId: action.ref.requestId, workDate: action.ref.workDate };
}

/**
 * A role in a point's list: icon, word and task row number — «↑ погрузка ТС-40/1 · 10 м³».
 *
 * The icon goes **before** the word and mirrors the cargo direction: the list is scanned top to
 * bottom, and the arrow answers "what happens here" before the person finishes reading the line.
 * A linear day has no direction at all (R5a), so it gets a work gear instead.
 */
const ROLE_MARKS: Record<RoutePointAction['role'], string> = {
  load: '↑',
  work: '⚙',
  unload: '↓',
};
const ROLE_WORDS: Record<RoutePointAction['role'], string> = {
  load: 'погрузка',
  work: 'работа',
  unload: 'разгрузка',
};

export function actionLabel(action: RoutePointAction): string {
  const cargo = action.kind === 'freight' ? action.cargoLabel : '';
  return [`${ROLE_MARKS[action.role]} ${ROLE_WORDS[action.role]}`, action.displayNumber, cargo]
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * Where the other end of the trip is: «→ к точке 2» for a load, «← от точки 1» for an unload.
 *
 * Position zero means not "the first point" but "no pair" (`pairPosition` in the DTO): the trip is
 * laid out only halfway, which is not an ordering issue but `rows_unplaced`. It has to be said
 * right here, at the role itself: the blocker above the list names the row number, but where to
 * look is visible only from here. A linear day never has a pair and does not look for a second end.
 */
export function actionPairLabel(action: RoutePointAction): string {
  if (action.kind !== 'freight') return '';
  if (action.pairPosition === 0) {
    return action.role === 'load' ? '→ разгрузка не разложена' : '← погрузка не разложена';
  }
  return action.role === 'load'
    ? `→ к точке ${action.pairPosition}`
    : `← от точки ${action.pairPosition}`;
}

/** Points with the same address that are worth combining into one stop (R9a). */
export interface PointMergeHint {
  pointIds: string[];
  /** Positions of the same points: people read the hint by route-order numbers, not by ids. */
  positions: number[];
  /** Contacts match; `false` — the merged point keeps both, and the form prints both (R11a). */
  sameContacts: boolean;
}

export interface RouteAssembly {
  /** Task rows in print order: trips and linear days in one list (R11). */
  rows: WaybillTaskRow[];
  /** Task rows of the composition, unplaced ones included: the paper is measured by these. */
  composition: TaskRef[];
  /** Task rows that fit the route's form (ADR 0068). */
  capacity: number;
  /** What prevents issuing the waybill — by the same rule the server will answer with. */
  blockers: IssueBlocker[];
  merges: PointMergeHint[];
  /**
   * Blockers fixed by editing a specific point (R11b): `pointId` → its list. Today this is only a
   * task row that does not fit — every other refusal targets the composition, not a point.
   */
  pointBlockers: Map<string, IssueBlocker[]>;
  /** `taskRefKey` → «ТС-40/2»: refusals address rows by reference, people read row numbers. */
  labels: Map<string, string>;
  /**
   * Rows that the route order cannot tell apart: `taskRefKey` → its group (the shared point and
   * the row order on it). This decides which rows of «Задание листа» (waybill task) get arrows —
   * for the rest the order is set by the route, and they must be reordered by moving points.
   */
  orderGroups: Map<string, TaskRowOrderGroup>;
}

/**
 * Everything the card knows about the assembled day — from a single read of the points.
 *
 * One function rather than three calls at each display site: task rows are needed by the
 * «Задание листа» block, the counter and the blockers, and `routeIssueBlockers` builds them again
 * internally. The extra pass is cheap, but the two lists must never diverge — from one the person
 * reads "5 of 7 rows", from the other they get an issue refusal.
 *
 * Row comments (`TaskRowNotes`) are not passed here: points do not have them — a comment belongs
 * to a trip or a request, not to a stop, and the route DTO does not carry it. Blockers are not
 * affected: `taskRowLayout` drops the comment first, and `required_fields_overflow` is computed
 * from addresses and quantity, i.e. from what the point does have. The comment still reaches the
 * paper — the server-side issue fills it in.
 */
export function assembleRoute(route: VehicleRouteDto): RouteAssembly {
  /*
   * Points are read with an empty fallback even though the type promises them. The `vehicle-routes`
   * cache key is shared by the card, the list and the suggestions, and not every server endpoint
   * returns points — a route put into the cache by the list lacks the field. The card shows an
   * empty route honestly ("no stops"), whereas a crash on `undefined.map` would cost the whole
   * card, including waybill cancellation.
   */
  const points = route.points ?? [];
  const composition = routeCompositionRefs(route);
  const rows = waybillTaskRows(points);
  const blockers = routeIssueBlockers({
    driverPersonId: route.driverPersonId,
    formCode: route.formCode,
    points,
    composition,
  });

  const positionOf = new Map(points.map((point) => [point.id, point.position]));
  const merges = suggestPointMerges(points).map((hint) => ({
    ...hint,
    positions: hint.pointIds.map((id) => positionOf.get(id) ?? 0),
  }));

  const pointBlockers = new Map<string, IssueBlocker[]>();
  for (const blocker of blockers) {
    if (blocker.code !== 'required_fields_overflow') continue;
    const list = pointBlockers.get(blocker.pointId) ?? [];
    list.push(blocker);
    pointBlockers.set(blocker.pointId, list);
  }

  const labels = new Map<string, string>();
  for (const point of points) {
    for (const action of point.actions) labels.set(taskRefKey(action.ref), action.displayNumber);
  }

  const orderGroups = new Map<string, TaskRowOrderGroup>();
  for (const group of taskRowOrderGroups(points)) {
    for (const ref of group.refs) orderGroups.set(taskRefKey(ref), group);
  }

  return {
    rows,
    composition,
    capacity: routeRequestCapacity(route.formCode),
    blockers,
    merges,
    pointBlockers,
    labels,
    orderGroups,
  };
}

/**
 * A point's roles in a new order: the two named task rows swap places, all other roles stay where
 * they were.
 *
 * The order is sent as a full list (`PUT /:id/points/:pointId/roles/order`), which is why the card
 * assembles the point's whole role set rather than just the pair. For each row the lookup finds its
 * **first** role — the one on this point: load for a trip, work for a linear day. An unload of
 * another trip sitting on the same point keeps its place: rows swap with each other, not with the
 * whole stop.
 */
export function reorderedPointRoles(
  point: VehicleRoutePointDto,
  a: TaskRef,
  b: TaskRef,
): PointRoleInput[] {
  const actions = [...point.actions].sort((x, y) => x.position - y.position);
  const indexOf = (ref: TaskRef) =>
    actions.findIndex(
      (action) => taskRefKey(action.ref) === taskRefKey(ref) && action.role !== 'unload',
    );
  const from = indexOf(a);
  const to = indexOf(b);
  // A missing role means the card is behind the server: the order is then sent unchanged, and the
  // server's response brings the card up to date. Guessing a swap from incomplete data is not
  // allowed: the wrong roles would get moved.
  if (from >= 0 && to >= 0) [actions[from], actions[to]] = [actions[to]!, actions[from]!];
  return actions.map(pointRoleInputOf);
}

/** Human-readable task row number; a reference without a number is a row no longer in the route. */
function refLabel(ref: TaskRef, labels: ReadonlyMap<string, string>): string {
  return labels.get(taskRefKey(ref)) ?? 'строка задания';
}

/** The form column that overflowed: the person is told what they will go and fix. */
const FIELD_LABELS: Record<TaskRowField, string> = {
  from: 'адрес погрузки',
  to: 'адрес разгрузки',
  cargo: 'количество груза',
};

/**
 * A refusal in words — the same one the server would give, but with row numbers instead of refs.
 *
 * `no_driver` does reach this function and is named here too: the card does not display it (the
 * issue-readiness line above the button talks about the driver), but a silent branch in a union
 * switch is a refusal that one day nobody will hear about.
 */
export function blockerMessage(blocker: IssueBlocker, assembly: RouteAssembly): string {
  const names = (refs: readonly TaskRef[]) =>
    refs.map((ref) => refLabel(ref, assembly.labels)).join(', ');
  switch (blocker.code) {
    case 'no_driver':
      return 'Водитель не назначен: без него лист не выписать';
    case 'trip_order_broken':
      return blocker.refs.length === 1
        ? `${names(blocker.refs)} разгружается раньше, чем грузится — переставьте точки`
        : `Разгрузка стоит раньше погрузки: ${names(blocker.refs)} — переставьте точки`;
    case 'rows_unplaced':
      return `Не разложено по точкам: ${names(blocker.refs)} — у строки нет второго конца`;
    case 'capacity_exceeded':
      return `Строк задания ${blocker.rows}, а в бланке ${blocker.capacity}: выньте заявку, снимите день или заведите второй маршрут`;
    case 'required_fields_overflow':
      return `Строка ${blocker.slot} (${refLabel(blocker.ref, assembly.labels)}) не поместится в бланк: ${blocker.fields
        .map((field) => FIELD_LABELS[field])
        .join(', ')}`;
  }
}

/**
 * Merge hint (R9a): what is proposed to be combined and what that means for the form.
 *
 * The note about different contacts is not decoration: merging neither drops them nor picks one —
 * the point keeps both, and the «заказчик, телефон» (customer, phone) column prints both (R11a).
 * Someone expecting "only one will remain" would otherwise find out from the paper.
 */
export function mergeHintMessage(hint: PointMergeHint): string {
  // «1 и 4», «1, 4 и 6»: three visits to one quarry are one proposal, not three pairwise ones, and
  // it must read as an enumeration rather than a chain of "and".
  const positions = hint.positions.slice(0, -1).join(', ');
  const last = hint.positions[hint.positions.length - 1];
  const head = `Точки ${positions} и ${last} — один адрес.`;
  return hint.sameContacts
    ? `${head} Совместить в одну остановку?`
    : `${head} У точек разные ответственные — в лист пойдут оба.`;
}
