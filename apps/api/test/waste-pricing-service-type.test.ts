import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SNOW_COST_AT_COMPLETION_MESSAGE, SNOW_WASTE_TYPE_ID } from '@technic/contracts';

/**
 * Tariff resolution refuses the service waste type «Снег» before any lookup (snow-removal plan, S6,
 * §3.2). Snow has no price list: a lookup would only answer «no tariff», which reads as a price list
 * not filled in yet, so the refusal must come first and carry the field message.
 *
 * The database is replaced by a spy: the point is that it is never asked.
 */

const select = vi.fn(() => {
  throw new Error('pricing queried the database for the service waste type');
});

vi.mock('../src/db/client', () => ({ db: { select } }));

const { assertPricedWasteType, priceWasteRequest, resolveWasteTariff, resolveWasteTariffByKind } =
  await import('../src/services/waste-pricing');
const { AppError } = await import('../src/lib/errors');

const CONTAINER_TYPE_ID = '22222222-2222-4222-8222-222222222222';
const SPELLINGS = [SNOW_WASTE_TYPE_ID, SNOW_WASTE_TYPE_ID.toUpperCase(), ` ${SNOW_WASTE_TYPE_ID} `];

/** The refusal the portal shows on the waste type field. */
async function expectFieldRefusal(run: Promise<unknown>): Promise<void> {
  const error = await run.then(
    () => {
      throw new Error('the service waste type was priced');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as InstanceType<typeof AppError>).statusCode).toBe(400);
  expect((error as InstanceType<typeof AppError>).fields).toEqual({
    wasteTypeId: SNOW_COST_AT_COMPLETION_MESSAGE,
  });
}

beforeEach(() => {
  select.mockClear();
});

describe('подбор тарифа и служебный тип «Снег»', () => {
  it.each(SPELLINGS)('подбор по виду техники отказывает «%s» до запроса', async (id) => {
    await expectFieldRefusal(resolveWasteTariffByKind(id, 'truck'));
    await expectFieldRefusal(resolveWasteTariffByKind(id, 'truck', CONTAINER_TYPE_ID));
    expect(select).not.toHaveBeenCalled();
  });

  it.each(SPELLINGS)('подбор по типу контейнера отказывает «%s» до запроса', async (id) => {
    await expectFieldRefusal(resolveWasteTariff(id, CONTAINER_TYPE_ID));
    expect(select).not.toHaveBeenCalled();
  });

  it.each(SPELLINGS)('снимок цены вывоза мусора с типом «%s» не считается', async (id) => {
    await expectFieldRefusal(
      priceWasteRequest({
        requestType: 'waste_removal',
        wasteTypeId: id,
        volumeM3: 20,
        operatorCounterpartyId: null,
      }),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('заявка на вывоз снега не тарифицируется: пустой снимок без запроса, а не отказ', async () => {
    await expect(
      priceWasteRequest({
        requestType: 'snow_removal',
        wasteTypeId: SNOW_WASTE_TYPE_ID,
        volumeM3: 8,
        operatorCounterpartyId: null,
      }),
    ).resolves.toEqual({ wasteTariffId: null, pricePerM3: null });
    expect(select).not.toHaveBeenCalled();
  });

  it('обычный тип мусора проходит проверку', () => {
    expect(() => assertPricedWasteType('33333333-3333-4333-8333-333333333333')).not.toThrow();
  });
});
