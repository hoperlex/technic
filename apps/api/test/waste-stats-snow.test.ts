import { describe, expect, it } from 'vitest';
import {
  isManualCostOnly,
  REQUEST_TYPES,
  WASTE_STATS_KINDS,
  wasteFactUnit,
  wasteStatsKindOf,
  wasteStatsQuerySchema,
} from '@technic/contracts';

/**
 * The stats kind of the waste statistics tab (snow-removal plan, S8, §3.4) without a database.
 *
 * The SQL type filter of each kind is derived from `wasteStatsKindOf` and `REQUEST_TYPES`; these
 * checks hold the properties that derivation relies on, so a new request type cannot silently land
 * in the wrong table or mix estimated and invoiced money in one total.
 */

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
