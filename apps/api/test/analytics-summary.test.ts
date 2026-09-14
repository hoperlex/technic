import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ANALYTICS_STEPS,
  type AnalyticsModule,
  type AnalyticsQualityEntry,
} from '@technic/contracts';
import type * as RollupModule from '../src/services/analytics/rollup';
import {
  ANALYTICS_ATOM_LIMIT,
  type AnalyticsAtom,
  type AnalyticsFacts,
} from '../src/services/analytics/types';

/**
 * Сборка свода (план `docs/analytics-summary-export-plan.md`, Р13–Р15).
 *
 * База здесь не нужна и не поднимается: что именно считает каждый модуль, проверяют db-тесты
 * загрузчиков, а тут подменены все три — и потому утверждать можно про **сборку**: сходятся ли
 * строки, итог и деньги между собой, в каком порядке приходит качество и что происходит с
 * потолками. Загрузчики подменены целиком, а группировки (`rollup`) оставлены настоящими: тест
 * про то, что свод собран из одного набора атомов, подменённой группировкой ничего не доказал бы.
 *
 * Три потолка проверяются отдельно и каждый со своим следствием: отказ обязан приходить ДО работы,
 * а не после неё, и «до» здесь проверяемо — по тому, звали ли загрузчики и группировки.
 */

const state = vi.hoisted(() => ({
  vehicle: { atoms: [], quality: [] } as AnalyticsFacts,
  waste: { atoms: [], quality: [] } as AnalyticsFacts,
  mech: { atoms: [], quality: [] } as AnalyticsFacts,
  /** Кто из загрузчиков ходил в базу: пустой список и есть «отказ пришёл до запроса». */
  loaded: [] as string[],
  /** Какие группировки успели поработать: ими собираются листы книги и поля ответа. */
  rolled: [] as string[],
}));

vi.mock('../src/services/analytics/facts-vehicle', () => ({
  loadVehicleFacts: async () => {
    state.loaded.push('vehicle');
    return state.vehicle;
  },
}));

vi.mock('../src/services/analytics/facts-waste', () => ({
  loadWasteFacts: async () => {
    state.loaded.push('waste');
    return state.waste;
  },
}));

vi.mock('../src/services/analytics/facts-mech', () => ({
  loadMechFacts: async () => {
    state.loaded.push('mech');
    return state.mech;
  },
}));

/*
 * Группировки настоящие, но с отметкой о вызове: проверяется не их расчёт (для него есть
 * `analytics-rollup.test.ts`), а то, что при переполнении набора до них не доходит вовсе.
 */
vi.mock('../src/services/analytics/rollup', async (importOriginal) => {
  const actual = await importOriginal<typeof RollupModule>();
  return {
    ...actual,
    rollupByCustomer: (...args: Parameters<typeof actual.rollupByCustomer>) => {
      state.rolled.push('customer');
      return actual.rollupByCustomer(...args);
    },
    rollupByPeriod: (...args: Parameters<typeof actual.rollupByPeriod>) => {
      state.rolled.push('period');
      return actual.rollupByPeriod(...args);
    },
    totalsByModule: (...args: Parameters<typeof actual.totalsByModule>) => {
      state.rolled.push('totals');
      return actual.totalsByModule(...args);
    },
  };
});

const { buildAnalyticsSummary } = await import('../src/services/analytics/summary');

/** Атом с обнулёнными счётчиками: тест дописывает только те числа, про которые говорит. */
function atom(patch: Partial<AnalyticsAtom> & Pick<AnalyticsAtom, 'module'>): AnalyticsAtom {
  return {
    customerKind: 'object',
    customerId: 'obj-1',
    customerCode: 'ОБ-014',
    customerName: 'Северная, 12',
    customerIsActive: true,
    payerDepartmentId: null,
    payerDepartmentName: null,
    date: '2026-08-10',
    positionKey: 'pos-1',
    positionLabel: 'Позиция',
    registrationNumber: null,
    requestId: 'req-1',
    requestLabel: 'ТС-40',
    requestStatus: 'done',
    shifts: 0,
    /*
     * План заполняется наравне с прочими счётчиками, и пропустить его нельзя: каталог `test` не
     * входит в `tsconfig.json` сервера, поэтому недостающее поле фикстуры не поймает ни `tsc`, ни
     * прогон — `0 + undefined` даёт `NaN`, который спокойно доезжает до книги. Один раз он тут уже
     * лежал, и не заметил его никто ровно потому, что план в этом файле нигде не проверялся.
     */
    planShifts: 0,
    trips: 0,
    volumeM3: 0,
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
    priced: true,
    ...patch,
  };
}

function quality(key: string): AnalyticsQualityEntry {
  return { key, label: key, value: 1, outOf: null, note: '' };
}

beforeEach(() => {
  state.vehicle = { atoms: [], quality: [] };
  state.waste = { atoms: [], quality: [] };
  state.mech = { atoms: [], quality: [] };
  state.loaded = [];
  state.rolled = [];
});

describe('свод аналитики: потолки', () => {
  it('период длиннее года отвергается до обращения в базу', async () => {
    await expect(
      buildAnalyticsSummary({ from: '2025-01-01', to: '2026-06-30', step: 'month' }),
    ).rejects.toThrow(/Период больше года/);
    // Ради отказа не должно быть сделано ни одной выборки: иначе «с 2000 года» упрётся в память
    // процесса, а не в сообщение человеку.
    expect(state.loaded).toEqual([]);
  });

  it('шагов больше потолка — отказ, тоже до базы', async () => {
    // Год по неделям законен (Р26), а 366 дней, начатых в воскресенье, дают 54 недели — на одну
    // больше потолка: именно это сочетание и обязано упереться в отказ.
    await expect(
      buildAnalyticsSummary({ from: '2026-01-04', to: '2027-01-04', step: 'week' }),
    ).rejects.toThrow(new RegExp(`предел — ${MAX_ANALYTICS_STEPS}`));
    expect(state.loaded).toEqual([]);
  });

  it('атомов больше потолка — отказ словами «сузьте период», до сборки листов', async () => {
    const one = atom({ module: 'freight' });
    state.vehicle = {
      atoms: new Array<AnalyticsAtom>(ANALYTICS_ATOM_LIMIT + 1).fill(one),
      quality: [],
    };

    await expect(
      buildAnalyticsSummary({ from: '2026-08-01', to: '2026-08-31', step: 'month' }),
    ).rejects.toThrow(/сузьте период/);

    // Выборки при этом состоялись — потолок считается по набору, — а вот сборка не началась: отказ
    // после сборки книги, которую всё равно не отдадут, и есть то, что запрещает Р15.
    expect(state.loaded).toHaveLength(3);
    expect(state.rolled).toEqual([]);
  });
});

describe('свод аналитики: сборка', () => {
  beforeEach(() => {
    state.vehicle = {
      atoms: [
        atom({ module: 'freight', shifts: 1, trips: 4, volumeM3: 40, moneyFact: 1000 }),
        atom({
          module: 'onsite',
          customerId: 'dep-1',
          customerKind: 'department',
          customerCode: 'ОТД-03',
          customerName: 'Снабжение',
          requestId: 'req-2',
          date: '2026-09-02',
          shifts: 2,
          planShifts: 1,
          engineHours: 9,
          moneyFact: 0,
          moneyLow: 500,
          moneyHigh: 800,
          priced: false,
        }),
        // Перегон техники к площадке (Р27): ни смены, ни плана, ни единицы парка — один счётчик.
        // Он же и держит фикстуру честной: атом без плана в наборе обязан быть, иначе поле,
        // забытое в заготовке, сложится с чем угодно и не заметит этого никто.
        atom({
          module: 'onsite',
          customerId: 'dep-1',
          customerKind: 'department',
          customerCode: 'ОТД-03',
          customerName: 'Снабжение',
          requestId: 'req-2',
          date: '2026-09-04',
          positionKey: 'pos-2',
          positionLabel: 'Тягач',
          relocations: 1,
          priced: false,
        }),
        // День срока, до которого смена не дошла (Р7, Р29): плана он прибавляет, факта — нет.
        // Без такого атома в наборе «план 3, факт 2» не отличить от «план = факт», и разница, ради
        // которой колонка заведена, проверялась бы нулём против нуля.
        atom({
          module: 'onsite',
          customerId: 'dep-1',
          customerKind: 'department',
          customerCode: 'ОТД-03',
          customerName: 'Снабжение',
          requestId: 'req-2',
          date: '2026-09-03',
          planShifts: 2,
          moneyHigh: 400,
          priced: false,
        }),
      ],
      quality: [quality('vehicle.shifts_without_visa')],
    };
    state.waste = {
      atoms: [
        atom({
          module: 'waste',
          requestId: 'req-3',
          date: '2026-09-20',
          removals: 3,
          volumeM3: 60,
          moneyFact: 700,
        }),
      ],
      quality: [quality('waste.removals_without_ticket')],
    };
    state.mech = {
      atoms: [
        atom({
          module: 'mech',
          requestId: 'req-4',
          date: '2026-08-15',
          mechDays: 5,
          moneyLow: 300,
          moneyHigh: 300,
        }),
      ],
      quality: [quality('mech.rents_without_final_cost')],
    };
  });

  it('строки, итог и деньги сходятся между собой', async () => {
    const dto = await buildAnalyticsSummary({
      from: '2026-08-01',
      to: '2026-09-30',
      step: 'month',
    });

    expect(dto.rows.map((row) => row.code)).toEqual(['ОБ-014', 'ОТД-03']);
    // Итог считается из атомов, а не сложением строк ответа (Р13), и именно поэтому равенство с
    // суммой строк — утверждение, а не тавтология: разойдись два пути к числу, свод перестал бы
    // отвечать сам себе.
    const sumRows = (field: 'fact' | 'low' | 'high') =>
      dto.rows.reduce((total, row) => total + row.money[field], 0);
    expect(dto.money.fact).toBe(sumRows('fact'));
    expect(dto.money.low).toBe(sumRows('low'));
    expect(dto.money.high).toBe(sumRows('high'));
    expect(dto.money.fact).toBe(1700);
    // «Без цены» считается по заявкам: одна неоценённая заявка обязана остаться одной.
    expect(dto.money.unpriced).toBe(1);

    const shiftsOf = (module: AnalyticsModule) => dto.totals[module].shifts;
    expect(shiftsOf('freight')).toBe(1);
    expect(shiftsOf('onsite')).toBe(2);
    /*
     * План проверяется наравне с фактом, и это не дублирование `analytics-rollup`: пока свод не
     * спрашивал про план, незаполненное поле фикстуры складывалось в `NaN` — и прогон оставался
     * зелёным ровно потому, что числа этой колонки никто не читал. Колонка, которую не проверяет
     * ни один тест, ломается молча, и первым её читателем оказывается заказчик.
     */
    expect(dto.totals.onsite.planShifts).toBe(3);
    expect(dto.rows.find((row) => row.code === 'ОТД-03')?.byModule.onsite.planShifts).toBe(3);
    expect(dto.periodRows[1]?.byModule.onsite.planShifts).toBe(3);
    // Единицу даёт только атом со сменой (Р8): ни день срока без смены, ни перегон тягачом парка
    // площадке не прибавляют — иначе «смен 2 · ед. 3» объявило бы работавшими три машины.
    expect(dto.totals.onsite.units).toBe(1);
    expect(dto.totals.onsite.relocations).toBe(1);
    // У прочих разрядов плана не бывает вовсе, и ноль на его месте читался бы как «срок нулевой».
    for (const module of ['freight', 'waste', 'mech'] as const) {
      expect(dto.totals[module].planShifts, module).toBeNull();
    }
    expect(dto.totals.waste.removals).toBe(3);
    expect(dto.totals.mech.mechDays).toBe(5);
    // Объём вывоза и объём перевозок в одну колонку не складываются (Р17) — разные разряды.
    expect(dto.totals.freight.volumeM3).toBe(40);
    expect(dto.totals.waste.volumeM3).toBe(60);

    // Динамика собрана из тех же атомов: сумма по шагам обязана сойтись со сводом до копейки.
    expect(dto.periods.map((period) => period.key)).toEqual(['2026-08', '2026-09']);
    const byPeriod = dto.periodRows.reduce((total, row) => total + row.money.fact, 0);
    expect(byPeriod).toBe(dto.money.fact);
    expect(dto.periodRows[0]?.money.fact).toBe(1000);
  });

  it('качество приходит от всех трёх модулей и в порядке модулей', async () => {
    const dto = await buildAnalyticsSummary({
      from: '2026-08-01',
      to: '2026-09-30',
      step: 'month',
    });

    // Порядок — модулей, а не ответов: лист читают сверху вниз, и строки не должны переставляться
    // от того, какая выборка сегодня оказалась быстрее.
    expect(dto.quality.map((entry) => entry.key)).toEqual([
      'vehicle.shifts_without_visa',
      'waste.removals_without_ticket',
      'mech.rents_without_final_cost',
    ]);
  });
});
