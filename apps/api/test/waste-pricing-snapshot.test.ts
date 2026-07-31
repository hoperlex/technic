import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Снимок цены в заявке на вывоз (ADR 0009 §7) и его главное правило после ADR 0046: незаданный
 * тариф заявку не отменяет. Раньше подбор без результата отвечал 422 — и заявку нельзя было
 * завести вовсе, хотя вывоз нужен раньше, чем цену успевают внести в прайс.
 *
 * Прайс подменён массивом строк: проверяется решение сервиса, а не то, как drizzle собирает SQL.
 */

const WASTE_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const TRANS = '44444444-4444-4444-8444-444444444444';

/** Что вернёт запрос за действующими позициями прайса — задаётся каждым тестом. */
let candidateRows: Record<string, unknown>[] = [];

vi.mock('../src/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => candidateRows }),
      }),
    }),
  },
}));

const { priceWasteRequest } = await import('../src/services/waste-pricing');

/** Позиция прайса на вид техники: вывоз тарифицируется только ею (ADR 0022). */
function tariffRow(id: string, price: number) {
  return {
    id,
    operatorCounterpartyId: TRANS,
    operatorName: 'ТрансИнвест',
    containerTypeId: null,
    containerKind: 'truck',
    // numeric приходит из pg строкой — сервис приводит её сам.
    pricePerM3: String(price),
    isPerContainer: false,
  };
}

const removal = {
  requestType: 'waste_removal' as const,
  wasteTypeId: WASTE_TYPE_ID,
  volumeM3: 20,
  operatorCounterpartyId: null,
};

beforeEach(() => {
  candidateRows = [];
});

describe('priceWasteRequest: снимок цены', () => {
  it('цена в прайсе есть — в заявку ложится тариф и цена за м³', async () => {
    candidateRows = [tariffRow('t1', 900)];
    await expect(priceWasteRequest(removal)).resolves.toEqual({
      wasteTariffId: 't1',
      pricePerM3: '900',
    });
  });

  // Главное в ADR 0046: заявка оформляется, стоимости у неё просто нет.
  it('тарифа на тип мусора нет — снимок пуст, а не отказ', async () => {
    await expect(priceWasteRequest(removal)).resolves.toEqual({
      wasteTariffId: null,
      pricePerM3: null,
    });
  });

  // Прайс у каждого оператора свой (ADR 0026): у назначенного цены может не быть вовсе —
  // назначение исполнителя это тоже больше не отменяет.
  it('у выбранного оператора цены нет — снимок пуст, а не отказ', async () => {
    candidateRows = [tariffRow('t1', 900)];
    await expect(
      priceWasteRequest({ ...removal, operatorCounterpartyId: 'op-other' }),
    ).resolves.toEqual({ wasteTariffId: null, pricePerM3: null });
  });

  // Контейнерные операции не тарифицируются (ADR 0019): подбор для них не запускается.
  it('контейнерная операция — снимок пуст без обращения к прайсу', async () => {
    candidateRows = [tariffRow('t1', 900)];
    await expect(
      priceWasteRequest({ ...removal, requestType: 'container_removal' }),
    ).resolves.toEqual({ wasteTariffId: null, pricePerM3: null });
  });

  // Предмет заявки на вывоз — тип мусора и объём: без них считать нечего, и это по-прежнему
  // ошибка формы, а не молчаливо пустая цена.
  it('вывоз без типа мусора или объёма отвергается', async () => {
    await expect(priceWasteRequest({ ...removal, wasteTypeId: null })).rejects.toThrow();
    await expect(priceWasteRequest({ ...removal, volumeM3: null })).rejects.toThrow();
  });
});
