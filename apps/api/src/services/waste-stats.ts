import {
  analyticsCountsAsFact,
  isManualCostOnly,
  monthRange,
  REQUEST_TYPES,
  roleScopeAxis,
  roleScopeAxisLabels,
  placeObjectScopeIds,
  type RequestType,
  type WasteStatsFigures,
  type WasteStatsDto,
  type WasteStatsKind,
  type WasteStatsPositionDto,
  type WasteStatsRowDto,
  wasteStatsKindOf,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from '../lib/errors';
import { loadWasteFacts } from './analytics/facts-waste';
import { MoneySum } from './analytics/money';
import { ANALYTICS_ATOM_LIMIT, type AnalyticsAtom } from './analytics/types';

/**
 * Waste removal statistics for a reporting month (plan `docs/waste-stats-tab-plan.md`, three-volume
 * rework — ADR 0209).
 *
 * THERE ARE NO NUMBERS OF ITS OWN HERE (R1). The service takes the atoms of `loadWasteFacts` — the
 * same ones the Excel book is built from — and only groups them by site and waste type. A
 * `SELECT sum(...)` "just for the tab" would create a second answer to "how much was removed in
 * August": the attribution day, the fact rule and the money rule would drift from the book
 * silently. The guard of this decision is the db test reconciling the tab with the book.
 *
 * It differs from the book in exactly three things, each a decision of the task:
 *
 * 1. **The usual site scope** (R7): the book refuses a narrow scope altogether, while the tab lives
 *    inside the module and a site sees its own objects. Counterparty roles and the worker cabinet
 *    do not get the tab at all — see `assertWasteStatsAudience`.
 * 2. **One kind of removal in cubic metres** (R6; snow-removal plan, S8): garbage or snow, never
 *    both. Scrap metal (tonnes, no money at all) and container operations (not billed) have no kind.
 *    The type list of a kind is derived from the contract (`wasteStatsKindOf`) and filters the
 *    query, not its result, so the quality counts describe the same kind as the rows.
 * 3. **Three volumes instead of one** (ADR 0209): ordered (every valid request), removed (requests
 *    in a fact status) and by tickets (every ticket not dismissed, ADR 0213), with one cost column —
 *    the removed cost, the plan and the ticket cost shown under it. Every volume travels with its
 *    money from the same set of requests, and each money figure is a dash rather than zero when
 *    none of its volume has a price.
 *
 * Snow differs in money only (S6, S7): its cost is entered by hand at completion, so it has no plan
 * or ticket money at all — a dash even at zero volume, and no «без цены» warning there — while its
 * removed cost is the sum of the entered amounts, zero included, a dash only when none is known.
 */

function typesOfKind(kind: WasteStatsKind): readonly RequestType[] {
  return REQUEST_TYPES.filter((t) => wasteStatsKindOf(t) === kind);
}

/**
 * Request types of each kind, derived from the contract and `REQUEST_TYPES` — never a list typed by
 * hand into SQL (snow-removal plan, §2). The `Record` makes a new kind a compile error here.
 */
export const WASTE_STATS_REQUEST_TYPES: Readonly<Record<WasteStatsKind, readonly RequestType[]>> = {
  waste: typesOfKind('waste'),
  snow: typesOfKind('snow'),
};

/**
 * Money of the kind is entered by hand only (S6): no price list, no estimate, no price per cubic
 * metre. Asked of the contract per type; a kind is homogeneous by construction, and a unit test
 * holds that, because one table mixing estimated and invoiced money is what S8 forbids.
 */
const MANUAL_COST_KIND: Readonly<Record<WasteStatsKind, boolean>> = {
  waste: WASTE_STATS_REQUEST_TYPES.waste.every(isManualCostOnly),
  snow: WASTE_STATS_REQUEST_TYPES.snow.every(isManualCostOnly),
};

/**
 * Кому вкладка не отвечает вовсе (Р7).
 *
 * Исполнителю вывоза право `wasteRequests.read` выдано (`COUNTERPARTY_TYPE_PERMISSIONS`), и без
 * этой проверки он получил бы таблицу «площадка → объём → стоимость», собранную из своих заявок:
 * свод чужих площадок по своим рейсам — не его сведения, а о деньгах с ним говорят актами, а не
 * экраном портала. Кабинет работника закрыт той же строкой и по той же причине.
 *
 * Спрашивается ОСЬ роли, а не имя роли и не тип контрагента: осей области в портале четыре, и
 * перечисление их по одной означало бы забыть очередную при её появлении.
 */
export function assertWasteStatsAudience(p: Principal): void {
  const axis = roleScopeAxis(p.role);
  if (axis !== 'counterparty' && axis !== 'person') return;
  throw err.forbidden(
    `Статистика сводит площадки; у вашей учётки область ограничена (${roleScopeAxisLabels[axis]})`,
  );
}

/**
 * Cell accumulator: volumes and counters are summed, money is summed exactly (`money.ts`), the rest
 * are sets of requests.
 */
interface Acc {
  volumeFact: number;
  volumeFactUnpriced: number;
  volumePlanned: number;
  volumePlannedUnpriced: number;
  moneyPlanned: MoneySum;
  volumeOrdered: number;
  moneyFact: MoneySum;
  moneyEstimate: MoneySum;
  ticketVolume: number;
  ticketUnconfirmed: number;
  ticketUnpriced: number;
  moneyTickets: MoneySum;
  ticketsWithoutVolume: number;
  ticketsUnconfirmed: number;
  ticketFilesUnread: number;
  ticketFilesWithoutTickets: number;
  removals: number;
  requests: Set<string>;
  unpriced: Set<string>;
  /** Requests in a fact status, and those of them whose completion carries an amount. */
  factRequests: Set<string>;
  factCosted: Set<string>;
}

function emptyAcc(): Acc {
  return {
    volumeFact: 0,
    volumeFactUnpriced: 0,
    volumePlanned: 0,
    volumePlannedUnpriced: 0,
    moneyPlanned: new MoneySum(),
    volumeOrdered: 0,
    moneyFact: new MoneySum(),
    moneyEstimate: new MoneySum(),
    ticketVolume: 0,
    ticketUnconfirmed: 0,
    ticketUnpriced: 0,
    moneyTickets: new MoneySum(),
    ticketsWithoutVolume: 0,
    ticketsUnconfirmed: 0,
    ticketFilesUnread: 0,
    ticketFilesWithoutTickets: 0,
    removals: 0,
    requests: new Set(),
    unpriced: new Set(),
    factRequests: new Set(),
    factCosted: new Set(),
  };
}

function add(acc: Acc, atom: AnalyticsAtom): void {
  acc.volumeFact += atom.volumeM3;
  acc.volumeFactUnpriced += atom.volumeFactUnpricedM3;
  acc.volumePlanned += atom.volumePlannedM3;
  acc.volumePlannedUnpriced += atom.volumePlannedUnpricedM3;
  acc.moneyPlanned.add(atom.moneyPlanned);
  acc.volumeOrdered += atom.volumeOrderedM3;
  acc.moneyFact.add(atom.moneyFact);
  // A waste estimate is a single number, low and high are equal (R9 of analytics): one side is enough.
  acc.moneyEstimate.add(atom.moneyLow);
  acc.ticketVolume += atom.volumeTicketsM3;
  acc.ticketUnconfirmed += atom.volumeTicketsUnconfirmedM3;
  acc.ticketUnpriced += atom.volumeTicketsUnpricedM3;
  acc.moneyTickets.add(atom.moneyTickets);
  acc.ticketsWithoutVolume += atom.ticketsWithoutVolume;
  acc.ticketsUnconfirmed += atom.ticketsUnconfirmed;
  acc.ticketFilesUnread += atom.ticketFilesUnread;
  acc.ticketFilesWithoutTickets += atom.ticketFilesWithoutTickets;
  acc.removals += atom.removals;
  acc.requests.add(atom.requestId);
  /*
   * "Unpriced" is counted BY REQUESTS, not by atoms: a waste request has one atom today, but the
   * rule repeats the book counter on purpose — if the atom grain changes, the tab must not start
   * reporting one unpriced request as ten.
   */
  if (!atom.priced) acc.unpriced.add(atom.requestId);
  /*
   * A removed request "has an amount" exactly when it is priced: in a fact status the loader's
   * `priced` is "the completion carries a total" for both kinds (garbage and manual-cost snow), so
   * the flag is read here instead of a second copy of that rule.
   */
  if (analyticsCountsAsFact(atom.requestStatus)) {
    acc.factRequests.add(atom.requestId);
    if (atom.priced) acc.factCosted.add(atom.requestId);
  }
}

/**
 * Rounding of volumes happens **once, at the end** (the `rollup.ts` rule): the addends are not
 * rounded, or a share lost on every request would move the site total, and positions would stop
 * adding up to their row. Money follows the same rule through `MoneySum`.
 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Money of a volume, or a DASH (`null`) when none of that volume has a price (R5 of ADR 0193, now
 * shared by all three money figures). Zero money alone cannot decide it: after atoms are summed it
 * means both "there was no price" and "there was nothing to price". So the rule reads two numbers:
 *
 * - nothing to price — zero, an honest empty cell;
 * - the whole volume without a price — a dash: there is nothing to multiply by;
 * - part of it without a price — a NUMBER, and the portal marks it with a warning that names the
 *   unpriced volume (ADR 0213): an understated sum without a mark looks calculated.
 */
function costOrDash(volume: number, unpricedVolume: number, money: number): number | null {
  return volume > 0 && unpricedVolume === volume ? null : money;
}

/**
 * Money of one cell. Garbage reads every figure by the volume rule above. Manual-cost snow (S6, S7)
 * has no plan and no ticket money at all — `null` whatever the volume, with no unpriced share to
 * warn about — and its removed cost is the sum of the ENTERED amounts, a recorded 0 included: a
 * dash only when removed requests exist and none of them has an amount. The missing amounts are
 * flagged on the removed volume (`doneVolumeUnpricedM3`) and by `unpricedRequests`; an unfinished or
 * rolled-back snow request is missing nothing, because its cost is entered only at completion.
 */
interface CellMoney {
  plannedCost: number | null;
  plannedVolumeUnpricedM3: number;
  doneCost: number | null;
  ticketCost: number | null;
  ticketVolumeUnpricedM3: number;
}

function moneyOfCell(
  acc: Acc,
  manualCost: boolean,
  volumes: { planned: number; done: number; doneUnpriced: number; ticket: number },
): CellMoney {
  if (manualCost) {
    const noAmountKnown = acc.factRequests.size > 0 && acc.factCosted.size === 0;
    return {
      plannedCost: null,
      plannedVolumeUnpricedM3: 0,
      doneCost: noAmountKnown ? null : acc.moneyFact.rubles(),
      ticketCost: null,
      ticketVolumeUnpricedM3: 0,
    };
  }
  const plannedVolumeUnpricedM3 = round(acc.volumePlannedUnpriced, 3);
  const ticketVolumeUnpricedM3 = round(acc.ticketUnpriced, 3);
  return {
    plannedCost: costOrDash(volumes.planned, plannedVolumeUnpricedM3, acc.moneyPlanned.rubles()),
    plannedVolumeUnpricedM3,
    doneCost: costOrDash(volumes.done, volumes.doneUnpriced, acc.moneyFact.rubles()),
    ticketCost: costOrDash(volumes.ticket, ticketVolumeUnpricedM3, acc.moneyTickets.rubles()),
    ticketVolumeUnpricedM3,
  };
}

function figuresOf(acc: Acc, kind: WasteStatsKind): WasteStatsFigures {
  const plannedVolumeM3 = round(acc.volumePlanned, 3);
  const doneVolumeM3 = round(acc.volumeFact, 3);
  const doneVolumeUnpricedM3 = round(acc.volumeFactUnpriced, 3);
  const ticketVolumeM3 = round(acc.ticketVolume, 3);
  const money = moneyOfCell(acc, MANUAL_COST_KIND[kind], {
    planned: plannedVolumeM3,
    done: doneVolumeM3,
    doneUnpriced: doneVolumeUnpricedM3,
    ticket: ticketVolumeM3,
  });
  return {
    plannedVolumeM3,
    plannedCost: money.plannedCost,
    plannedVolumeUnpricedM3: money.plannedVolumeUnpricedM3,
    doneVolumeM3,
    doneCost: money.doneCost,
    doneVolumeUnpricedM3,
    ticketVolumeM3,
    ticketVolumeUnconfirmedM3: round(acc.ticketUnconfirmed, 3),
    ticketVolumeUnpricedM3: money.ticketVolumeUnpricedM3,
    ticketCost: money.ticketCost,
    ticketsWithoutVolume: acc.ticketsWithoutVolume,
    ticketsUnconfirmed: acc.ticketsUnconfirmed,
    ticketFilesUnread: acc.ticketFilesUnread,
    ticketFilesWithoutTickets: acc.ticketFilesWithoutTickets,
    unpricedRequests: acc.unpriced.size,
    removals: acc.removals,
    requests: acc.requests.size,
    /*
     * Deprecated combined figures of the pre-ADR 0209 portal (removed + ordered in one number,
     * R3 of ADR 0193). A tab opened with an old build reads them without any check, so they stay
     * until the client floor rises above the contract of the release that stopped reading them.
     */
    volumeM3: round(acc.volumeFact + acc.volumeOrdered, 3),
    volumeOrderedM3: round(acc.volumeOrdered, 3),
    // The combined figure is summed from the same exact units and converted once (`money.ts`).
    totalCost: MoneySum.combined(acc.moneyFact, acc.moneyEstimate).rubles(),
    costEstimated: acc.moneyEstimate.rubles(),
    // Deprecated names of the ticket figure (ADR 0213) — same values, see the contract.
    confirmedVolumeM3: ticketVolumeM3,
    confirmedVolumeUnpricedM3: money.ticketVolumeUnpricedM3,
    confirmedCost: money.ticketCost,
  };
}

/** Порядок строк и позиций — как во всех перечнях портала: по-русски, с числами по-человечески. */
const COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

/**
 * Rows and the total of one kind from a set of atoms — pure, so the money rules of a kind can be
 * checked without a database. The atoms must already be of this kind: the loader filters them.
 */
export function wasteStatsOf(
  atoms: AnalyticsAtom[],
  kind: WasteStatsKind,
): Pick<WasteStatsDto, 'rows' | 'totals'> {
  const rows = new Map<string, { atom: AnalyticsAtom; acc: Acc; positions: Map<string, Acc> }>();
  const totals = emptyAcc();
  for (const atom of atoms) {
    add(totals, atom);
    let row = rows.get(atom.customerId);
    if (!row) {
      row = { atom, acc: emptyAcc(), positions: new Map() };
      rows.set(atom.customerId, row);
    }
    add(row.acc, atom);
    let position = row.positions.get(atom.positionKey);
    if (!position) {
      position = emptyAcc();
      row.positions.set(atom.positionKey, position);
    }
    add(position, atom);
  }

  const positionLabels = new Map<string, string>();
  for (const atom of atoms) positionLabels.set(atom.positionKey, atom.positionLabel);

  const items: WasteStatsRowDto[] = [...rows.values()]
    .map(({ atom, acc, positions }) => ({
      objectId: atom.customerId,
      code: atom.customerCode,
      name: atom.customerName,
      isActive: atom.customerIsActive,
      ...figuresOf(acc, kind),
      positions: [...positions.entries()]
        .map(([key, cell]): WasteStatsPositionDto => ({
          key,
          label: positionLabels.get(key) ?? key,
          ...figuresOf(cell, kind),
        }))
        .sort((a, b) => COLLATOR.compare(a.label, b.label)),
    }))
    .sort((a, b) => COLLATOR.compare(a.code, b.code));

  /*
   * Итог собран из ТЕХ ЖЕ атомов, а не сложением уже собранных строк: сложение строк — второй
   * путь к тому же числу, и расхождение на нём не ловится ничем (правило `rollup.ts`).
   */
  return { rows: items, totals: figuresOf(totals, kind) };
}

/**
 * `kind` defaults to garbage: a tab built before snow sends only `month` and must get exactly the
 * garbage statistics it always got.
 */
export async function loadWasteStats(
  p: Principal,
  month: string,
  kind: WasteStatsKind = 'waste',
): Promise<WasteStatsDto> {
  const range = monthRange(month);
  const { atoms, quality } = await loadWasteFacts(range, {
    // `null` — ограничения нет; пустой список — видимых объектов нет вовсе, и ответ пуст.
    objectIds: placeObjectScopeIds(p),
    /*
     * The kind narrows the QUERY (its scope CTE), not the loaded set: the atom ceiling below and
     * the quality counts must describe the kind the reader asked for, not garbage and snow
     * together.
     */
    requestTypes: WASTE_STATS_REQUEST_TYPES[kind],
  });

  /*
   * ПОТОЛОК АТОМОВ (Р15 аналитики) — здесь, а не в загрузчике: он стоит в `loadAnalyticsAtoms`,
   * которую вкладка не зовёт, и без этой строки единственная ручка слоя осталась бы без предела.
   * Месяц вывоза в него не упирается ни на одной сегодняшней площадке — ставится он ровно поэтому:
   * предел, который никого не задевает, и обязан стоять до того, как задел.
   */
  if (atoms.length > ANALYTICS_ATOM_LIMIT) {
    throw err.badRequest(
      `В статистику попадает ${atoms.length} строк, предел — ${ANALYTICS_ATOM_LIMIT}: выберите месяц с меньшим числом заявок`,
      { month: 'Слишком много заявок за месяц' },
    );
  }

  const { rows, totals } = wasteStatsOf(atoms, kind);
  return {
    month,
    // The portal renders snow figures only when the reply echoes `snow`: an API that ignored the
    // parameter would answer with garbage numbers under the snow switch.
    kind,
    from: range.from,
    to: range.to,
    rows,
    totals,
    quality,
  };
}
