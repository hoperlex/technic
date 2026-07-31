import { describe, expect, it } from 'vitest';
import {
  type BackfillWaybill,
  pickCanonicalWaybill,
  planBackfill,
} from '../src/services/route-backfill';

/**
 * Перенос истории путевых листов в рейсы (план `docs/vehicle-routes-plan.md`, §3.4).
 *
 * Скрипт запускается один раз на живой базе, и ошибиться в нём дороже, чем в обычном коде:
 * неверно выбранный лист либо роняет уникальность талонов, либо отбирает заявку у рейса, чей
 * бланк водитель уже возит с собой. Поэтому правила выбора вынесены чистыми функциями и
 * проверяются здесь — на тех самых случаях, из-за которых наивный перенос падал.
 */

const VEHICLE_A = 'v-a';
const VEHICLE_B = 'v-b';

function waybill(over: Partial<BackfillWaybill> & { id: string }): BackfillWaybill {
  return {
    vehicleId: VEHICLE_A,
    issuedForDate: '2026-08-03',
    number: 1,
    cancelled: false,
    requests: [],
    ...over,
  };
}

describe('канонический лист пары «машина + дата»', () => {
  it('действующий побеждает аннулированный, даже если тот свежее по дате и номеру', () => {
    const cancelled = waybill({ id: 'w-cancelled', number: 99, cancelled: true });
    const active = waybill({ id: 'w-active', number: 7 });
    expect(pickCanonicalWaybill([cancelled, active])?.id).toBe('w-active');
  });

  it('без действующего берётся последний аннулированный — по дате, затем по номеру', () => {
    const older = waybill({ id: 'w-1', number: 5, cancelled: true });
    const newer = waybill({ id: 'w-2', number: 6, cancelled: true });
    expect(pickCanonicalWaybill([older, newer])?.id).toBe('w-2');
  });

  it('пара без листов канонического не имеет', () => {
    expect(pickCanonicalWaybill([])).toBeNull();
  });
});

describe('состав рейса при переносе', () => {
  it('берётся только из канонического листа: две первые позиции в одном рейсе невозможны', () => {
    // Ровно тот случай, на котором падал наивный перенос: у аннулированного листа заявка A на
    // первом талоне, у действующего — заявка B тоже на первом.
    const plan = planBackfill([
      waybill({
        id: 'w-old',
        number: 1,
        cancelled: true,
        requests: [{ requestId: 'r-a', slot: 1 }],
      }),
      waybill({ id: 'w-new', number: 2, requests: [{ requestId: 'r-b', slot: 1 }] }),
    ]);

    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]!.requests).toEqual([{ requestId: 'r-b', position: 1 }]);
    // Оба листа при этом привязываются к рейсу: аннулированный остаётся в журнале при своём рейсе.
    expect(plan.routes[0]!.waybillIds.sort()).toEqual(['w-new', 'w-old']);
  });

  it('позиции уплотняются в 1…N: дыра в талонах означала бы пустую графу бланка', () => {
    const plan = planBackfill([
      waybill({
        id: 'w-1',
        requests: [
          { requestId: 'r-a', slot: 2 },
          { requestId: 'r-b', slot: 4 },
        ],
      }),
    ]);
    expect(plan.routes[0]!.requests).toEqual([
      { requestId: 'r-a', position: 1 },
      { requestId: 'r-b', position: 2 },
    ]);
  });

  it('состав сверх четырёх талонов в рейс не попадает и виден отчётом', () => {
    const plan = planBackfill([
      waybill({
        id: 'w-1',
        requests: [1, 2, 3, 4, 5].map((n) => ({ requestId: `r-${n}`, slot: n })),
      }),
    ]);
    expect(plan.routes[0]!.requests).toHaveLength(4);
    expect(plan.overflow[0]!.requestIds).toEqual(['r-5']);
  });
});

describe('одна заявка в канонических листах разных пар', () => {
  const active = waybill({
    id: 'w-active',
    vehicleId: VEHICLE_A,
    issuedForDate: '2026-08-03',
    number: 10,
    requests: [{ requestId: 'r-x', slot: 1 }],
  });
  const cancelledLater = waybill({
    id: 'w-cancelled',
    vehicleId: VEHICLE_B,
    issuedForDate: '2026-08-05',
    number: 20,
    cancelled: true,
    requests: [{ requestId: 'r-x', slot: 1 }],
  });

  it('заявку забирает действующий лист, даже если аннулированный свежее', () => {
    const plan = planBackfill([active, cancelledLater]);
    const withRequest = plan.routes.filter((r) => r.requests.length > 0);

    expect(withRequest).toHaveLength(1);
    expect(withRequest[0]!.vehicleId).toBe(VEHICLE_A);
    // Проигравший рейс заводится всё равно — его лист лежит в журнале и обязан иметь свой рейс.
    expect(plan.routes).toHaveLength(2);
    expect(plan.droppedLinks[0]).toMatchObject({ requestId: 'r-x' });
  });

  it('без действующих побеждает более поздний по дате и номеру', () => {
    const older = waybill({
      id: 'w-old',
      vehicleId: VEHICLE_A,
      issuedForDate: '2026-08-03',
      number: 10,
      cancelled: true,
      requests: [{ requestId: 'r-x', slot: 1 }],
    });
    const plan = planBackfill([older, cancelledLater]);
    const withRequest = plan.routes.filter((r) => r.requests.length > 0);
    expect(withRequest[0]!.vehicleId).toBe(VEHICLE_B);
  });
});

describe('перенос на живой базе', () => {
  it('заявку, уже стоящую в рейсе нового API, не трогает', () => {
    const plan = planBackfill(
      [waybill({ id: 'w-1', requests: [{ requestId: 'r-a', slot: 1 }] })],
      new Set(['r-a']),
    );
    // Рейс истории заводится (лист обязан его получить), но заявку из живого рейса не забирает.
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]!.requests).toEqual([]);
  });

  it('пустой вход не заводит ничего: повторный запуск ничего не дублирует', () => {
    expect(planBackfill([])).toEqual({ routes: [], droppedLinks: [], overflow: [] });
  });
});
