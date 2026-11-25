import { describe, expect, it, vi } from 'vitest';
import {
  isManualCostOnly,
  REQUEST_TYPES,
  WASTE_STATS_KINDS,
  wasteFactUnit,
  wasteStatsKindOf,
  wasteStatsQuerySchema,
} from '@technic/contracts';
import type { Principal } from '../src/auth/principal';
import type {
  AnalyticsAtom,
  AnalyticsFacts,
  AnalyticsFactsScope,
  AnalyticsRange,
} from '../src/services/analytics/types';

/**
 * The stats kind of the waste statistics tab (snow-removal plan, S8, §3.4) without a database.
 *
 * The SQL type filter of each kind is derived from `wasteStatsKindOf` and `REQUEST_TYPES`; these
 * checks hold the properties that derivation relies on, so a new request type cannot silently land
 * in the wrong table or mix estimated and invoiced money in one total. The loader is replaced: what
 * the query answers is the db test's subject (`snow-stats.db.test.ts`), here it is what the service
 * asks of it and what it makes of the atoms.
 */

const state = vi.hoisted(() => ({
  calls: [] as { range: AnalyticsRange; scope: AnalyticsFactsScope | undefined }[],
  facts: { atoms: [], quality: [] } as AnalyticsFacts,
}));

vi.mock('../src/services/analytics/facts-waste', () => ({
  loadWasteFacts: async (range: AnalyticsRange, scope?: AnalyticsFactsScope) => {
    state.calls.push({ range, scope });
    return state.facts;
  },
}));

const { assertWasteStatsAudience, loadWasteStats, WASTE_STATS_REQUEST_TYPES, wasteStatsOf } =
  await import('../src/services/waste-stats');

function principal(over: Partial<Principal>): Principal {
  return {
    id: 'user-1',
    email: 'user@example.invalid',
    lastName: 'Тестовый',
    firstName: 'Пользователь',
    middleName: '',
    fullName: 'Тестовый Пользователь',
    phone: '',
    role: 'admin',
    isActive: true,
    mustChangePassword: false,
    ...over,
  } as Principal;
}

describe('вид статистики вывоза: контракт', () => {
  it('мусор — «waste», снег — «snow», лом и контейнерные операции — никуда', () => {
    const map = Object.fromEntries(REQUEST_TYPES.map((t) => [t, wasteStatsKindOf(t)]));
    expect(map).toEqual({
      container_install: null,
      container_replace: null,
      container_removal: null,
      waste_removal: 'waste',
      snow_removal: 'snow',
      metal_removal: null,
    });
  });

  it('каждый вид — кубометры, и в нём есть хотя бы один тип', () => {
    for (const kind of WASTE_STATS_KINDS) {
      const types = REQUEST_TYPES.filter((t) => wasteStatsKindOf(t) === kind);
      expect(types.length, kind).toBeGreaterThan(0);
      for (const t of types) expect(wasteFactUnit(t), t).toBe('volume_m3');
    }
    // And no volume type is left without a kind: it would vanish from the tab altogether.
    for (const t of REQUEST_TYPES.filter((type) => wasteFactUnit(type) === 'volume_m3')) {
      expect(wasteStatsKindOf(t), t).not.toBeNull();
    }
  });

  it('деньги вида однородны: ручная стоимость либо у всех его типов, либо ни у одного', () => {
    for (const kind of WASTE_STATS_KINDS) {
      const types = REQUEST_TYPES.filter((t) => wasteStatsKindOf(t) === kind);
      expect(types.some(isManualCostOnly), kind).toBe(types.every(isManualCostOnly));
    }
  });

  it('запрос с одним месяцем — это мусор; чужой вид отвергается', () => {
    expect(wasteStatsQuerySchema.parse({ month: '2032-01' })).toEqual({
      month: '2032-01',
      kind: 'waste',
    });
    expect(wasteStatsQuerySchema.parse({ month: '2032-01', kind: 'snow' }).kind).toBe('snow');
    expect(wasteStatsQuerySchema.safeParse({ month: '2032-01', kind: 'metal' }).success).toBe(
      false,
    );
  });
});

describe('вид статистики вывоза: что сервис просит у загрузчика', () => {
  it('типы вида выведены из контракта: мусор — вывоз мусора, снег — вывоз снега', () => {
    expect(WASTE_STATS_REQUEST_TYPES).toEqual({
      waste: ['waste_removal'],
      snow: ['snow_removal'],
    });
  });

  it('месяц, вид и область уходят в загрузчик, вид — эхом в ответ', async () => {
    state.calls.length = 0;
    const site = principal({ role: 'shtab', constructionObjectIds: ['ob-1', 'ob-2'] });
    const snow = await loadWasteStats(site, '2041-11', 'snow');
    const waste = await loadWasteStats(site, '2041-11');
    expect(snow.kind).toBe('snow');
    expect(waste.kind).toBe('waste');
    expect(state.calls).toEqual([
      {
        range: { from: '2041-11-01', to: '2041-11-30' },
        scope: { objectIds: ['ob-1', 'ob-2'], requestTypes: ['snow_removal'] },
      },
      {
        range: { from: '2041-11-01', to: '2041-11-30' },
        scope: { objectIds: ['ob-1', 'ob-2'], requestTypes: ['waste_removal'] },
      },
    ]);
  });

  it('исполнителю вывоза и кабинету работника вкладка не отвечает при любом виде', () => {
    for (const role of ['operator', 'driver'] as const) {
      expect(() => assertWasteStatsAudience(principal({ role })), role).toThrow(
        /область ограничена/u,
      );
    }
    expect(() => assertWasteStatsAudience(principal({ role: 'shtab' }))).not.toThrow();
    expect(() => assertWasteStatsAudience(principal({ role: 'admin' }))).not.toThrow();
  });
});

// ── Money of a kind (S6, S7) over known atoms ──

/** A waste-module atom of one request; the defaults are a removed snow request with no paper. */
function atom(over: Partial<AnalyticsAtom>): AnalyticsAtom {
  return {
    module: 'waste',
    customerKind: 'object',
    customerId: 'ob-1',
    customerCode: 'ОБ-001',
    customerName: 'Площадка',
    customerIsActive: true,
    payerDepartmentId: null,
    payerDepartmentName: null,
    date: '2041-11-10',
    positionKey: 'removal|snow|-',
    positionLabel: 'Снег',
    registrationNumber: null,
    requestId: 'req-1',
    requestLabel: 'М-1',
    requestStatus: 'done',
    shifts: 0,
    planShifts: 0,
    trips: 0,
    volumeM3: 10,
    volumeOrderedM3: 0,
    volumeTicketsM3: 0,
    volumeTicketsUnpricedM3: 0,
    volumeTicketsUnconfirmedM3: 0,
    volumePlannedM3: 10,
    moneyPlanned: 0,
    volumePlannedUnpricedM3: 0,
    volumeFactUnpricedM3: 0,
    ticketsWithoutVolume: 0,
    ticketsUnconfirmed: 0,
    ticketFilesUnread: 0,
    ticketFilesWithoutTickets: 0,
    weightTons: 0,
    engineHours: 0,
    mechHours: 0,
    mechDays: 0,
    removals: 1,
    containerOps: 0,
    relocations: 0,
    moneyFact: 0,
    moneyLow: 0,
    moneyHigh: 0,
    moneyTickets: 0,
    priced: true,
    ...over,
  };
}

/** A removed snow request whose amount was never entered: the loader flags it and its volume. */
function unpaid(requestId: string, volumeM3: number): AnalyticsAtom {
  return atom({
    requestId,
    volumeM3,
    volumePlannedM3: volumeM3,
    volumeFactUnpricedM3: volumeM3,
    priced: false,
  });
}

/** An unfinished snow request: ordered only, and missing nothing yet. */
function open(requestId: string, volumeM3: number): AnalyticsAtom {
  return atom({
    requestId,
    requestStatus: 'new',
    volumeM3: 0,
    removals: 0,
    volumeOrderedM3: volumeM3,
    volumePlannedM3: volumeM3,
  });
}

describe('деньги снега в статистике', () => {
  it('стоимость вывезенного — сумма внесённых сумм, ноль тоже известная сумма', () => {
    const { totals } = wasteStatsOf(
      [
        atom({ requestId: 'paid', moneyFact: 1500 }),
        atom({ requestId: 'zero', moneyFact: 0, volumeM3: 8, volumePlannedM3: 8 }),
        unpaid('unpaid', 9),
        open('open', 15),
      ],
      'snow',
    );
    expect(totals).toMatchObject({
      doneVolumeM3: 27,
      doneCost: 1500,
      // Only the removed volume without an amount is flagged, and only that request.
      doneVolumeUnpricedM3: 9,
      unpricedRequests: 1,
      plannedVolumeM3: 42,
      plannedCost: null,
      plannedVolumeUnpricedM3: 0,
      ticketCost: null,
      ticketVolumeUnpricedM3: 0,
      confirmedCost: null,
      confirmedVolumeUnpricedM3: 0,
    });
  });

  it('только нулевая сумма — ноль, а не прочерк', () => {
    const { totals } = wasteStatsOf([atom({ requestId: 'zero', moneyFact: 0 })], 'snow');
    expect(totals.doneCost).toBe(0);
    expect(totals.unpricedRequests).toBe(0);
  });

  it('ни одной внесённой суммы у вывезенного — прочерк', () => {
    const { totals, rows } = wasteStatsOf([unpaid('a', 10), unpaid('b', 4)], 'snow');
    expect(totals.doneCost).toBeNull();
    expect(totals.doneVolumeUnpricedM3).toBe(14);
    expect(rows[0]?.positions[0]?.doneCost).toBeNull();
  });

  it('незакрытый снег денег не ждёт: ноль вывезенного, плана нет даже при нулевом объёме', () => {
    const { totals } = wasteStatsOf([open('open', 12)], 'snow');
    expect(totals).toMatchObject({ doneCost: 0, plannedCost: null, unpricedRequests: 0 });
    // An empty answer of the snow kind keeps the same shape: no plan and no ticket money at all.
    expect(wasteStatsOf([], 'snow').totals).toMatchObject({
      plannedCost: null,
      doneCost: 0,
      ticketCost: null,
      requests: 0,
    });
  });

  it('мусор по-прежнему: прочерк по объёму без цены, число с пометкой при частичной цене', () => {
    const garbage = (over: Partial<AnalyticsAtom>): AnalyticsAtom =>
      atom({ positionKey: 'removal|g|-', positionLabel: 'Мусор', ...over });
    const { totals } = wasteStatsOf(
      [
        garbage({
          requestId: 'g1',
          moneyFact: 1000,
          moneyPlanned: 1000,
          volumeTicketsM3: 10,
          moneyTickets: 1000,
        }),
        garbage({
          requestId: 'g2',
          volumeM3: 4,
          volumePlannedM3: 4,
          volumePlannedUnpricedM3: 4,
          volumeFactUnpricedM3: 4,
          volumeTicketsM3: 4,
          volumeTicketsUnpricedM3: 4,
          priced: false,
        }),
      ],
      'waste',
    );
    expect(totals).toMatchObject({
      doneCost: 1000,
      doneVolumeUnpricedM3: 4,
      plannedCost: 1000,
      plannedVolumeUnpricedM3: 4,
      ticketCost: 1000,
      ticketVolumeUnpricedM3: 4,
      unpricedRequests: 1,
    });
    const alone = wasteStatsOf(
      [garbage({ requestId: 'g2', volumeFactUnpricedM3: 10, priced: false })],
      'waste',
    );
    expect(alone.totals.doneCost).toBeNull();
  });

  it('крупные суммы по площадкам точны, итог выше копеечной точности — ближайшее число', () => {
    // 999 999 998.99 ₽ is just below the completion ceiling. 45 000 removals over three sites and
    // one kopeck of estimate make a deprecated combined total (fact + estimate) far above 2^45 ₽,
    // where a double no longer holds kopecks.
    const large = 999_999_998.99;
    const atoms: AnalyticsAtom[] = [];
    for (let i = 0; i < 45_000; i += 1) {
      const site = `ob-${i % 3}`;
      atoms.push(
        atom({
          requestId: `r-${i}`,
          customerId: site,
          customerCode: site,
          positionKey: 'removal|g|-',
          moneyFact: large,
        }),
      );
    }
    atoms.push(
      atom({
        requestId: 'open',
        requestStatus: 'new',
        removals: 0,
        volumeM3: 0,
        moneyLow: 0.01,
        moneyHigh: 0.01,
        positionKey: 'removal|g|-',
      }),
    );
    const { rows, totals } = wasteStatsOf(atoms, 'waste');
    /** Exact decimal of `count` large amounts plus `extra` kopecks, converted once. */
    const exactOf = (count: bigint, extra = 0n): number => {
      const text = (99_999_999_899n * count + extra).toString();
      return Number(`${text.slice(0, -2)}.${text.slice(-2)}`);
    };
    expect(rows.map((r) => r.objectId)).toEqual(['ob-0', 'ob-1', 'ob-2']);
    for (const row of rows) expect(row.doneCost, row.objectId).toBe(exactOf(15_000n));
    expect(totals.doneCost).toBe(exactOf(45_000n));
    expect(totals.totalCost).toBe(exactOf(45_000n, 1n));
    expect(totals.totalCost).toBeGreaterThan(2 ** 45);
    expect(totals.costEstimated).toBe(0.01);
  });
});
