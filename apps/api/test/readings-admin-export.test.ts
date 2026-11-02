import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { CellInput, SheetInput } from '../src/lib/xlsx';
import { readWorkbook } from '../src/lib/xlsx';
import type {
  ReportReading,
  ReportRequest,
  ReportRow,
  ReportVehicle,
} from '../src/services/readings-report-rows';

/**
 * The readings report book (ADR 0240) on rows in memory.
 *
 * Which rows exist, which vehicle stands on them and which readings they carry is the selection's
 * and has its own test on the live schema (`readings-report-rows.db.test.ts`). Here the rows are
 * given, and the test asserts the book itself: the order and numbering, the header and totals, the
 * formula of every row next to the value the server computed, the marks of the task column, the
 * hours, rates and costs of «Аренда», and the refusal above the row limit.
 */

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  limit: 50_000,
}));

vi.mock('../src/services/readings-report-rows', () => ({
  loadReportRows: async () => ({ rows: state.rows, coveredTo: '2026-10-31' }),
}));

/*
 * The row limit comes from the mocked module and is read on every call (a getter): the builder
 * checks it inside, and raising fifty thousand rows for one refusal is not needed.
 */
vi.mock('../src/services/readings-export', () => ({
  get READING_EXPORT_ROW_LIMIT() {
    return state.limit;
  },
}));

const { buildAdminReadingsExport, readingsReportSheets } =
  await import('../src/services/readings-admin-export');

const FROM = '2026-10-01';
const TO = '2026-10-31';

function vehicle(patch: Partial<ReportVehicle> = {}): ReportVehicle {
  return {
    id: 'v-kamaz',
    ownership: 'own',
    typeName: 'Самосвал',
    modelName: 'КамАЗ 65115',
    categoryName: null,
    description: '',
    registrationNumber: 'А123БВ797',
    inventoryNumber: '00123',
    lessorName: null,
    ...patch,
  };
}

function request(patch: Partial<ReportRequest> = {}): ReportRequest {
  return {
    id: 'q-40',
    num: 40,
    type: 'special_equipment',
    customerName: 'ЖК Северный',
    authorName: 'Иванов Иван Иванович',
    approverName: 'Петров Пётр Петрович',
    comment: 'котлован под секцию 2',
    trips: [],
    termFrom: '2026-10-01',
    termTo: '2026-10-31',
    assignment: { pricePerHour: null, pricePerShift: null, shiftHours: null },
    completion: null,
    ...patch,
  };
}

function reading(patch: Partial<ReportReading> = {}): ReportReading {
  return {
    readingId: 'r-1',
    vehicleId: 'v-kamaz',
    date: '2026-10-05',
    shiftOrder: 1,
    kind: 'values',
    noDataReason: '',
    personName: 'Сидоров Сидор Сидорович',
    sourceKind: 'esm2',
    sourceLabel: 'ЭСМ-2 № 000123',
    odometer: { value: 1250, previous: 1200, previousDate: '2026-10-04', continuous: true },
    engineHours: { value: 108.5, previous: 100, previousDate: '2026-10-04', continuous: true },
    engineHoursReset: false,
    ...patch,
  };
}

function row(patch: Partial<ReportRow> = {}): ReportRow {
  return {
    kind: 'request',
    date: '2026-10-05',
    vehicle: vehicle(),
    request: request(),
    readings: [reading()],
    sharedRoutes: [],
    readingPersons: ['Сидоров Сидор Сидорович'],
    sourcePerson: null,
    sourceLabel: null,
    relocation: null,
    outOfTerm: false,
    swapped: false,
    shift: null,
    routeTime: null,
    ...patch,
  };
}

function sheets(rows: ReportRow[]): SheetInput[] {
  return readingsReportSheets(rows, FROM, TO);
}

/** A data row of a sheet by its running number (data starts under the header, row 5). */
function dataRow(sheet: SheetInput, index: number): CellInput[] {
  return sheet.rows[4 + index - 1]!;
}

function text(cell: CellInput | undefined): string {
  return typeof cell === 'string' ? cell : JSON.stringify(cell);
}

function taskOf(sheet: SheetInput, index: number): string {
  return text(dataRow(sheet, index)[6]);
}

beforeEach(() => {
  state.rows = [];
  state.limit = 50_000;
});

describe('книга показаний: листы, шапка и порядок', () => {
  it('two sheets, own first; the empty «Аренда» is still there with its header', () => {
    const [own, rental] = sheets([row()]);
    expect(own!.name).toBe('Собственная');
    expect(rental!.name).toBe('Аренда');
    expect(rental!.rows).toHaveLength(4);
    expect(rental!.rows[3]).toEqual([
      '№',
      'Дата',
      'Техника (вид, марка / модель)',
      'Госномер / инв. номер',
      'Арендодатель',
      'Объект / маршрут',
      'Выполненная задача',
      'Время смены',
      'Часы',
      'Ставка',
      'Стоимость дня',
    ]);
    // An empty sheet has no range to total: its totals are plain zeros, not formulas over nothing.
    expect(rental!.rows[2]![8]).toEqual({ num: 0, digits: 1 });
  });

  it('title, period and totals stand above the frozen, filtered header', () => {
    const [own] = sheets([row(), row({ date: '2026-10-06' })]);
    expect(own!.rows[0]![0]).toBe('Отчет о работе строительной техники');
    expect(own!.rows[1]!.slice(0, 3)).toEqual(['', 'Период отчета:', '01.10.2026 – 31.10.2026']);
    expect(own!.headerRow).toBe(4);
    expect(own!.gridLines).toBe(false);
    expect(own!.rows[3]![12]).toBe('Моточасы: конец, ч');
    expect(own!.rows[2]![6]).toBe('Пробег по фильтру, км:');
    expect(own!.rows[2]![7]).toEqual({ formula: 'SUBTOTAL(109,H5:H6)', value: 100, digits: 0 });
    expect(own!.rows[2]![9]).toBe('Моточасы по фильтру, ч:');
    expect(own!.rows[2]![10]).toEqual({ formula: 'SUBTOTAL(109,K5:K6)', value: 17, digits: 1 });
    expect(own!.conditionalFormats).toEqual([
      { ref: 'H5:H6', containsText: 'Проверить' },
      { ref: 'H3', expression: 'COUNTIF(H5:H6,"Проверить")>0' },
      { ref: 'K5:K6', containsText: 'Проверить' },
      { ref: 'K3', expression: 'COUNTIF(K5:K6,"Проверить")>0' },
      { ref: 'A5:M6', expression: 'WEEKDAY($B5,2)=6', fill: 'FFEDE7F6' },
      { ref: 'A5:M6', expression: 'WEEKDAY($B5,2)=7', fill: 'FFFFE0B2' },
    ]);
  });

  /**
   * Weekends (ADR 0241): Saturday and Sunday rows in two shades across the whole data row, by the
   * row's date, after the red «Проверить» so the alert wins on a weekend row. An empty sheet has no
   * data range and no rules.
   */
  it('weekend rows of both sheets are painted by the date, Saturday and Sunday apart', () => {
    const rented = row({
      vehicle: vehicle({ id: 'v-rent', ownership: 'rental', lessorName: 'ООО «Аренда»' }),
      readings: [],
      readingPersons: [],
    });
    const [own, rental] = sheets([row(), rented, { ...rented, date: '2026-10-04' }]);
    expect(own!.conditionalFormats!.slice(4)).toEqual([
      { ref: 'A5:M5', expression: 'WEEKDAY($B5,2)=6', fill: 'FFEDE7F6' },
      { ref: 'A5:M5', expression: 'WEEKDAY($B5,2)=7', fill: 'FFFFE0B2' },
    ]);
    expect(rental!.conditionalFormats).toEqual([
      { ref: 'A5:K6', expression: 'WEEKDAY($B5,2)=6', fill: 'FFEDE7F6' },
      { ref: 'A5:K6', expression: 'WEEKDAY($B5,2)=7', fill: 'FFFFE0B2' },
    ]);
    expect(sheets([row()])[1]!.conditionalFormats).toEqual([]);
  });

  it('rows go by vehicle, then day, then request number; № runs per sheet', () => {
    const excavator = vehicle({ id: 'v-jcb', typeName: 'Экскаватор', modelName: 'JCB 3CX' });
    const rental = vehicle({
      id: 'v-rent',
      ownership: 'rental',
      modelName: null,
      description: 'Кран',
    });
    const [own, rented] = sheets([
      row({ vehicle: excavator, date: '2026-10-07', request: request({ num: 41 }) }),
      row({ date: '2026-10-07', request: request({ num: 52 }) }),
      row({ date: '2026-10-07', request: request({ num: 45 }) }),
      row({ date: '2026-10-06', request: request({ num: 60 }) }),
      row({ vehicle: rental, request: request({ num: 70 }), readings: [] }),
    ]);
    const order = own!.rows
      .slice(4)
      .map((cells) => [cells[0], cells[2], text(cells[6]).split(' · ')[0]]);
    expect(order).toEqual([
      [{ num: 1 }, 'Самосвал КамАЗ 65115', 'ТС-60'],
      [{ num: 2 }, 'Самосвал КамАЗ 65115', 'ТС-45'],
      [{ num: 3 }, 'Самосвал КамАЗ 65115', 'ТС-52'],
      [{ num: 4 }, 'Экскаватор JCB 3CX', 'ТС-41'],
    ]);
    expect(dataRow(rented!, 1)[0]).toEqual({ num: 1 });
    expect(dataRow(rented!, 1)[2]).toBe('Самосвал Кран');
  });
});

describe('книга показаний: «Собственная»', () => {
  it('a row: date, plate and inventory, person, object, task and the counters', () => {
    const [own] = sheets([row()]);
    const cells = dataRow(own!, 1);
    expect(cells.slice(1, 6)).toEqual([
      { date: '2026-10-05' },
      'Самосвал КамАЗ 65115',
      'А123БВ797 / 00123',
      'Сидоров Сидор Сидорович',
      'ЖК Северный',
    ]);
    expect(cells[6]).toBe('ТС-40 · авт. Иванов И.И., согл. Петров П.П. · котлован под секцию 2');
    expect(cells.slice(8)).toEqual([
      { num: 1200, digits: 0 },
      { num: 1250, digits: 0 },
      { formula: expect.any(String), value: 8.5, digits: 1 },
      { num: 100, digits: 1 },
      { num: 108.5, digits: 1 },
    ]);
  });

  it('the formula of each row is the sample one, on its own row, next to its computed value', () => {
    const [own] = sheets([row(), row({ date: '2026-10-06' })]);
    expect(dataRow(own!, 2)[7]).toEqual({
      formula:
        'IF(AND(I6="—",J6="—"),"—",IF(OR(I6="",J6=""),"",IF(COUNT(I6:J6)<>2,"Проверить",' +
        'IF(OR(I6<0,J6<I6),"Проверить",J6-I6))))',
      value: 50,
      digits: 0,
    });
    expect(dataRow(own!, 2)[10]).toMatchObject({
      formula:
        'IF(AND(L6="—",M6="—"),"—",IF(OR(L6="",M6=""),"",IF(COUNT(L6:M6)<>2,"Проверить",' +
        'IF(OR(L6<0,M6<L6),"Проверить",M6-L6))))',
    });
  });

  it('several readings of one vehicle: start of the earliest, end of the latest', () => {
    const [own] = sheets([
      row({
        readings: [
          reading({ readingId: 'r-1', shiftOrder: 1 }),
          reading({
            readingId: 'r-2',
            shiftOrder: 2,
            odometer: { value: 1300, previous: 1250, previousDate: '2026-10-05', continuous: true },
            engineHours: {
              value: 112,
              previous: 108.5,
              previousDate: '2026-10-05',
              continuous: true,
            },
          }),
        ],
      }),
    ]);
    const cells = dataRow(own!, 1);
    expect(cells[7]).toMatchObject({ value: 100 });
    expect(cells.slice(8, 10)).toEqual([
      { num: 1200, digits: 0 },
      { num: 1300, digits: 0 },
    ]);
    expect(cells[10]).toMatchObject({ value: 12 });
  });

  it('a counter the reading lacks is a dash in both cells; a reversed one asks to check', () => {
    const [own] = sheets([
      row({
        readings: [
          reading({
            odometer: { value: null, previous: null, previousDate: null, continuous: true },
            engineHours: { value: 90, previous: 100, previousDate: '2026-10-04', continuous: true },
          }),
        ],
      }),
    ]);
    const cells = dataRow(own!, 1);
    expect(cells.slice(7, 10)).toEqual([expect.objectContaining({ value: '—' }), '—', '—']);
    expect(cells[10]).toMatchObject({ value: 'Проверить' });
    // The total skips text: a dash and «Проверить» are not numbers.
    expect(own!.rows[2]![7]).toMatchObject({ value: 0 });
  });

  it('counters of a shared route stay on the carrier row; the others name the route', () => {
    const [own] = sheets([
      row({ request: request({ num: 40 }) }),
      row({
        request: request({ num: 41, type: 'freight_transport' }),
        readings: [],
        sharedRoutes: ['Р-12'],
      }),
    ]);
    expect(dataRow(own!, 2).slice(7, 13)).toEqual([
      expect.objectContaining({ value: '' }),
      '',
      '',
      expect.objectContaining({ value: '' }),
      '',
      '',
    ]);
    expect(taskOf(own!, 2)).toContain('рейс общий Р-12');
    expect(taskOf(own!, 2)).not.toContain('показания не сданы');
    expect(taskOf(own!, 1)).not.toContain('рейс общий');
  });

  it('a freight row: trips as the route, cargo in the task, no comment', () => {
    const [own] = sheets([
      row({
        request: request({
          type: 'freight_transport',
          comment: 'не показывать',
          trips: [
            { from: 'Карьер', to: 'Площадка', cargo: 'щебень' },
            { from: 'Площадка', to: 'Полигон', cargo: 'грунт' },
          ],
        }),
      }),
    ]);
    expect(dataRow(own!, 1)[5]).toBe('Карьер → Площадка; Площадка → Полигон');
    expect(taskOf(own!, 1)).toBe(
      'ТС-40 · авт. Иванов И.И., согл. Петров П.П. · груз: щебень, грунт',
    );
  });

  it('every mark of the task column, in the decided order', () => {
    const [own] = sheets([
      row({
        kind: 'relocation',
        relocation: { from: 'База', to: 'Площадка' },
        sharedRoutes: ['Р-12'],
        outOfTerm: true,
        swapped: true,
        shift: { machineHours: 7, signed: true, startedAt: null, endedAt: null },
        readings: [
          reading({
            readingId: 'r-1',
            engineHoursReset: true,
            odometer: {
              value: 1250,
              previous: 1200,
              previousDate: '2026-10-28',
              continuous: false,
            },
          }),
          reading({
            readingId: 'r-2',
            shiftOrder: 2,
            kind: 'no_data',
            noDataReason: 'сломан датчик',
          }),
        ],
      }),
    ]);
    expect(taskOf(own!, 1).split(' · ').at(-1)).toBe(
      'рейс общий Р-12; перегон; вне срока заявки; машина заменена в течение дня; ' +
        'нет данных: сломан датчик; начало от 28.10; сброс счётчика; подписано 7 ч',
    );
    expect(dataRow(own!, 1)[5]).toBe('База → Площадка');
  });

  it('no reading — empty counters and «показания не сданы», with the source person', () => {
    const [own] = sheets([
      row({ readings: [], readingPersons: [], sourcePerson: 'Машинистов Ян Янович' }),
    ]);
    expect(dataRow(own!, 1)[4]).toBe('Машинистов Ян Янович');
    expect(dataRow(own!, 1).slice(8, 10)).toEqual(['', '']);
    expect(taskOf(own!, 1)).toContain('показания не сданы');
  });

  it('a no-data reading — empty counters and its reason', () => {
    const [own] = sheets([
      row({ readings: [reading({ kind: 'no_data', noDataReason: 'простой' })] }),
    ]);
    expect(dataRow(own!, 1).slice(8, 10)).toEqual(['', '']);
    expect(taskOf(own!, 1)).toContain('нет данных: простой');
    expect(taskOf(own!, 1)).not.toContain('показания не сданы');
  });

  it('a signed day equal to the counters carries no «подписано» mark', () => {
    const [own] = sheets([
      row({ shift: { machineHours: 8.5, signed: true, startedAt: null, endedAt: null } }),
    ]);
    expect(taskOf(own!, 1)).not.toContain('подписано');
  });

  it('«без заявки»: the source in the task, a dash for the object and the person when none', () => {
    const [own] = sheets([
      row({ kind: 'noRequest', request: null, sourceLabel: 'Р-77', readingPersons: [] }),
    ]);
    expect(dataRow(own!, 1)[4]).toBe('—');
    expect(dataRow(own!, 1)[5]).toBe('—');
    expect(taskOf(own!, 1)).toBe('без заявки · Р-77');
  });

  it('a vehicle without plate and inventory number prints a dash', () => {
    const [own] = sheets([
      row({ vehicle: vehicle({ registrationNumber: null, inventoryNumber: ' ' }) }),
    ]);
    expect(dataRow(own!, 1)[3]).toBe('—');
  });
});

describe('книга показаний: «Аренда»', () => {
  const rented = (patch: Partial<ReportRow> = {}) =>
    row({
      vehicle: vehicle({
        id: 'v-rent',
        ownership: 'rental',
        modelName: null,
        registrationNumber: null,
        inventoryNumber: null,
        description: 'Кран 25 т',
        lessorName: 'ООО «Аренда-Кран»',
      }),
      readings: [],
      readingPersons: [],
      ...patch,
    });
  const rentalRow = (patch: Partial<ReportRow>) => dataRow(sheets([rented(patch)])[1]!, 1);

  it('a signed special day: the site time and confirmed hours, the hourly cost formula', () => {
    const cells = rentalRow({
      request: request({ assignment: { pricePerHour: 2500, pricePerShift: null, shiftHours: 8 } }),
      shift: { machineHours: 7, signed: true, startedAt: '08:00', endedAt: '15:00' },
    });
    expect(cells.slice(2, 11)).toEqual([
      'Самосвал Кран 25 т',
      '—',
      'ООО «Аренда-Кран»',
      'ЖК Северный',
      'ТС-40 · авт. Иванов И.И., согл. Петров П.П. · котлован под секцию 2',
      '08:00–15:00',
      { num: 7, digits: 1 },
      { num: 2500, digits: 2, suffix: '₽/ч' },
      { formula: 'IF(OR(I5="",J5=""),"",I5*J5)', value: 17500, digits: 2, suffix: '₽' },
    ]);
  });

  it('an unsigned special day: planned hours with a mark; no plan — empty with a mark', () => {
    const planned = rentalRow({
      request: request({
        assignment: { pricePerHour: null, pricePerShift: 20000, shiftHours: 10 },
      }),
      shift: { machineHours: 9, signed: false, startedAt: '08:00', endedAt: '17:00' },
    });
    expect(planned[8]).toEqual({ num: 10, digits: 1 });
    expect(text(planned[6])).toContain('часы по плану');
    // A shift price wins as the unit of an estimate, as the closing window starts from it.
    expect(planned[9]).toEqual({ num: 20000, digits: 2, suffix: '₽/смену' });
    expect(planned[10]).toEqual({
      formula: 'IF(J5="","",J5)',
      value: 20000,
      digits: 2,
      suffix: '₽',
    });

    const noPlan = rentalRow({ request: request({ assignment: null }) });
    expect(noPlan[8]).toBe('');
    expect(noPlan[9]).toBe('');
    expect(text(noPlan[6])).toContain('часы по плану; план не задан');
  });

  it('a freight request closed in hours: confirmed hours and the completion rate', () => {
    const cells = rentalRow({
      request: request({
        type: 'freight_transport',
        assignment: { pricePerHour: 1800, pricePerShift: 15000, shiftHours: 8 },
        completion: { unit: 'hours', amount: 5, workedHours: 5, rate: 1900 },
      }),
      routeTime: { hours: 3, startedAt: '09:10', endedAt: '12:05' },
    });
    expect(cells[7]).toBe('09:10–12:05');
    expect(cells[8]).toEqual({ num: 5, digits: 1 });
    expect(cells[9]).toEqual({ num: 1900, digits: 2, suffix: '₽/ч' });
    expect(cells[10]).toMatchObject({ value: 9500 });
    expect(text(cells[6])).not.toContain('по плану');
  });

  it('a freight request closed in shifts: the plan, marked as closed in shifts', () => {
    const cells = rentalRow({
      request: request({
        type: 'freight_transport',
        assignment: { pricePerHour: null, pricePerShift: 15000, shiftHours: 8 },
        completion: { unit: 'shifts', amount: 1, workedHours: null, rate: 15000 },
      }),
      routeTime: { hours: 3, startedAt: null, endedAt: null },
    });
    expect(cells[8]).toEqual({ num: 3, digits: 1 });
    expect(cells[9]).toEqual({ num: 15000, digits: 2, suffix: '₽/смену' });
    expect(text(cells[6])).toContain('закрыто в сменах');
  });

  it('an open freight request: route time as the plan, else the shift length, else nothing', () => {
    const freight = (routeHours: number | null, shiftHours: number | null) =>
      rentalRow({
        request: request({
          type: 'freight_transport',
          assignment: { pricePerHour: 1800, pricePerShift: null, shiftHours },
        }),
        routeTime: { hours: routeHours, startedAt: null, endedAt: null },
      });
    expect(freight(3, 8)[8]).toEqual({ num: 3, digits: 1 });
    // No stop times — a lessor's driver has no cabinet: the assignment's shift length.
    expect(freight(null, 8)[8]).toEqual({ num: 8, digits: 1 });
    expect(text(freight(null, 8)[6])).toContain('часы по плану');
    expect(freight(null, null)[8]).toBe('');
    expect(text(freight(null, null)[6])).toContain('план не задан');
  });

  it('a rented vehicle with driver readings says so', () => {
    const cells = rentalRow({ readings: [reading({ vehicleId: 'v-rent' })] });
    expect(text(cells[6])).toContain('есть показания водителя');
  });

  it('totals of hours and cost follow the filter', () => {
    const rental = sheets([
      rented({
        request: request({
          assignment: { pricePerHour: 1000, pricePerShift: null, shiftHours: 8 },
        }),
      }),
    ])[1]!;
    expect(rental.rows[2]!.slice(7, 11)).toEqual([
      'Часов по фильтру:',
      { formula: 'SUBTOTAL(109,I5:I5)', value: 8, digits: 1 },
      'Стоимость по фильтру, ₽:',
      { formula: 'SUBTOTAL(109,K5:K5)', value: 8000, digits: 2, suffix: '₽' },
    ]);
  });
});

describe('книга показаний: файл', () => {
  it('opens on «Собственная», reads back with the computed values, and is named by the period', async () => {
    state.rows = [row()];
    const result = await buildAdminReadingsExport({ from: FROM, to: TO });
    expect(result.filename).toBe('Показания автотранспорта 01.10.2026 – 31.10.2026.xlsx');
    const book = readWorkbook(result.bytes);
    expect(book.map((sheet) => sheet.name)).toEqual(['Собственная', 'Аренда']);
    const own = book[0]!;
    expect(own.rows[2]![7]).toBe('50');
    expect(own.rows[4]!.slice(7, 13)).toEqual(['50', '1200', '1250', '8.5', '100', '108.5']);
    const workbook = strFromU8(unzipSync(result.bytes)['xl/workbook.xml']!);
    expect(workbook).toContain('fullCalcOnLoad="1"');
    const sheet = strFromU8(unzipSync(result.bytes)['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<autoFilter ref="A4:M4"/>');
    expect(sheet).toContain('<pane ySplit="4" topLeftCell="A5"');
  });

  it('refuses a period above the row limit, counting both sheets', async () => {
    state.limit = 1;
    state.rows = [row(), row({ vehicle: vehicle({ id: 'v-rent', ownership: 'rental' }) })];
    await expect(buildAdminReadingsExport({ from: FROM, to: TO })).rejects.toMatchObject({
      message: expect.stringContaining('предел — 1'),
    });
  });
});
