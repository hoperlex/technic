import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  calcWasteAmount,
  createWasteRequestSchema,
  isPricedRequestType,
  isVolumeAllowed,
  pickWasteTariff,
  PRICED_REQUEST_TYPES,
  volumeStepMessage,
  type WasteTariffCandidate,
} from '@technic/contracts';

const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONTAINER_TYPE_ID = '22222222-2222-4222-8222-222222222222';
const WASTE_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const DELIVERY_AT = '2026-08-01T10:00:00.000Z';

// Создание заявки проверяет минимальную дату (не раньше сегодня по МСК) — «сейчас» фиксируем,
// иначе фикстура с датой доставки протухла бы вместе с календарём.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-31T09:00:00.000Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('тарифицируемые операции (ADR 0019)', () => {
  it('контейнерные операции не тарифицируются', () => {
    expect(isPricedRequestType('container_install')).toBe(false);
    expect(isPricedRequestType('container_replace')).toBe(false);
    expect(isPricedRequestType('container_removal')).toBe(false);
  });

  it('тарифицируется один вывоз мусора', () => {
    expect(isPricedRequestType('waste_removal')).toBe(true);
    expect(PRICED_REQUEST_TYPES).toEqual(['waste_removal']);
  });
});

describe('расчёт суммы', () => {
  it('объём × цена за м³', () => {
    expect(calcWasteAmount(20, 900)).toBe(18000);
    // Прайс п.3: 15 000 ₽ за контейнер 8 м³ → 1875 ₽/м³; два контейнера — ровно две цены.
    expect(calcWasteAmount(8, 1875)).toBe(15000);
    expect(calcWasteAmount(16, 1875)).toBe(30000);
  });

  it('округляет до копеек', () => {
    expect(calcWasteAmount(3, 33.333)).toBe(100);
    expect(calcWasteAmount(1, 0.005)).toBe(0.01);
  });
});

describe('кратность объёма', () => {
  it('без шага допустим любой объём (цена за м³)', () => {
    expect(isVolumeAllowed(13, null)).toBe(true);
    expect(isVolumeAllowed(13, 0)).toBe(true);
  });

  it('с шагом объём должен быть кратен вместимости контейнера', () => {
    expect(isVolumeAllowed(8, 8)).toBe(true);
    expect(isVolumeAllowed(24, 8)).toBe(true);
    expect(isVolumeAllowed(12, 8)).toBe(false);
    expect(isVolumeAllowed(20, 8)).toBe(false);
  });

  it('сообщение называет вместимость', () => {
    expect(volumeStepMessage(8)).toContain('8');
  });
});

describe('createWasteRequestSchema: тип мусора и объём', () => {
  const base = { objectId: OBJECT_ID, containerTypeId: CONTAINER_TYPE_ID, deliveryAt: DELIVERY_AT };

  // Контейнерные операции не тарифицируются (ADR 0019): им хватает типа контейнера.
  it.each(['container_install', 'container_replace', 'container_removal'] as const)(
    '%s не требует ни типа мусора, ни объёма',
    (requestType) => {
      const parsed = createWasteRequestSchema.parse({ ...base, requestType });
      expect(parsed.wasteTypeId).toBeUndefined();
      expect(parsed.volumeM3).toBeUndefined();
    },
  );

  it('вывоз требует и тип мусора, и объём', () => {
    expect(() =>
      createWasteRequestSchema.parse({ ...base, requestType: 'waste_removal' }),
    ).toThrow();
    // Только объём — без типа мусора цену взять неоткуда.
    expect(() =>
      createWasteRequestSchema.parse({ ...base, requestType: 'waste_removal', volumeM3: 20 }),
    ).toThrow();
    // Только тип мусора — сколько вывезти, и есть предмет заявки.
    expect(() =>
      createWasteRequestSchema.parse({
        ...base,
        requestType: 'waste_removal',
        wasteTypeId: WASTE_TYPE_ID,
      }),
    ).toThrow();

    const parsed = createWasteRequestSchema.parse({
      ...base,
      requestType: 'waste_removal',
      wasteTypeId: WASTE_TYPE_ID,
      volumeM3: 20,
    });
    expect(parsed.wasteTypeId).toBe(WASTE_TYPE_ID);
    expect(parsed.volumeM3).toBe(20);
  });

  // Техника в заявку на вывоз не входит (ADR 0022): чем увезут объём, решает оператор.
  it('вывоз техники не требует', () => {
    const parsed = createWasteRequestSchema.parse({
      objectId: OBJECT_ID,
      deliveryAt: DELIVERY_AT,
      requestType: 'waste_removal',
      wasteTypeId: WASTE_TYPE_ID,
      volumeM3: 20,
    });
    expect(parsed.containerTypeId).toBeUndefined();
  });
});


// ── Выбор позиции прайса между операторами (ADR 0023) ──

const TRANS = 'op-trans-invest';
const TRINITY = 'op-trinity';

/** Позиция прайса на вид техники — то, чем тарифицируется вывоз (ADR 0022). */
function byKind(id: string, operator: string, price: number): WasteTariffCandidate {
  return {
    id,
    operatorCounterpartyId: operator,
    containerTypeId: null,
    containerKind: 'truck',
    pricePerM3: price,
  };
}

describe('pickWasteTariff: чей прайс применяется', () => {
  const candidates = [byKind('t1', TRANS, 900), byKind('t2', TRINITY, 700)];

  it('оператор назначен — его цена, без пометки «от»', () => {
    const picked = pickWasteTariff(candidates, { operatorCounterpartyId: TRANS });
    expect(picked?.tariff.id).toBe('t1');
    expect(picked?.isMinimum).toBe(false);
  });

  it('оператора нет — минимальная цена, помеченная как «от»', () => {
    const picked = pickWasteTariff(candidates, {});
    expect(picked?.tariff.id).toBe('t2');
    expect(picked?.isMinimum).toBe(true);
  });

  // «от» обещает, что цена может вырасти. Когда все просят одинаково, обещать нечего.
  it('цены операторов равны — «от» не ставится', () => {
    const picked = pickWasteTariff([byKind('t1', TRANS, 700), byKind('t2', TRINITY, 700)], {});
    expect(picked?.isMinimum).toBe(false);
  });

  it('при равных ценах выбор не зависит от порядка строк', () => {
    const same = [byKind('t2', TRINITY, 700), byKind('t1', TRANS, 700)];
    expect(pickWasteTariff(same, {})?.tariff.id).toBe('t1');
    expect(pickWasteTariff([...same].reverse(), {})?.tariff.id).toBe('t1');
  });

  it('у оператора нет цены на эту пару — подбор пуст', () => {
    expect(pickWasteTariff([byKind('t1', TRANS, 900)], { operatorCounterpartyId: TRINITY })).toBe(
      null,
    );
    expect(pickWasteTariff([], {})).toBe(null);
  });

  // Правило ADR 0009 внутри оператора не отменяется: точная цена на тип побеждает цену вида.
  it('точная цена на тип побеждает цену вида — у каждого оператора отдельно', () => {
    const exact: WasteTariffCandidate = {
      id: 'exact',
      operatorCounterpartyId: TRANS,
      containerTypeId: 'ct-8',
      containerKind: null,
      pricePerM3: 1875,
    };
    const rows = [byKind('t1', TRANS, 900), exact, byKind('t2', TRINITY, 1500)];
    const own = pickWasteTariff(rows, { operatorCounterpartyId: TRANS, containerTypeId: 'ct-8' });
    expect(own?.tariff.id).toBe('exact');
    // Без оператора сравниваются уже отобранные позиции: 1875 против 1500.
    const cheapest = pickWasteTariff(rows, { containerTypeId: 'ct-8' });
    expect(cheapest?.tariff.id).toBe('t2');
    expect(cheapest?.isMinimum).toBe(true);
  });
});
