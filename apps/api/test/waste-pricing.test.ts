import { describe, expect, it } from 'vitest';
import {
  calcWasteAmount,
  createWasteRequestSchema,
  isPricedRequestType,
  isVolumeAllowed,
  PRICED_REQUEST_TYPES,
  volumeStepMessage,
} from '@technic/contracts';

const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONTAINER_TYPE_ID = '22222222-2222-4222-8222-222222222222';
const WASTE_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const DELIVERY_AT = '2026-08-01T10:00:00.000Z';

describe('тарифицируемые операции (ADR 0009)', () => {
  it('установка нового контейнера не тарифицируется', () => {
    expect(isPricedRequestType('container_install')).toBe(false);
  });

  it('замена, снятие и вывоз тарифицируются', () => {
    for (const t of PRICED_REQUEST_TYPES) expect(isPricedRequestType(t)).toBe(true);
    expect(PRICED_REQUEST_TYPES).toHaveLength(3);
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

  it('установка не требует тип мусора и объём', () => {
    const parsed = createWasteRequestSchema.parse({ ...base, requestType: 'container_install' });
    expect(parsed.wasteTypeId).toBeUndefined();
    expect(parsed.volumeM3).toBeUndefined();
  });

  it.each(PRICED_REQUEST_TYPES)('%s требует тип мусора', (requestType) => {
    expect(() => createWasteRequestSchema.parse({ ...base, requestType })).toThrow();
    expect(() => createWasteRequestSchema.parse({ ...base, requestType, volumeM3: 20 })).toThrow();
  });

  // Замена и снятие вывозят контейнер целиком: объём равен его вместимости и приходит
  // из справочника, а не от клиента.
  it.each(['container_replace', 'container_removal'] as const)(
    '%s объём не требует — его даёт вместимость контейнера',
    (requestType) => {
      const parsed = createWasteRequestSchema.parse({
        ...base,
        requestType,
        wasteTypeId: WASTE_TYPE_ID,
      });
      expect(parsed.wasteTypeId).toBe(WASTE_TYPE_ID);
      expect(parsed.volumeM3).toBeUndefined();
    },
  );

  it('вывоз самосвалами требует объём: сколько вывезти — предмет заявки', () => {
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
    expect(parsed.volumeM3).toBe(20);
  });
});
