import {
  formatNameWithInitials,
  formatVehicleRequestNumber,
  rateForWorkUnit,
  type VehicleWorkUnit,
} from '@technic/contracts';
import { err } from '../lib/errors';
import {
  columnName,
  writeWorkbook,
  type CellInput,
  type ColumnStyle,
  type ConditionalFormat,
  type SheetInput,
} from '../lib/xlsx';
import { READING_EXPORT_ROW_LIMIT } from './readings-export';
import {
  loadReportRows,
  type CounterSnapshot,
  type ReportReading,
  type ReportRequest,
  type ReportRow,
} from './readings-report-rows';

/**
 * The readings report of «Администрирование → Выгрузки» (ADR 0240, which replaced the five-sheet
 * book of ADR 0180): the work of equipment by request days, laid out after the owner's daily
 * equipment report.
 *
 * Two sheets. «Собственная» — own vehicles with their counters: a row per request day, the mileage
 * and engine hours of the day as formulas over the start and end snapshots, so the totals above the
 * table follow the reader's filter. «Аренда» — rented vehicles, which have no counters and no
 * operators in the system: the shift time, the hours of the day, the rate and the day's cost.
 *
 * The rows come from one selection (`readings-report-rows.ts`); this module only decides how a row
 * reads. Formulas carry the value the server computed with the same rule (`deltaOf`), because mail
 * and phone previews show stored values only. The rule that a reading's predecessor is the start,
 * the shared-route carrier and the continuity of a pair are the selection's, not repeated here.
 */

const DASH = '—';
const CHECK = 'Проверить';
const TITLE = 'Отчет о работе строительной техники';
const OWN_SHEET = 'Собственная';
const RENTAL_SHEET = 'Аренда';
/** The table header row; the title, the period and the totals stand above it. */
const HEADER_ROW = 4;
const FIRST_DATA_ROW = HEADER_ROW + 1;
/** A request comment is a hint in the task column, not the whole text. */
const COMMENT_LIMIT = 80;

// ── Text ──

function dayLabel(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : date;
}

function periodLabel(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
}

/** `2026-10-28` → `28.10`: the start date of a broken chain. */
function shortDay(date: string): string {
  const [, m, d] = date.slice(0, 10).split('-');
  return m && d ? `${d}.${m}` : date;
}

function hoursText(value: number): string {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

function vehicleName(row: ReportRow): string {
  const { vehicle } = row;
  // A rented vehicle has no model in the directory (`vehicles_rental_fields_check`): its
  // description is what the lessor calls it.
  const model = vehicle.modelName ?? (vehicle.ownership === 'rental' ? vehicle.description : '');
  return [vehicle.typeName, model].filter((part) => part !== '').join(' ') || DASH;
}

function vehicleNumbers(row: ReportRow): string {
  const parts = [row.vehicle.registrationNumber, row.vehicle.inventoryNumber].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );
  return parts.length === 0 ? DASH : parts.join(' / ');
}

function placeOf(row: ReportRow): string {
  if (row.relocation) return `${row.relocation.from} → ${row.relocation.to}`;
  const request = row.request;
  if (!request) return DASH;
  if (request.type === 'freight_transport') {
    const trips = request.trips.map((trip) => `${trip.from} → ${trip.to}`);
    return trips.length === 0 ? DASH : trips.join('; ');
  }
  return request.customerName || DASH;
}

/**
 * The brief request data the other columns do not carry (decision 7): number, author and approver,
 * cargo of a freight request, the comment of a special-equipment request.
 */
function requestBrief(request: ReportRequest): string[] {
  const people = [
    request.authorName ? `авт. ${formatNameWithInitials(request.authorName)}` : '',
    request.approverName ? `согл. ${formatNameWithInitials(request.approverName)}` : '',
  ].filter((part) => part !== '');
  const cargo = [...new Set(request.trips.map((trip) => trip.cargo.trim()))].filter(
    (name) => name !== '',
  );
  const comment = request.comment.replace(/\s+/gu, ' ').trim();
  return [
    formatVehicleRequestNumber(request.num),
    people.join(', '),
    request.type === 'freight_transport' && cargo.length > 0 ? `груз: ${cargo.join(', ')}` : '',
    request.type === 'special_equipment' && comment !== ''
      ? comment.length > COMMENT_LIMIT
        ? `${comment.slice(0, COMMENT_LIMIT - 1)}…`
        : comment
      : '',
  ].filter((part) => part !== '');
}

function taskText(row: ReportRow, marks: readonly string[]): string {
  const base =
    row.kind === 'noRequest'
      ? ['без заявки', row.sourceLabel ?? ''].filter((part) => part !== '')
      : row.request
        ? requestBrief(row.request)
        : [];
  return [...base, ...(marks.length > 0 ? [marks.join('; ')] : [])].join(' · ');
}

function personsOf(row: ReportRow): string {
  const names = row.readingPersons.length > 0 ? row.readingPersons : [row.sourcePerson ?? ''];
  const list = names.filter((name) => name !== '');
  return list.length === 0 ? DASH : list.join(', ');
}

// ── Counters ──

/** A counter cell: a number, the dash of "the reading has no such counter", or empty. */
type CounterCell = number | typeof DASH | '';

interface CounterPair {
  start: CounterCell;
  end: CounterCell;
  /** The predecessor date when the start's pair is broken by the garage's rule (decision 11). */
  brokenFrom: string | null;
}

/**
 * The start and end of one counter over the readings a row carries: the predecessor of the earliest
 * reading with the counter and the value of the latest one. No values reading — empty cells; values
 * readings without this counter — a dash in both.
 */
function counterPair(
  readings: readonly ReportReading[],
  pick: (reading: ReportReading) => CounterSnapshot,
): CounterPair {
  const measured = readings.filter((reading) => reading.kind === 'values');
  if (measured.length === 0) return { start: '', end: '', brokenFrom: null };
  const withValue = measured.filter((reading) => pick(reading).value !== null);
  if (withValue.length === 0) return { start: DASH, end: DASH, brokenFrom: null };
  const first = pick(withValue[0]!);
  const last = pick(withValue[withValue.length - 1]!);
  return {
    start: first.previous ?? '',
    end: last.value ?? '',
    brokenFrom: !first.continuous && first.previousDate !== null ? first.previousDate : null,
  };
}

/**
 * The day's difference by the very rule of the sheet's formula (`deltaFormula`): the server writes
 * this value next to the formula, and the two must never disagree.
 */
function deltaOf(start: CounterCell, end: CounterCell): number | string {
  if (start === DASH && end === DASH) return DASH;
  if (start === '' || end === '') return '';
  if (typeof start !== 'number' || typeof end !== 'number') return CHECK;
  if (start < 0 || end < start) return CHECK;
  return Math.round((end - start) * 10) / 10;
}

function deltaFormula(start: string, end: string, row: number): string {
  const s = `${start}${row}`;
  const e = `${end}${row}`;
  return (
    `IF(AND(${s}="${DASH}",${e}="${DASH}"),"${DASH}",IF(OR(${s}="",${e}=""),"",` +
    `IF(COUNT(${s}:${e})<>2,"${CHECK}",IF(OR(${s}<0,${e}<${s}),"${CHECK}",${e}-${s}))))`
  );
}

function counterCell(value: CounterCell, digits: 0 | 1): CellInput {
  return typeof value === 'number' ? { num: value, digits } : value;
}

// ── Marks ──

/** Marks every row may carry, in the order of decision 7 (decision lists of ADR 0240). */
function commonMarks(row: ReportRow): string[] {
  return [
    ...row.sharedRoutes.map((label) => `рейс общий ${label}`),
    row.kind === 'relocation' ? 'перегон' : '',
    row.outOfTerm ? 'вне срока заявки' : '',
    row.swapped ? 'машина заменена в течение дня' : '',
  ].filter((mark) => mark !== '');
}

function noDataMarks(row: ReportRow): string[] {
  const reasons = row.readings
    .filter((reading) => reading.kind === 'no_data')
    .map((reading) => reading.noDataReason.trim() || 'причина не указана');
  return [...new Set(reasons)].map((reason) => `нет данных: ${reason}`);
}

function hasAnyReading(row: ReportRow): boolean {
  return row.readings.length > 0 || row.sharedRoutes.length > 0;
}

// ── «Собственная» ──

const OWN_HEADER = [
  '№',
  'Дата',
  'Техника (вид, марка / модель)',
  'Госномер / инв. номер',
  'Водитель / оператор',
  'Объект / маршрут',
  'Выполненная задача',
  'Пробег за день, км',
  'Одометр: начало, км',
  'Одометр: конец, км',
  'Моточасы, ч',
  'Моточасы: начало, ч',
  'Моточасы: конец, ч',
];
const OWN_WIDTHS = [5, 11, 26, 20, 24, 30, 52, 11, 12, 12, 11, 12, 12];
const INPUT: ColumnStyle = { tone: 'input' };
const SLATE: ColumnStyle = { tone: 'input', header: 'slate' };
const COMPUTED: ColumnStyle = { tone: 'computed' };
const INDEX: ColumnStyle = { tone: 'index' };
const OWN_COLUMNS = [
  INDEX,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  COMPUTED,
  SLATE,
  SLATE,
  COMPUTED,
  SLATE,
  SLATE,
];

interface OwnLine {
  cells: CellInput[];
  km: number | string;
  hours: number | string;
}

function ownLine(row: ReportRow, index: number, sheetRow: number): OwnLine {
  const odometer = counterPair(row.readings, (reading) => reading.odometer);
  const engine = counterPair(row.readings, (reading) => reading.engineHours);
  const km = deltaOf(odometer.start, odometer.end);
  const hours = deltaOf(engine.start, engine.end);
  const broken = [odometer.brokenFrom, engine.brokenFrom]
    .filter((date): date is string => date !== null)
    .sort()[0];
  const signed = row.shift?.signed === true ? row.shift.machineHours : null;
  const marks = [
    ...commonMarks(row),
    hasAnyReading(row) ? '' : 'показания не сданы',
    ...noDataMarks(row),
    broken ? `начало от ${shortDay(broken)}` : '',
    row.readings.some((reading) => reading.engineHoursReset) ? 'сброс счётчика' : '',
    signed !== null && (typeof hours !== 'number' || Math.abs(hours - signed) >= 0.05)
      ? `подписано ${hoursText(signed)} ч`
      : '',
  ].filter((mark) => mark !== '');
  return {
    km,
    hours,
    cells: [
      { num: index },
      { date: row.date },
      vehicleName(row),
      vehicleNumbers(row),
      personsOf(row),
      placeOf(row),
      taskText(row, marks),
      { formula: deltaFormula('I', 'J', sheetRow), value: km, digits: 0 },
      counterCell(odometer.start, 0),
      counterCell(odometer.end, 0),
      { formula: deltaFormula('L', 'M', sheetRow), value: hours, digits: 1 },
      counterCell(engine.start, 1),
      counterCell(engine.end, 1),
    ],
  };
}

// ── «Аренда» ──

const RENTAL_HEADER = [
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
];
const RENTAL_WIDTHS = [5, 11, 26, 18, 26, 30, 52, 13, 9, 15, 15];
const RENTAL_COLUMNS = [
  INDEX,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  INPUT,
  COMPUTED,
];

const UNIT_SUFFIX: Record<VehicleWorkUnit, string> = { hours: '₽/ч', shifts: '₽/смену' };

/**
 * The unit of an estimate for a request not yet closed: the unit the assignment has a price for,
 * a shift first — the closing window's default (`defaultUnit` in the portal's completion command),
 * so the estimate reads as the closing would start. The rate of the unit is then the completion's
 * own rule (`rateForWorkUnit`).
 */
function plannedUnit(assignment: ReportRequest['assignment']): VehicleWorkUnit | null {
  if (assignment?.pricePerShift != null) return 'shifts';
  if (assignment?.pricePerHour != null) return 'hours';
  return null;
}

interface RentalHours {
  hours: number | null;
  marks: string[];
}

/**
 * Hours of a rented vehicle's day, independent of the request status (ADR 0240). A special day
 * signed on the «Смены» tab gives confirmed hours; any other day gives the plan with a mark. A
 * freight request is one route day: its closing gives confirmed hours, otherwise its route time is
 * the plan, then the assignment's shift length.
 */
function rentalHours(row: ReportRow): RentalHours {
  const request = row.request;
  const planned = (marks: string[]): RentalHours => {
    const plan =
      request?.type === 'freight_transport' && row.routeTime?.hours != null
        ? row.routeTime.hours
        : (request?.assignment?.shiftHours ?? null);
    return plan === null
      ? { hours: null, marks: [...marks, 'план не задан'] }
      : { hours: plan, marks };
  };
  if (request?.type === 'freight_transport') {
    const completion = request.completion;
    if (completion) {
      const confirmed =
        completion.workedHours ?? (completion.unit === 'hours' ? completion.amount : null);
      return confirmed === null ? planned(['закрыто в сменах']) : { hours: confirmed, marks: [] };
    }
    return planned(['часы по плану']);
  }
  if (row.shift?.signed) return { hours: row.shift.machineHours, marks: [] };
  return planned(['часы по плану']);
}

function shiftTime(row: ReportRow): string {
  const span =
    row.request?.type === 'freight_transport'
      ? row.routeTime
      : row.shift
        ? { startedAt: row.shift.startedAt, endedAt: row.shift.endedAt }
        : null;
  return span?.startedAt && span.endedAt ? `${span.startedAt}–${span.endedAt}` : '';
}

interface RentalLine {
  cells: CellInput[];
  hours: number | null;
  cost: number | string;
}

function rentalLine(row: ReportRow, index: number, sheetRow: number): RentalLine {
  const request = row.request;
  const { hours, marks: hourMarks } = rentalHours(row);
  const completion = request?.completion ?? null;
  const unit = completion?.unit ?? plannedUnit(request?.assignment ?? null);
  const rate = completion
    ? completion.rate
    : unit
      ? rateForWorkUnit(request?.assignment, unit)
      : null;
  const marks = [
    ...commonMarks(row),
    ...hourMarks,
    hasAnyReading(row) ? 'есть показания водителя' : '',
  ].filter((mark) => mark !== '');

  const i = `I${sheetRow}`;
  const j = `J${sheetRow}`;
  const hourly = unit === 'hours';
  const cost =
    rate === null
      ? ''
      : hourly
        ? hours === null
          ? ''
          : Math.round(hours * rate * 100) / 100
        : rate;
  const formula = hourly ? `IF(OR(${i}="",${j}=""),"",${i}*${j})` : `IF(${j}="","",${j})`;
  return {
    hours,
    cost,
    cells: [
      { num: index },
      { date: row.date },
      vehicleName(row),
      vehicleNumbers(row),
      row.vehicle.lessorName ?? DASH,
      placeOf(row),
      taskText(row, marks),
      shiftTime(row),
      hours === null ? '' : { num: hours, digits: 1 },
      rate === null || unit === null ? '' : { num: rate, digits: 2, suffix: UNIT_SUFFIX[unit] },
      { formula, value: cost, digits: 2, suffix: '₽' },
    ],
  };
}

// ── Sheets ──

/** The order of the book: by vehicle, then day, then request number (decision 4). */
function ordered(rows: readonly ReportRow[]): ReportRow[] {
  const label = (row: ReportRow) => `${vehicleName(row)} ${vehicleNumbers(row)}`;
  return [...rows].sort(
    (a, b) =>
      label(a).localeCompare(label(b), 'ru') ||
      a.vehicle.id.localeCompare(b.vehicle.id) ||
      a.date.localeCompare(b.date) ||
      (a.request?.num ?? Number.MAX_SAFE_INTEGER) - (b.request?.num ?? Number.MAX_SAFE_INTEGER) ||
      a.kind.localeCompare(b.kind) ||
      (a.sourceLabel ?? '').localeCompare(b.sourceLabel ?? ''),
  );
}

function sum(values: readonly (number | string | null)[]): number {
  const total = values.reduce<number>(
    (acc, value) => acc + (typeof value === 'number' ? value : 0),
    0,
  );
  return Math.round(total * 100) / 100;
}

/**
 * A total above a column: `SUBTOTAL(109, …)` follows the filter and skips text cells («—»,
 * «Проверить»). An empty sheet has no range to total, and its total is a plain zero.
 */
function total(
  column: string,
  last: number,
  value: number,
  digits: 0 | 1 | 2,
  suffix?: string,
): CellInput {
  if (last < FIRST_DATA_ROW) return { num: 0, digits, ...(suffix ? { suffix } : {}) };
  return {
    formula: `SUBTOTAL(109,${column}${FIRST_DATA_ROW}:${column}${last})`,
    value,
    digits,
    ...(suffix ? { suffix } : {}),
  };
}

/** «Проверить» in the column and in the total above it are red (the sample's highlight). */
function checkFormats(columns: readonly string[], last: number): ConditionalFormat[] {
  if (last < FIRST_DATA_ROW) return [];
  return columns.flatMap((column) => [
    { ref: `${column}${FIRST_DATA_ROW}:${column}${last}`, containsText: CHECK },
    {
      ref: `${column}${HEADER_ROW - 1}`,
      expression: `COUNTIF(${column}${FIRST_DATA_ROW}:${column}${last},"${CHECK}")>0`,
    },
  ]);
}

/**
 * Weekend rows (ADR 0241, the owner's request of 02.11.2026): Saturday and Sunday in two different
 * light shades across the whole data row. A rule on the row's date rather than a fill per cell: it
 * follows the row through sorting and filtering, and the column looks of other rows stay intact.
 * The rules come after «Проверить» in the list, so the red highlight wins on a weekend row.
 */
const SATURDAY_FILL = 'FFEDE7F6';
const SUNDAY_FILL = 'FFFFE0B2';

function weekendFormats(lastColumn: string, last: number): ConditionalFormat[] {
  if (last < FIRST_DATA_ROW) return [];
  const ref = `A${FIRST_DATA_ROW}:${lastColumn}${last}`;
  const day = `WEEKDAY($B${FIRST_DATA_ROW},2)`;
  return [
    { ref, expression: `${day}=6`, fill: SATURDAY_FILL },
    { ref, expression: `${day}=7`, fill: SUNDAY_FILL },
  ];
}

function head(width: number, period: string, totals: CellInput[]): CellInput[][] {
  const pad = (cells: CellInput[]) => [...cells, ...Array<string>(width - cells.length).fill('')];
  return [pad([TITLE]), pad(['', 'Период отчета:', period]), pad(totals)];
}

function ownSheet(rows: readonly ReportRow[], period: string): SheetInput {
  const lines = ordered(rows).map((row, index) => ownLine(row, index + 1, FIRST_DATA_ROW + index));
  const last = FIRST_DATA_ROW + lines.length - 1;
  const totals: CellInput[] = Array<CellInput>(OWN_HEADER.length).fill('');
  totals[6] = 'Пробег по фильтру, км:';
  totals[7] = total('H', last, sum(lines.map((line) => line.km)), 0);
  totals[9] = 'Моточасы по фильтру, ч:';
  totals[10] = total('K', last, sum(lines.map((line) => line.hours)), 1);
  return {
    name: OWN_SHEET,
    headerRow: HEADER_ROW,
    gridLines: false,
    widths: OWN_WIDTHS,
    columnStyles: OWN_COLUMNS,
    rowStyles: [{ title: true, height: 26 }, undefined, { bold: true }, { height: 45 }],
    rows: [
      ...head(OWN_HEADER.length, period, totals),
      OWN_HEADER,
      ...lines.map((line) => line.cells),
    ],
    conditionalFormats: [
      ...checkFormats(['H', 'K'], last),
      ...weekendFormats(columnName(OWN_HEADER.length), last),
    ],
  };
}

function rentalSheet(rows: readonly ReportRow[], period: string): SheetInput {
  const lines = ordered(rows).map((row, index) =>
    rentalLine(row, index + 1, FIRST_DATA_ROW + index),
  );
  const last = FIRST_DATA_ROW + lines.length - 1;
  const totals: CellInput[] = Array<CellInput>(RENTAL_HEADER.length).fill('');
  totals[7] = 'Часов по фильтру:';
  totals[8] = total('I', last, sum(lines.map((line) => line.hours)), 1);
  totals[9] = 'Стоимость по фильтру, ₽:';
  totals[10] = total('K', last, sum(lines.map((line) => line.cost)), 2, '₽');
  return {
    name: RENTAL_SHEET,
    headerRow: HEADER_ROW,
    gridLines: false,
    widths: RENTAL_WIDTHS,
    columnStyles: RENTAL_COLUMNS,
    rowStyles: [{ title: true, height: 26 }, undefined, { bold: true }, { height: 45 }],
    rows: [
      ...head(RENTAL_HEADER.length, period, totals),
      RENTAL_HEADER,
      ...lines.map((line) => line.cells),
    ],
    conditionalFormats: weekendFormats(columnName(RENTAL_HEADER.length), last),
  };
}

/** Both sheets from rows in memory: «Собственная» first, so it is the one open on load. */
export function readingsReportSheets(
  rows: readonly ReportRow[],
  from: string,
  to: string,
): SheetInput[] {
  const period = periodLabel(from, to);
  return [
    ownSheet(
      rows.filter((row) => row.vehicle.ownership !== 'rental'),
      period,
    ),
    rentalSheet(
      rows.filter((row) => row.vehicle.ownership === 'rental'),
      period,
    ),
  ];
}

// ── Outside ──

export interface AdminExportRequest {
  from: string;
  to: string;
}

export interface AdminExportResult {
  filename: string;
  bytes: Uint8Array;
}

/**
 * The book of a period. The period's length is the route's check; the row limit stands here,
 * before the book is built in memory, and counts both sheets — a book is refused whole, never cut.
 */
export async function buildAdminReadingsExport(
  request: AdminExportRequest,
): Promise<AdminExportResult> {
  const { from, to } = request;
  const { rows } = await loadReportRows(from, to);
  if (rows.length > READING_EXPORT_ROW_LIMIT) {
    throw err.badRequest(
      `В выгрузку попадает ${rows.length} строк, предел — ${READING_EXPORT_ROW_LIMIT}: сузьте период`,
      { to: 'Сузьте период' },
    );
  }
  return {
    filename: `Показания автотранспорта ${periodLabel(from, to)}.xlsx`,
    bytes: writeWorkbook(readingsReportSheets(rows, from, to)),
  };
}
