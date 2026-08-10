import { useEffect, useMemo, useRef, useState } from 'react';
import {
  newItemBlocker,
  type UpdateWeeklyRequestBody,
  vehicleClassificationKey,
  vehicleClassificationLabel,
  type VehicleClassificationDto,
  type WeeklyItemCounts,
  type WeeklyItemWarning,
  type WeeklyRequestItemDto,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyToday } from './weeklyShared';

/**
 * Состав недельной заявки в руках человека: решение по каждой стоящей единице и список того, что
 * нужно дополнительно (§5 шаги 2–4).
 *
 * Логика отделена от разметки намеренно: правило «снятая галка — это строка „уезжает“, а не
 * отсутствие строки» (Р10) и правило «строка без решения в состав не уходит» одинаково нужны трём
 * блокам и панели действий, и разъедься они по компонентам — разошлись бы и поведением.
 *
 * Состав уходит на сервер целиком (массив переписывается), поэтому и здесь он собирается целиком
 * из двух источников: предложения портала (что стоит на площадке) и уже сохранённых строк.
 */

/** Решение по стоящей единице: остаётся до такого-то числа, уезжает или ещё не принято. */
export interface WeeklyOrderDecision {
  kind: 'extend' | 'leave' | null;
  /** До какого числа продлить; значим только у «остаётся». Пусто — продлевать эту единицу нечем. */
  dateTo: string;
}

/** Строка блоков «остаётся»/«уезжает»: заказ, который стоит на площадке. */
export interface WeeklyOrderRow {
  requestId: string;
  displayNumber: string;
  /** «Экскаватор-погрузчик · JCB 3CX · А123АА (аренда)». */
  title: string;
  /** Эффективный конец срока заказа сейчас — от него считается прибавка. */
  effectiveDateTo: string;
  /**
   * Дата продления умолчанием — воскресенье недели; `null` — продлевать нечем (см.
   * `extendBlockedReason`). Именно `null`, а не «сегодня» и не воскресенье: подставь форма дату,
   * которую сервер тут же отвергнет, — «Остаётся» снова стало бы доступным.
   */
  suggestedDateTo: string | null;
  /**
   * Почему вариант «Остаётся» по этой единице недоступен; `null` — доступен. Считает сервер тем
   * же предикатом, каким потом откажет (`extendBlocker`), — правило здесь не повторяется.
   */
  extendBlockedReason: string | null;
  warnings: WeeklyItemWarning[];
  /**
   * Строка осталась от прежнего состава, а её заказа в предложении больше нет: отменили, закрыли,
   * увезли. Причина показывается прямо в строке — молча выбросить её нельзя, состав документа
   * менялся бы без объяснения.
   */
  staleReason: string | null;
  /** Идентификатор сохранённой строки: по нему приходит построчная причина отказа 422 (§9). */
  itemId: string | null;
}

/** Строка «нужна дополнительно» в форме: позиция классификатора, срок и контакт. */
export interface WeeklyNewRow {
  key: string;
  /** Ключ позиции классификатора «тип:категория» (ADR 0028). */
  classificationKey?: string;
  dateFrom: string;
  dateTo: string;
  responsibleName: string;
  responsiblePhone: string;
  deliveryNeeded: boolean;
  deliveryFrom: string;
  comment: string;
  /** Идентификатор сохранённой строки — для построчных причин отказа. */
  itemId: string | null;
}

/** Подпись заказа в строке состава: что заказано и какая машина на нём стоит. */
function orderTitle(order: WeeklySuggestionOrderDto): string {
  const what = vehicleClassificationLabel({
    typeName: order.vehicleTypeName,
    categoryName: order.vehicleCategoryName,
  });
  const vehicle = order.vehicleLabel ? ` · ${order.vehicleLabel}` : '';
  const rent = order.ownership && order.ownership !== 'own' ? ' (аренда)' : '';
  return `${what}${vehicle}${rent}`;
}

/**
 * Строка состава, чей заказ не пришёл в предложении, — собирается из того, что помнит сама строка.
 *
 * `known` — было ли предложение вообще: у применённой заявки и у роли без права заводить неделю
 * его не спрашивают, и объявлять там каждую строку пропавшей было бы враньём.
 */
function staleRow(
  item: WeeklyRequestItemDto,
  reason: string | null,
  known: boolean,
): WeeklyOrderRow {
  const last = item.sourceDateTo || item.sourceDateFrom || item.expectedDateTo || '';
  return {
    requestId: item.sourceRequestId!,
    displayNumber: item.sourceDisplayNumber ?? '—',
    title: item.currentVehicleLabel ?? '—',
    effectiveDateTo: last,
    suggestedDateTo: item.dateTo ?? last,
    // Заказа нет в предложении — спросить сервер о годности продления не у кого, и запрещать
    // «Остаётся» самим здесь нельзя: причина строки уже сказана `staleReason`.
    extendBlockedReason: null,
    warnings: item.warnings,
    staleReason: known
      ? (reason ?? 'Заказа больше нет в срезе площадки — решите строку заново')
      : null,
    itemId: item.id,
  };
}

/** Пустая строка «нужна дополнительно»: срок умолчанием — вся неделя (§5 шаг 3). */
function emptyNewRow(weekStart: string, weekEnd: string): WeeklyNewRow {
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

interface BuildResult {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
  newRows: WeeklyNewRow[];
}

/**
 * Начальное состояние: предложение портала, поверх которого лежат уже сохранённые решения.
 *
 * Умолчание берётся у предложения (`included`): неделя чаще продлевается, чем сокращается, — но
 * единица, которую продлить нечем (её срок и так идёт до воскресенья), приходит **без** решения:
 * ей доступно только «Уезжает», а «оставить дальше» решает заявка на следующую неделю.
 */
function buildState(
  request: WeeklyVehicleRequestDto,
  suggestion: WeeklySuggestionDto | undefined,
): BuildResult {
  const items = request.items;
  const byOrder = new Map(
    items.filter((i) => i.sourceRequestId).map((i) => [i.sourceRequestId!, i]),
  );
  const blockedReason = new Map((suggestion?.blocked ?? []).map((b) => [b.requestId, b.reason]));
  const candidates = [...(suggestion?.extend ?? []), ...(suggestion?.leaving ?? [])];

  const rows: WeeklyOrderRow[] = [];
  const decisions: Record<string, WeeklyOrderDecision> = {};
  for (const order of candidates) {
    const item = byOrder.get(order.requestId);
    rows.push({
      requestId: order.requestId,
      displayNumber: order.displayNumber,
      title: orderTitle(order),
      effectiveDateTo: order.effectiveDateTo,
      suggestedDateTo: order.suggestedDateTo,
      extendBlockedReason: order.extendBlockedReason,
      warnings: order.warnings,
      staleReason: null,
      itemId: item?.id ?? null,
    });
    decisions[order.requestId] = {
      kind: item ? (item.kind === 'new' ? null : item.kind) : order.included ? 'extend' : null,
      // Даты, которой сервер не предложил, здесь не выдумывается: у единицы, чей срок и так идёт
      // до воскресенья, поле остаётся пустым, а вариант «Остаётся» ей и не показывается.
      dateTo: item?.dateTo ?? order.suggestedDateTo ?? '',
    };
  }
  // Сохранённые строки, которых в предложении нет: заказ отменили, закрыли или он уехал. Строка
  // остаётся видимой с причиной — иначе состав документа изменился бы молча.
  for (const item of items) {
    if (!item.sourceRequestId || decisions[item.sourceRequestId]) continue;
    rows.push(staleRow(item, blockedReason.get(item.sourceRequestId) ?? null, !!suggestion));
    decisions[item.sourceRequestId] = {
      kind: item.kind === 'new' ? null : item.kind,
      dateTo: item.dateTo ?? item.expectedDateTo ?? '',
    };
  }

  const newRows: WeeklyNewRow[] = items
    .filter((i) => i.kind === 'new')
    .map((i) => ({
      key: i.id,
      classificationKey:
        i.vehicleTypeId != null
          ? vehicleClassificationKey(i.vehicleTypeId, i.vehicleCategoryId)
          : undefined,
      dateFrom: i.dateFrom ?? request.weekStart,
      dateTo: i.dateTo ?? request.weekEnd,
      responsibleName: i.responsibleName,
      responsiblePhone: i.responsiblePhone,
      deliveryNeeded: i.deliveryNeeded,
      deliveryFrom: i.deliveryFrom,
      comment: i.comment,
      itemId: i.id,
    }));

  return { rows, decisions, newRows };
}

/** Состав в теле запроса: строки без решения в него не уходят вовсе. */
function serialize(
  decisions: Record<string, WeeklyOrderDecision>,
  rows: WeeklyOrderRow[],
  newRows: WeeklyNewRow[],
  byKey: Map<string, VehicleClassificationDto>,
): UpdateWeeklyRequestBody['items'] {
  const items: UpdateWeeklyRequestBody['items'] = [];
  for (const row of rows) {
    const decision = decisions[row.requestId];
    if (!decision?.kind) continue;
    if (decision.kind === 'extend') {
      items.push({ kind: 'extend', sourceRequestId: row.requestId, dateTo: decision.dateTo });
    } else {
      items.push({ kind: 'leave', sourceRequestId: row.requestId });
    }
  }
  for (const row of newRows) {
    const classification = row.classificationKey ? byKey.get(row.classificationKey) : undefined;
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
 * Почему строку `new` не примут — тем же предикатом, каким её проверит сервер (`newItemBlocker`).
 * Проверка стоит в форме не вместо серверной, а до неё: узнать о погашенном типе ТС надо раньше
 * визы, а не отказом на ней.
 */
function newRowIssues(
  rows: WeeklyNewRow[],
  request: WeeklyVehicleRequestDto,
  byKey: Map<string, VehicleClassificationDto>,
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
    const classification = row.classificationKey ? byKey.get(row.classificationKey) : undefined;
    if (!classification) {
      issues.set(row.key, 'Выберите тип или категорию техники');
      continue;
    }
    // Список позиций спрошен активным, поэтому погашенной здесь быть не может; наличие категорий
    // видно по самой позиции: тип с категориями отдельной строкой в классификаторе не выводится.
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

export interface WeeklyComposition {
  rows: WeeklyOrderRow[];
  decisions: Record<string, WeeklyOrderDecision>;
  setDecision: (requestId: string, patch: Partial<WeeklyOrderDecision>) => void;
  newRows: WeeklyNewRow[];
  addNewRow: () => void;
  updateNewRow: (key: string, patch: Partial<WeeklyNewRow>) => void;
  removeNewRow: (key: string) => void;
  comment: string;
  setComment: (value: string) => void;
  counts: WeeklyItemCounts;
  /** Единицы, по которым решение не принято: подать заявку с ними можно, но сказать об этом надо. */
  undecided: number;
  /** Почему строка `new` не годится — ключ строки → текст. */
  issues: Map<string, string>;
  items: UpdateWeeklyRequestBody['items'];
  dirty: boolean;
}

/**
 * Состав в состоянии страницы. Пересобирается, когда меняется версия заявки (сохранили состав,
 * применили, отклонили) или состав предложения: тогда на экране обязано появиться то, что лежит на
 * сервере. Обычная перерисовка правку человека не трогает.
 */
export function useWeeklyComposition(
  request: WeeklyVehicleRequestDto | undefined,
  suggestion: WeeklySuggestionDto | undefined,
  byKey: Map<string, VehicleClassificationDto>,
  /**
   * Дождались ли предложения. Собирать состав до него нельзя: сохранённые строки на секунду
   * оказались бы «пропавшими», а правка, начатая в эту секунду, слетела бы при пересборке.
   */
  ready: boolean,
): WeeklyComposition {
  const empty: BuildResult = { rows: [], decisions: {}, newRows: [] };
  const [state, setState] = useState<BuildResult>(empty);
  const [comment, setComment] = useState('');
  /**
   * То же состояние, каким его собрали с сервера. Хранится состоянием, а не готовой строкой:
   * сравнивать надо два одинаково собранных состава — классификатор доезжает позже заявки, и
   * снимок, снятый до него, потерял бы строки `new` и объявил бы правкой то, чего не правили.
   */
  const [initial, setInitial] = useState<BuildResult>(empty);

  const sourceKey = request
    ? `${request.id}:${request.version}:${(suggestion?.extend ?? [])
        .concat(suggestion?.leaving ?? [])
        .map((o) => o.requestId)
        .join(',')}`
    : '';
  const builtKey = useRef('');
  useEffect(() => {
    if (!request || !ready || builtKey.current === sourceKey) return;
    builtKey.current = sourceKey;
    const next = buildState(request, suggestion);
    setState(next);
    setInitial(next);
    setComment(request.comment);
  }, [request, suggestion, sourceKey, ready]);

  const items = useMemo(
    () => serialize(state.decisions, state.rows, state.newRows, byKey),
    [state, byKey],
  );
  const savedItems = useMemo(
    () => serialize(initial.decisions, initial.rows, initial.newRows, byKey),
    [initial, byKey],
  );

  const counts: WeeklyItemCounts = {
    extend: items.filter((i) => i.kind === 'extend').length,
    new: items.filter((i) => i.kind === 'new').length,
    leave: items.filter((i) => i.kind === 'leave').length,
  };

  return {
    ...state,
    setDecision: (requestId, patch) =>
      setState((prev) => ({
        ...prev,
        decisions: {
          ...prev.decisions,
          [requestId]: { ...prev.decisions[requestId]!, ...patch },
        },
      })),
    addNewRow: () =>
      setState((prev) => ({
        ...prev,
        newRows: [...prev.newRows, emptyNewRow(request?.weekStart ?? '', request?.weekEnd ?? '')],
      })),
    updateNewRow: (key, patch) =>
      setState((prev) => ({
        ...prev,
        newRows: prev.newRows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
      })),
    removeNewRow: (key) =>
      setState((prev) => ({ ...prev, newRows: prev.newRows.filter((r) => r.key !== key) })),
    comment,
    setComment,
    counts,
    undecided: state.rows.filter((r) => !state.decisions[r.requestId]?.kind).length,
    issues: request
      ? newRowIssues(state.newRows, request, byKey, weeklyToday())
      : new Map<string, string>(),
    items,
    // Несохранённые изменения: сравнивается то, что уедет на сервер, а не состояние формы —
    // переключение решения туда и обратно не должно считаться правкой.
    dirty:
      JSON.stringify(items) !== JSON.stringify(savedItems) ||
      (request ? comment !== request.comment : false),
  };
}
