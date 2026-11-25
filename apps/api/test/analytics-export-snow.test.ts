import { describe, expect, it, vi } from 'vitest';
import { readWorkbook, type SheetOutput } from '../src/lib/xlsx';
import type { AnalyticsAtom } from '../src/services/analytics/types';

/**
 * The summary book with snow (snow-removal plan, S9, §3.4) over known atoms: the «Снег» position
 * of the waste module, its money in the methodology, and the combined money cells written in the
 * precision of the xlsx number format. What the loader counts is the db test's subject
 * (`snow-stats.db.test.ts`, which also reads the actual export of the route).
 */

const OB = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({ atoms: [] as unknown[] }));

vi.mock('../src/services/analytics/summary', () => ({
  assertAnalyticsQuery: () => undefined,
  loadAnalyticsAtoms: async () => ({ atoms: state.atoms, quality: [] }),
}));

const { buildAnalyticsExport } = await import('../src/services/analytics-export');

function atom(over: Partial<AnalyticsAtom>): AnalyticsAtom {
  return {
    module: 'waste',
    customerKind: 'object',
    customerId: OB,
    customerCode: 'ОБ-014',
    customerName: 'Северная 12',
    customerIsActive: true,
    payerDepartmentId: null,
    payerDepartmentName: null,
    date: '2041-11-10',
    positionKey: 'removal|snow|-',
    positionLabel: 'Снег',
    registrationNumber: null,
    requestId: 'r1',
    requestLabel: 'М-1',
    requestStatus: 'done',
    shifts: 0,
    planShifts: 0,
    trips: 0,
    volumeM3: 0,
    volumeOrderedM3: 0,
    volumeTicketsM3: 0,
    volumeTicketsUnpricedM3: 0,
    volumeTicketsUnconfirmedM3: 0,
    volumePlannedM3: 0,
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
    removals: 0,
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

async function book(atoms: AnalyticsAtom[]): Promise<SheetOutput[]> {
  state.atoms = atoms;
  const result = await buildAnalyticsExport({
    from: '2041-11-01',
    to: '2041-11-30',
    step: 'month',
  });
  return readWorkbook(result.bytes);
}

function sheet(sheets: SheetOutput[], name: string): string[][] {
  const found = sheets.find((item) => item.name === name);
  if (!found) throw new Error(`Лист «${name}» не найден`);
  return found.rows;
}

describe('сводная книга: вывоз снега', () => {
  it('«Снег» — своя позиция вывоза рядом с мусором, с внесённой суммой и без оценки', async () => {
    const sheets = await book([
      atom({ requestId: 's1', removals: 1, volumeM3: 12, moneyFact: 1500 }),
      atom({ requestId: 's2', removals: 1, volumeM3: 9, priced: false }),
      atom({ requestId: 's3', requestStatus: 'new' }),
      atom({
        requestId: 'g1',
        positionKey: 'removal|garbage|-',
        positionLabel: 'Строительный мусор',
        removals: 1,
        volumeM3: 20,
        moneyFact: 2000,
      }),
      atom({
        requestId: 'g2',
        requestStatus: 'new',
        positionKey: 'removal|garbage|-',
        positionLabel: 'Строительный мусор',
        moneyLow: 1000,
        moneyHigh: 1000,
      }),
    ]);
    const detail = sheet(sheets, 'Детализация');
    const titles = detail[2] ?? [];
    const at = (row: string[] | undefined, title: string): number =>
      Number(row?.[titles.indexOf(title)]);
    const snow = detail.find((row) => row[0] === 'Снег');
    const garbage = detail.find((row) => row[0] === 'Строительный мусор');
    expect(at(snow, 'м³')).toBe(21);
    expect(at(snow, 'Вывозов')).toBe(2);
    expect(at(snow, 'Заявок')).toBe(3);
    expect(at(snow, '₽ факт')).toBe(1500);
    expect(at(snow, '₽ оц. ниж.')).toBe(0);
    expect(at(snow, 'Без цены')).toBe(1);
    expect(at(garbage, '₽ оц. ниж.')).toBe(1000);
    const module = detail.find((row) => row[0] === 'Вывоз мусора');
    expect(at(module, 'м³')).toBe(41);
    expect(at(module, '₽ факт')).toBe(3500);

    const parameters = sheet(sheets, 'Параметры');
    expect(parameters.find((row) => row[0] === 'Вывоз снега')?.[1]).toContain(
      'внесённая при закрытии',
    );
    const method = (title: string): string[] | undefined =>
      parameters.find((row) => row[0] === `Деньги, ₽ · ${title}`);
    expect(method('факт')?.[2]).toContain('вывоза снега');
    expect(method('оценка ниж.')?.[4]).toContain('оценки у него нет');
    expect(method('без цены')?.[1]).toContain('без внесённой суммы');
  });

  it('«итого» выше копеечной точности — ближайшее число к точной сумме, а не сложение ячеек', async () => {
    // Two figures that still hold their kopecks, whose sum (≈ 4·10¹³ ₽) no longer does: the
    // cell must carry the double nearest to the exact decimal, converted once.
    const sheets = await book([
      atom({
        module: 'freight',
        requestId: 'f1',
        positionKey: 'veh-1',
        moneyFact: 20_000_000_000_000.03,
      }),
      atom({
        module: 'freight',
        requestId: 'f2',
        requestStatus: 'confirmed',
        positionKey: 'veh-1',
        moneyLow: 20_000_000_000_000.03,
        moneyHigh: 20_000_000_000_000.03,
      }),
    ]);
    const rows = sheet(sheets, 'Свод');
    const titles = rows[3] ?? [];
    const total = rows.find((row) => row[0] === 'Всего') ?? [];
    const exact = Number('40000000000000.06');
    expect(exact).toBeGreaterThan(2 ** 45);
    expect(Number(total[titles.indexOf('итого ниж.')])).toBe(exact);
    expect(Number(total[titles.indexOf('итого верх.')])).toBe(exact);
    // The hidden data sheet carries the same rule per atom.
    const data = sheet(sheets, 'Данные');
    const money = (data[0] ?? []).indexOf('₽ итого');
    expect(Number(data[2]?.[money])).toBe(20_000_000_000_000.03);
  });
});
