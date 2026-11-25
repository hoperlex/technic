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

const { assertWasteStatsAudience, loadWasteStats, WASTE_STATS_REQUEST_TYPES } =
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
