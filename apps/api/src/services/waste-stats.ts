import {
  monthRange,
  roleScopeAxis,
  roleScopeAxisLabels,
  placeObjectScopeIds,
  type WasteStatsFigures,
  type WasteStatsDto,
  type WasteStatsPositionDto,
  type WasteStatsRowDto,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from '../lib/errors';
import { loadWasteFacts, VOLUME_REQUEST_TYPES } from './analytics/facts-waste';
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
 * 2. **Only waste removal in cubic metres** (R6): scrap metal (tonnes, no money at all) and
 *    container operations (not billed) are filtered out by the query, not after it. The type list
 *    is the loader's `VOLUME_REQUEST_TYPES`, not a copy.
 * 3. **Three volumes instead of one** (ADR 0209): ordered (every valid request), removed (requests
 *    in a fact status) and confirmed by tickets, with one cost column — the removed cost, the plan
 *    and the confirmed cost shown under it. Every volume travels with its money from the same set
 *    of requests, and each money figure is a dash rather than zero when none of its volume has a
 *    price.
 */

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

/** Cell accumulator: everything additive is summed, the rest are sets of requests. */
interface Acc {
  volumeFact: number;
  volumeFactUnpriced: number;
  volumePlanned: number;
  volumePlannedUnpriced: number;
  moneyPlanned: number;
  volumeOrdered: number;
  moneyFact: number;
  moneyEstimate: number;
  confirmedVolume: number;
  confirmedUnpriced: number;
  moneyConfirmed: number;
  ticketsWithoutVolume: number;
  removals: number;
  requests: Set<string>;
  unpriced: Set<string>;
}

function emptyAcc(): Acc {
  return {
    volumeFact: 0,
    volumeFactUnpriced: 0,
    volumePlanned: 0,
    volumePlannedUnpriced: 0,
    moneyPlanned: 0,
    volumeOrdered: 0,
    moneyFact: 0,
    moneyEstimate: 0,
    confirmedVolume: 0,
    confirmedUnpriced: 0,
    moneyConfirmed: 0,
    ticketsWithoutVolume: 0,
    removals: 0,
    requests: new Set(),
    unpriced: new Set(),
  };
}

function add(acc: Acc, atom: AnalyticsAtom): void {
  acc.volumeFact += atom.volumeM3;
  acc.volumeFactUnpriced += atom.volumeFactUnpricedM3;
  acc.volumePlanned += atom.volumePlannedM3;
  acc.volumePlannedUnpriced += atom.volumePlannedUnpricedM3;
  acc.moneyPlanned += atom.moneyPlanned;
  acc.volumeOrdered += atom.volumeOrderedM3;
  acc.moneyFact += atom.moneyFact;
  // A waste estimate is a single number, low and high are equal (R9 of analytics): one side is enough.
  acc.moneyEstimate += atom.moneyLow;
  acc.confirmedVolume += atom.volumeConfirmedM3;
  acc.confirmedUnpriced += atom.volumeConfirmedUnpricedM3;
  acc.moneyConfirmed += atom.moneyConfirmed;
  acc.ticketsWithoutVolume += atom.ticketsWithoutVolume;
  acc.removals += atom.removals;
  acc.requests.add(atom.requestId);
  /*
   * "Unpriced" is counted BY REQUESTS, not by atoms: a waste request has one atom today, but the
   * rule repeats the book counter on purpose — if the atom grain changes, the tab must not start
   * reporting one unpriced request as ten.
   */
  if (!atom.priced) acc.unpriced.add(atom.requestId);
}

/**
 * Rounding happens **once, at the end** (the `rollup.ts` rule): the addends are not rounded, or a
 * kopeck lost on every request would move the site total, and positions would stop adding up to
 * their row.
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
 * - part of it without a price — a NUMBER, and the portal signs "без цены 12,5 м³" next to it: an
 *   understated sum without that note looks calculated.
 */
function costOrDash(volume: number, unpricedVolume: number, money: number): number | null {
  return volume > 0 && unpricedVolume === volume ? null : money;
}

function figuresOf(acc: Acc): WasteStatsFigures {
  const plannedVolumeM3 = round(acc.volumePlanned, 3);
  const plannedVolumeUnpricedM3 = round(acc.volumePlannedUnpriced, 3);
  const doneVolumeM3 = round(acc.volumeFact, 3);
  const doneVolumeUnpricedM3 = round(acc.volumeFactUnpriced, 3);
  const confirmedVolumeM3 = round(acc.confirmedVolume, 3);
  const confirmedVolumeUnpricedM3 = round(acc.confirmedUnpriced, 3);
  return {
    plannedVolumeM3,
    plannedCost: costOrDash(plannedVolumeM3, plannedVolumeUnpricedM3, round(acc.moneyPlanned, 2)),
    plannedVolumeUnpricedM3,
    doneVolumeM3,
    doneCost: costOrDash(doneVolumeM3, doneVolumeUnpricedM3, round(acc.moneyFact, 2)),
    doneVolumeUnpricedM3,
    confirmedVolumeM3,
    confirmedVolumeUnpricedM3,
    confirmedCost: costOrDash(
      confirmedVolumeM3,
      confirmedVolumeUnpricedM3,
      round(acc.moneyConfirmed, 2),
    ),
    ticketsWithoutVolume: acc.ticketsWithoutVolume,
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
    totalCost: round(acc.moneyFact + acc.moneyEstimate, 2),
    costEstimated: round(acc.moneyEstimate, 2),
  };
}

/** Порядок строк и позиций — как во всех перечнях портала: по-русски, с числами по-человечески. */
const COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export async function loadWasteStats(p: Principal, month: string): Promise<WasteStatsDto> {
  const range = monthRange(month);
  const { atoms, quality } = await loadWasteFacts(range, {
    // `null` — ограничения нет; пустой список — видимых объектов нет вовсе, и ответ пуст.
    objectIds: placeObjectScopeIds(p),
    requestTypes: VOLUME_REQUEST_TYPES,
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
      ...figuresOf(acc),
      positions: [...positions.entries()]
        .map(([key, cell]): WasteStatsPositionDto => ({
          key,
          label: positionLabels.get(key) ?? key,
          ...figuresOf(cell),
        }))
        .sort((a, b) => COLLATOR.compare(a.label, b.label)),
    }))
    .sort((a, b) => COLLATOR.compare(a.code, b.code));

  return {
    month,
    from: range.from,
    to: range.to,
    rows: items,
    /*
     * Итог собран из ТЕХ ЖЕ атомов, а не сложением уже собранных строк: сложение строк — второй
     * путь к тому же числу, и расхождение на нём не ловится ничем (правило `rollup.ts`).
     */
    totals: figuresOf(totals),
    quality,
  };
}
