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
  limit: 50_000,
}));

vi.mock('../src/services/readings-aggregate', () => ({
  loadFleetStats: async () => state.stats,
}));

/*
 * Предел строк — из подменённого модуля, и он читается на каждый вызов (геттер): книга сверяется
 * с ним внутри сборки, а поднимать в тесте пятьдесят тысяч строк ради одного отказа незачем.
 */
vi.mock('../src/services/readings-export', () => ({
  get READING_EXPORT_ROW_LIMIT() {
    return state.limit;
  },
}));

/*
 * Строки книги — ожидаемые смены периода, те же, что показывает реестр приёма. Подменяется именно
 * их выборка: своего правила «что такое смена» у книги нет, и тест не должен заводить второе.
 */
vi.mock('../src/services/readings-intake', () => ({
  loadIntakeRows: async () => state.rows,
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
    hasNorm: false,
    fuelFilledLiters: 200,
    gaps: 0,
    typeName: 'Самосвал',
    modelName: 'КамАЗ 65115',
    ownership: 'own',
    shifts: 2,
    missingReadings: 0,
    unacceptedShifts: 0,
    fuelSpentLiters: 0,
    fuelNormLiters: 0,
    verifiedShifts: 0,
    shiftsWithFuel: 0,
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
    hasNorm: false,
    fuelFilledLiters: 300,
    gaps: 2,
    typeName: 'Самосвал',
    modelName: 'КамАЗ 6520',
    ownership: 'own',
    shifts: 3,
    missingReadings: 1,
    unacceptedShifts: 1,
    fuelSpentLiters: 0,
    fuelNormLiters: 0,
    verifiedShifts: 0,
    shiftsWithFuel: 0,
  };
}

function shift(over: Record<string, unknown>): Record<string, unknown> {
  return {
    source_id: 's1',
    source_kind: 'route',
    exp_vehicle: V1,
    exp_date: '2026-08-03',
    exp_person: 'p1',
    exp_report_id: 'rep1',
    exp_state: 'accepted',
    exp_report_version: 1,
    item_id: 'i1',
    obs_vehicle: V1,
    obs_date: '2026-08-03',
    obs_shift_order: 1,
    obs_report_id: 'rep1',
    obs_state: 'accepted',
    obs_report_version: 1,
    aligned: true,
    row_date: '2026-08-03',
    row_vehicle: V1,
    row_person: 'p1',
    person_name: 'Иванов Иван Иванович',
    route_num: 145,
    waybill_number: null,
    waybill_prefix: null,
    waybill_number_width: null,
    ownership: 'own',
    description: '',
    registration_number: 'А123БВ797',
    category_name: 'Самосвал',
    type_name: 'Самосвал',
    model_name: 'КамАЗ 65115',
    reading_id: 'r1',
    reading_kind: 'values',
    odometer_km: 213_020,
    engine_hours: '4790.0',
    fuel_start_liters: '180.0',
    fuel_filled_liters: '200.0',
    fuel_end_liters: '150.0',
    no_data_reason: null,
    comment: null,
    reading_source: 'driver',
    recorded_at: '2026-08-03T10:00:00.000Z',
    odometer_anomaly: null,
    odometer_anomaly_confirmed: false,
    engine_hours_anomaly: null,
    engine_hours_anomaly_confirmed: false,
    previous_odometer_km: 212_775,
    previous_odometer_date: '2026-08-02',
    previous_engine_hours: '4781.5',
    previous_engine_hours_date: '2026-08-02',
    ...over,
  };
}

/**
 * Смена машиниста по недельному ЭСМ-2, чей день никто не открывал: отчёта нет, показаний нет,
 * человек известен из самого листа. Ради неё книга и переехала на ожидаемые смены (Р13).
 */
function machinistShift(over: Record<string, unknown> = {}): Record<string, unknown> {
  return shift({
    source_id: 'w1',
    source_kind: 'esm2',
    exp_report_id: null,
    exp_state: null,
    exp_report_version: null,
    item_id: null,
    obs_vehicle: null,
    obs_date: null,
    obs_shift_order: null,
    obs_report_id: null,
    obs_state: null,
    obs_report_version: null,
    aligned: false,
    person_name: 'Сидоров Семён Семёнович',
    route_num: null,
    waybill_number: 123,
    waybill_prefix: 'ЭСМ',
    waybill_number_width: 6,
    reading_id: null,
    reading_kind: null,
    odometer_km: null,
    engine_hours: null,
    fuel_start_liters: null,
    fuel_filled_liters: null,
    fuel_end_liters: null,
    reading_source: null,
    recorded_at: null,
    previous_odometer_km: null,
    previous_odometer_date: null,
    previous_engine_hours: null,
    previous_engine_hours_date: null,
    ...over,
  });
}

async function book() {
  const result = await buildAdminReadingsExport({
    from: '2026-08-01',
    to: '2026-08-31',
    actor: 'Петров П.П. (admin@dev.local)',
    at: '10.09.2026, 14:32',
    // Настройки сверки книга получает решёнными — как `actor` и `at` (docs/fuel-norms-plan.md).
    season: { winterFromMd: '11-01', winterToMd: '03-31', tolerancePercent: 5 },
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
    shift({
      row_date: '2026-08-04',
      exp_date: '2026-08-04',
      obs_date: '2026-08-04',
      odometer_km: 213_268,
      previous_odometer_km: 213_020,
    }),
    shift({
      source_id: 's3',
      exp_vehicle: V2,
      obs_vehicle: V2,
      row_vehicle: V2,
      registration_number: 'М456ОР197',
      model_name: 'КамАЗ 6520',
      row_date: '2026-08-06',
      exp_date: '2026-08-06',
      obs_date: '2026-08-06',
      person_name: 'Кузнецов Алексей Алексеевич',
      odometer_km: 187_100,
      previous_odometer_km: null,
      engine_hours: '2980.0',
      previous_engine_hours: '2974.0',
      fuel_start_liters: null,
      fuel_end_liters: null,
      fuel_filled_liters: '300.0',
      odometer_anomaly: 'counter_reset',
      reading_source: 'staff',
      comment: 'замена прибора',
    }),
  ];
  state.limit = 50_000;
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

  /**
   * Тот самый дефект, ради которого книга переехала на ожидаемые смены (Р13): машинист сдаёт
   * работу недельным ЭСМ-2, дни таких листов никто не открывает — и в первой редакции книги ни
   * смены, ни имени не было, хотя «Смен по плану» их считало. Проверяется по всем трём местам
   * сразу: детализация, колонка людей в своде и источник сводной.
   */
  it('смену машиниста без отчёта книга показывает вместе с его именем', async () => {
    state.rows = [...state.rows, machinistShift()];

    const { sheets } = await book();
    const detail = sheet(sheets, 'Детализация');
    const summary = sheet(sheets, 'Свод');
    const source = sheet(sheets, 'Данные');

    const shiftRow = detail.find((row) => row[2] === 'Сидоров С.С.');
    expect(shiftRow?.[3]).toBe('ЭСМ000123 (ЭСМ-2)');
    // Позиции смены у неоткрытого дня нет, показаний нет, отчёта нет — и книга говорит это
    // словами: «не открыт» и «не сдано» — разные ответы, и ни один не ноль.
    expect(shiftRow?.[1]).toBe('—');
    expect(shiftRow?.at(-1)).toBe('не открыт');
    expect(shiftRow?.at(-2)).toBe('не сдано');
    // Колонка водителей уехала на четыре позиции: перед ней встала сверка с нормой
    // (docs/fuel-norms-plan.md, §4.3) — расход сверки, норма, отклонение и охват.
    expect(summary[3]?.[23]).toContain('Сидоров С.С.');
    expect(source.some((row) => row[4] === 'Сидоров С.С.')).toBe(true);
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
    state.limit = 2;

    // Строк три — ровно на одну больше предела; книга не собирается вовсе, а отказ говорит, что
    // делать дальше. Молчаливое обрезание здесь было бы худшим: подписывают выгрузку целиком.
    await expect(book()).rejects.toThrow(/В выгрузку попадает 3 строк.*сузьте период/i);
  });
});
