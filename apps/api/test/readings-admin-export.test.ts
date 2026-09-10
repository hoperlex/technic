import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import type { VehicleReadingStatsRow } from '@technic/contracts';
import { readWorkbook } from '../src/lib/xlsx';

/**
 * Служебная книга показаний (`docs/readings-admin-export-plan.md`).
 *
 * Проверяется состав книги, а не расчёт: пробег, наработку и счётчики смен считает агрегат
 * (`readings-aggregate.db.test.ts`), строки смен собирает выборка журнала. Здесь оба подменены,
 * поэтому книга собирается из известных чисел — и утверждать можно про неё саму: какие листы, в
 * каком порядке машины, где зелёная строка, как посчитан расход и что попало в сводную.
 *
 * Разбирается книга тем же `readWorkbook`, которым портал читает чужие книги: проверять байты zip
 * бессмысленно, а состав листов — ровно то, что увидит человек, открывший файл.
 */

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  stats: [] as unknown[],
  rows: [] as Record<string, unknown>[],
  total: 0,
}));

vi.mock('../src/services/readings-aggregate', () => ({
  loadFleetStats: async () => state.stats,
}));

vi.mock('../src/services/readings-export', () => ({
  countJournalRows: async () => state.total,
  loadJournalRows: async () => state.rows,
  READING_EXPORT_ROW_LIMIT: 50_000,
}));

const { buildAdminReadingsExport } = await import('../src/services/readings-admin-export');

/** Машина «без нареканий»: все смены закрыты, ряд цел, отчёты приняты. */
function cleanVehicle(): VehicleReadingStatsRow {
  return {
    vehicleId: V1,
    vehicleLabel: 'А123БВ797',
    distanceKm: 493,
    engineHours: 17,
    lastOdometer: { value: 213_268, measuredOn: '2026-08-04' },
    lastEngineHours: { value: 4798.5, measuredOn: '2026-08-04' },
    fuelFilledLiters: 200,
    gaps: 0,
    typeName: 'Самосвал',
    modelName: 'КамАЗ 65115',
    ownership: 'own',
    shifts: 2,
    missingReadings: 0,
    unacceptedShifts: 0,
  };
}

/** Машина с вопросами: смена не сдана, ряд рвался, отчёт не принят. */
function dirtyVehicle(): VehicleReadingStatsRow {
  return {
    vehicleId: V2,
    vehicleLabel: 'М456ОР197',
    distanceKm: null,
    engineHours: 6,
    lastOdometer: null,
    lastEngineHours: { value: 2980, measuredOn: '2026-08-06' },
    fuelFilledLiters: 300,
    gaps: 2,
    typeName: 'Самосвал',
    modelName: 'КамАЗ 6520',
    ownership: 'own',
    shifts: 3,
    missingReadings: 1,
    unacceptedShifts: 1,
  };
}

function shift(over: Record<string, unknown>): Record<string, unknown> {
  return {
    vehicleId: V1,
    ownership: 'own',
    description: '',
    registrationNumber: 'А123БВ797',
    categoryName: 'Самосвал',
    typeName: 'Самосвал',
    modelName: 'КамАЗ 65115',
    reportDate: '2026-08-03',
    shiftOrder: 1,
    reportState: 'accepted',
    sourceKind: 'route',
    routeNum: 145,
    waybillNumber: null,
    waybillPrefix: null,
    waybillNumberWidth: null,
    personName: 'Иванов Иван Иванович',
    readingId: 'r1',
    kind: 'numbers',
    odometerKm: 213_020,
    engineHours: '4790.0',
    fuelFilledLiters: '200.0',
    fuelStartLiters: '180.0',
    fuelEndLiters: '150.0',
    noDataReason: null,
    comment: null,
    source: 'driver',
    odometerAnomaly: null,
    odometerAnomalyConfirmedAt: null,
    engineHoursAnomaly: null,
    engineHoursAnomalyConfirmedAt: null,
    previousOdometerKm: 212_775,
    previousEngineHours: '4781.5',
    ...over,
  };
}

async function book() {
  const result = await buildAdminReadingsExport({
    from: '2026-08-01',
    to: '2026-08-31',
    actor: 'Петров П.П. (admin@dev.local)',
    at: '10.09.2026, 14:32',
  });
  return { result, sheets: readWorkbook(result.bytes) };
}

function sheet(sheets: { name: string; rows: string[][] }[], name: string) {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`нет листа «${name}»: ${sheets.map((s) => s.name).join(', ')}`);
  return found.rows;
}

beforeEach(() => {
  // Порядок в ответе агрегата намеренно «неправильный»: книга обязана поставить чистую машину
  // первой сама (Р7), а не унаследовать порядок расчёта.
  state.stats = [dirtyVehicle(), cleanVehicle()];
  state.rows = [
    shift({}),
    shift({ reportDate: '2026-08-04', odometerKm: 213_268, previousOdometerKm: 213_020 }),
    shift({
      vehicleId: V2,
      registrationNumber: 'М456ОР197',
      modelName: 'КамАЗ 6520',
      reportDate: '2026-08-06',
      personName: 'Кузнецов Алексей Алексеевич',
      odometerKm: 187_100,
      previousOdometerKm: null,
      engineHours: '2980.0',
      previousEngineHours: '2974.0',
      fuelStartLiters: null,
      fuelEndLiters: null,
      fuelFilledLiters: '300.0',
      odometerAnomaly: 'counter_reset',
      source: 'staff',
      comment: 'замена прибора',
    }),
  ];
  state.total = state.rows.length;
});

describe('служебная книга показаний', () => {
  it('собирает пять листов и называет файл периодом', async () => {
    const { result, sheets } = await book();

    expect(sheets.map((s) => s.name)).toEqual([
      'Свод',
      'Детализация',
      'Сводная',
      'Параметры',
      'Данные',
    ]);
    expect(result.filename).toBe('Показания автотранспорта 01.08.2026 – 31.08.2026.xlsx');
  });

  it('ставит машину без нареканий первой и называет нарекания словами', async () => {
    const rows = sheet((await book()).sheets, 'Свод');

    // Строка 1 — заголовок с периодом, строка 3 — шапка, машины с четвёртой (§3.1).
    expect(rows[0]?.[0]).toBe('Показания автотранспорта за 01.08.2026 – 31.08.2026');
    expect(rows[2]?.[0]).toBe('Техника');
    expect(rows[3]?.[0]).toBe('А123БВ797');
    expect(rows[3]?.at(-1)).toBe('—');
    expect(rows[4]?.[0]).toBe('М456ОР197');
    expect(rows[4]?.at(-1)).toBe(
      'не сдано 1 смену; 2 разрыва ряда; 1 аномалия; не принято 1 отчёт',
    );
  });

  it('считает расход по сменам с остатками и называет охват', async () => {
    const rows = sheet((await book()).sheets, 'Свод');
    const clean = rows[3] ?? [];
    const dirty = rows[4] ?? [];

    // 180 + 200 − 150 = 230 за смену, двумя сменами — 460.
    expect(clean[15]).toBe('460');
    expect(clean[16]).toBe('2 из 2');
    // Остатков не передавали ни разу: прочерк, а не ноль, и охват это объясняет.
    expect(dirty[15]).toBe('—');
    expect(dirty[16]).toBe('0 из 1');
  });

  it('прочерк неизвестного не превращается в ноль', async () => {
    const rows = sheet((await book()).sheets, 'Свод');

    // У машины с разорванным рядом пробега нет вовсе, а последнего одометра в периоде не снимали.
    expect(rows[4]?.[8]).toBe('—');
    expect(rows[4]?.[10]).toBe('—');
  });

  it('детализацию делит по машинам заголовком и итогом, без колонки «Техника»', async () => {
    const rows = sheet((await book()).sheets, 'Детализация');

    expect(rows[2]?.[0]).toBe('Дата');
    expect(rows[2]).not.toContain('Техника');
    expect(rows[3]?.[0]).toBe(
      'А123БВ797 — КамАЗ 65115, Самосвал · смен 2, отчитались 2 · нареканий нет',
    );
    expect(rows[4]?.[0]).toBe('03.08.2026');
    expect(rows[4]?.[2]).toBe('Иванов И.И.');
    expect(rows[6]?.[0]).toBe('Итого по машине');
    // Заголовок второй машины несёт её нарекания — теми же словами, что колонка свода.
    expect(rows[8]?.[0]).toContain('не сдано 1 смену');
  });

  it('в скрытом источнике сводной машина стоит колонкой, а неизвестное — пусто', async () => {
    const rows = sheet((await book()).sheets, 'Данные');

    expect(rows[0]).toEqual([
      'Техника',
      'Тип',
      'Месяц',
      'Дата',
      'Водитель',
      'Пробег, км',
      'Наработка, м/ч',
      'Заправлено, л',
      'Расход, л',
      'Показание',
      'Отчёт',
    ]);
    expect(rows[1]?.[0]).toBe('А123БВ797');
    expect(rows[1]?.[2]).toBe('08.2026');
    // У строки со сброшенным счётчиком прироста нет: в источнике это пустая ячейка, иначе поле
    // кэша стало бы смешанным и сводная перестала бы складывать колонку.
    expect(rows[3]?.[5]).toBe('');
  });

  it('кладёт в книгу части сводной таблицы', async () => {
    const { result } = await book();
    const files = Object.keys(unzipSync(result.bytes));

    expect(files).toContain('xl/pivotCache/pivotCacheDefinition1.xml');
    expect(files).toContain('xl/pivotCache/pivotCacheRecords1.xml');
    expect(files).toContain('xl/pivotTables/pivotTable1.xml');
  });

  it('на листе параметров стоят период, автор и правила счёта', async () => {
    const rows = sheet((await book()).sheets, 'Параметры');
    const values = new Map(rows.map((row) => [row[0], row[1]]));

    expect(values.get('Период с')).toBe('01.08.2026');
    expect(values.get('Период по')).toBe('31.08.2026');
    expect(values.get('Выгрузил')).toBe('Петров П.П. (admin@dev.local)');
    expect(values.get('Смен ожидалось')).toBe('5');
    expect(values.get('Расход')).toContain('остаток на начало');
  });

  it('отказывает до сборки, когда строк больше предела', async () => {
    state.total = 50_001;

    await expect(book()).rejects.toThrow(/сузьте период/i);
  });
});
