import {
  fuelDeviation,
  driverReportStateLabels,
  formatNameWithInitials,
  formatVehicleRouteNumber,
  readingAnomalyLabels,
  vehicleLabel,
  vehicleOwnershipLabels,
  waybillDisplayNumber,
  type VehicleReadingStatsRow,
} from '@technic/contracts';
import { err } from '../lib/errors';
import {
  writeWorkbook,
  type CellInput,
  type PivotInput,
  type RowStyle,
  type SheetInput,
} from '../lib/xlsx';
import type { FuelNormSeason } from './fuel-norms';
import { loadFleetStats } from './readings-aggregate';
import { READING_EXPORT_ROW_LIMIT } from './readings-export';
import { loadIntakeRows, type IntakeSqlRow } from './readings-intake';

/**
 * Служебная книга показаний автотранспорта (`docs/readings-admin-export-plan.md`).
 *
 * Пять листов одной книгой: свод по машинам, детализация по сменам с группировкой, скрытый
 * источник сводной таблицы, сама сводная и лист параметров. Открыта она под своим правом
 * (`vehicleReadings.export`), из «Администрирования», и период у неё задаёт человек — этим она и
 * отличается от шести гаражных книг (`readings-export.ts`), которые выгружают то, что показано на
 * экране.
 *
 * Своей арифметики здесь ровно одна — расход топлива (Р5). Всё остальное приходит готовым: пробег,
 * наработка, заправленное, разрывы, последние снимки счётчиков и три счётчика смен — от агрегата
 * (`readings-aggregate.ts`), строки смен — той же выборкой, какой собирает реестр приёма
 * (`readings-intake.ts`). Второго ответа на «сколько проехала машина» в проекте быть не должно.
 *
 * **Строки — ожидаемые смены, а не строки открытых отчётов** (Р13). Первая редакция книги брала
 * выборку журнала парка, то есть строки заведённых отчётов, — и теряла целый разряд работы: смену
 * машиниста по недельному ЭСМ-2, чей день никто не открывал, вместе с его именем. В своде такая
 * смена считалась («смен по плану»), а в детализации её не было, и книга выглядела так, будто
 * портал знает одних водителей рейсов. Общий отбор ожидаемых смен даёт человека из самого
 * документа — рейса или листа, — поэтому машинист попадает в книгу и тогда, когда показаний за
 * него никто не передавал.
 *
 * Четыре правила книги:
 *
 * 1. **Числа лежат числами, даты — датами** (Р4). Иначе не считает ни сводная, ни формула, а
 *    «1 234,5», набранное строкой, не станет числом и после переформатирования колонки.
 * 2. **Прочерк вместо нуля** там, где значение неизвестно, — и в числовой колонке он остаётся
 *    строкой: пустая ячейка сводную не искажает, ноль исказил бы.
 * 3. **Зелёным — строки без нареканий** (Р8), и рядом колонка, называющая нарекание словами: цвет
 *    теряется при печати в чёрно-белом и при пересылке письмом.
 * 4. **Производных от расхода в листах нет** (Р5): «л/100 км» живёт вычисляемым полем сводной, где
 *    видно, из чего оно получено.
 */

// ── Ячейки ──

const DASH = '—';

/** Число или прочерк: `null` — «неизвестно», и нулём оно не притворяется. */
function num(value: number | null, digits: 0 | 1 = 0): CellInput {
  return value === null ? DASH : { num: value, digits };
}

/** Число для скрытого листа-источника: неизвестное — пустая ячейка, иначе поле станет смешанным. */
function raw(value: number | null, digits: 0 | 1 = 0): CellInput {
  return value === null ? '' : { num: value, digits };
}

function day(value: string | null): CellInput {
  return value === null || value === '' ? DASH : { date: value };
}

function decimal(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Число со словом в нужном падеже: «1 смену», «2 смены», «5 смен». Книгу читают глазами, и
 * «не сдано 1 смен» в колонке нареканий выглядит опечаткой в данных, а не в подписи.
 */
function plural(count: number, forms: [string, string, string]): string {
  const tens = count % 100;
  const ones = count % 10;
  const word =
    tens > 10 && tens < 20
      ? forms[2]
      : ones === 1
        ? forms[0]
        : ones > 1 && ones < 5
          ? forms[1]
          : forms[2];
  return `${count} ${word}`;
}

/** Моточасы — с десятой долей: разность двух `numeric` даёт хвост двоичного округления. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function periodLabel(from: string, to: string): string {
  const ru = (date: string): string => {
    const [y, m, d] = date.slice(0, 10).split('-');
    return y && m && d ? `${d}.${m}.${y}` : date;
  };
  return from === to ? ru(from) : `${ru(from)} – ${ru(to)}`;
}

/** `2026-08` → `08.2026`: месяц колонкой источника, по которому группирует сводная (§3.3). */
function monthLabel(date: string): string {
  const [year, month] = date.slice(0, 7).split('-');
  return year && month ? `${month}.${year}` : date;
}

// ── Строка смены ──

/**
 * Строка книги — ожидаемая смена периода вместе с показанием, если оно передано. Тип приходит от
 * реестра приёма: правило «что такое смена» одно на портал (Р13).
 */
type ShiftRow = IntakeSqlRow;

/**
 * Расход за смену (Р5): `остаток на начало + заправлено − остаток на конец`. Формула переехала в
 * общий слой агрегата (`fuelSpentSql`, ADR 0194) — книга и портал считают её одним выражением.
 *
 * Считается только там, где известны **оба** остатка; заправленное без остатков расходом не
 * является — это поток за смену, а не убыль в баке. Отсутствие остатков даёт `null`, а не ноль:
 * машина, у которой уровни не передают, «не расходует топливо» только в книге, где ноль поставили
 * за неё.
 */
function fuelSpent(row: ShiftRow): number | null {
  const start = decimal(row.fuel_start_liters);
  const end = decimal(row.fuel_end_liters);
  if (start === null || end === null) return null;
  return round1(start + (decimal(row.fuel_filled_liters) ?? 0) - end);
}

function odometerDelta(row: ShiftRow): number | null {
  return row.odometer_km === null || row.previous_odometer_km === null
    ? null
    : row.odometer_km - row.previous_odometer_km;
}

function engineHoursDelta(row: ShiftRow): number | null {
  const hours = decimal(row.engine_hours);
  const previous = decimal(row.previous_engine_hours);
  return hours === null || previous === null ? null : round1(hours - previous);
}

/** Источник зовут его номером — тем же правилом, каким его зовёт реестр приёма. */
function sourceLabel(row: ShiftRow): string {
  if (row.source_kind === 'route') {
    return row.route_num === null ? DASH : formatVehicleRouteNumber(row.route_num);
  }
  return row.waybill_number === null || row.waybill_prefix === null
    ? DASH
    : `${waybillDisplayNumber(row.waybill_prefix, row.waybill_number, row.waybill_number_width ?? 0)} (ЭСМ-2)`;
}

function anomalyText(row: ShiftRow): string {
  const parts = [
    row.odometer_anomaly === null ? '' : `одометр: ${readingAnomalyLabels[row.odometer_anomaly]}`,
    row.engine_hours_anomaly === null
      ? ''
      : `моточасы: ${readingAnomalyLabels[row.engine_hours_anomaly]}`,
  ];
  return parts.filter(Boolean).join('; ') || DASH;
}

/** Что со строкой — теми же словами, какими её называет журнал показаний. */
function readingText(row: ShiftRow): string {
  if (row.reading_id === null || row.reading_kind === null || row.reading_source === null) {
    return 'не сдано';
  }
  if (row.reading_kind === 'no_data') {
    return `нет данных${row.no_data_reason ? `: ${row.no_data_reason}` : ''}`;
  }
  const who = row.reading_source === 'staff' ? 'внесено персоналом' : 'передано водителем';
  return row.comment ? `${who} · ${row.comment}` : who;
}

/**
 * Состояние отчёта дня. У ожидаемой смены, чей день никто не открывал, отчёта нет вовсе — и книга
 * говорит это словами, а не пустой ячейкой: «нет отчёта» и «отчёт не принят» — разные ответы, и
 * второй нельзя выдать за первый.
 */
function reportStateText(row: ShiftRow): string {
  const state = row.exp_state ?? row.obs_state;
  return state === null ? 'не открыт' : driverReportStateLabels[state].toLowerCase();
}

/**
 * Кто на смене — работник источника: водитель рейса либо машинист недельного ЭСМ-2 (Р13). Имя
 * приходит из документа, поэтому в книге он назван и тогда, когда показаний за него не передавали.
 */
function personLabel(row: ShiftRow): string {
  return row.person_name ? formatNameWithInitials(row.person_name) : DASH;
}

/** Подпись машины строки — на случай, если её нет в своде (осиротевшая строка, Р32 плана показаний). */
function labelOf(row: ShiftRow): string {
  return vehicleLabel({
    ownership: row.ownership,
    description: row.description,
    registrationNumber: row.registration_number,
    categoryName: row.category_name,
    typeName: row.type_name,
    modelName: row.model_name,
  });
}

/**
 * Порядок строк книги — хронологический по машине: машина, день, смена. Реестр приёма отдаёт их
 * «свежее сверху» — так спрашивают экран, — а книгу читают лентой и подшивают.
 */
function orderShifts(rows: readonly ShiftRow[], labels: Map<string, string>): ShiftRow[] {
  return [...rows].sort((a, b) => {
    const byVehicle = (labels.get(a.row_vehicle) ?? labelOf(a)).localeCompare(
      labels.get(b.row_vehicle) ?? labelOf(b),
      'ru',
    );
    if (byVehicle !== 0) return byVehicle;
    if (a.row_date !== b.row_date) return a.row_date < b.row_date ? -1 : 1;
    return (a.obs_shift_order ?? 1) - (b.obs_shift_order ?? 1);
  });
}

// ── Свод по машинам ──

/** Что книга знает про машину сверх агрегата — из строк её смен. */
interface VehicleExtra {
  drivers: string[];
  anomalies: number;
  fuelSpentLiters: number | null;
  shiftsWithFuel: number;
  shiftsWithRows: number;
}

function extrasByVehicle(rows: readonly ShiftRow[]): Map<string, VehicleExtra> {
  const byVehicle = new Map<string, VehicleExtra>();
  for (const row of rows) {
    const extra = byVehicle.get(row.row_vehicle) ?? {
      drivers: [],
      anomalies: 0,
      fuelSpentLiters: null,
      shiftsWithFuel: 0,
      shiftsWithRows: 0,
    };
    const person = personLabel(row);
    // Прочерк в список людей не идёт: «работник не назван» — это не имя, и в колонке «Водители»
    // оно читалось бы как ещё один человек.
    if (person !== DASH && !extra.drivers.includes(person)) extra.drivers.push(person);
    if (row.odometer_anomaly !== null) extra.anomalies += 1;
    if (row.engine_hours_anomaly !== null) extra.anomalies += 1;
    const spent = fuelSpent(row);
    if (spent !== null) {
      extra.fuelSpentLiters = round1((extra.fuelSpentLiters ?? 0) + spent);
      extra.shiftsWithFuel += 1;
    }
    extra.shiftsWithRows += 1;
    byVehicle.set(row.row_vehicle, extra);
  }
  return byVehicle;
}

const NO_EXTRA: VehicleExtra = {
  drivers: [],
  anomalies: 0,
  fuelSpentLiters: null,
  shiftsWithFuel: 0,
  shiftsWithRows: 0,
};

/**
 * Нарекания по машине словами (Р8) — и они же решают цвет строки. Порядок перечисления — от того,
 * что дороже стоит: несданные смены, разрывы ряда, неподтверждённые аномалии, непринятые отчёты.
 *
 * Пустой список означает «вопросов нет», и только он красит строку зелёным. Считать «нареканий
 * нет» отсутствием одного лишь признака нельзя: машина без единого показания за месяц не имеет ни
 * разрывов, ни аномалий — у неё просто нечему рваться.
 */
function complaints(row: VehicleReadingStatsRow, extra: VehicleExtra): string[] {
  const list: string[] = [];
  if (row.missingReadings > 0) {
    list.push(`не сдано ${plural(row.missingReadings, ['смену', 'смены', 'смен'])}`);
  }
  if (row.gaps > 0) list.push(`${plural(row.gaps, ['разрыв', 'разрыва', 'разрывов'])} ряда`);
  if (extra.anomalies > 0) {
    list.push(`${plural(extra.anomalies, ['аномалия', 'аномалии', 'аномалий'])}`);
  }
  if (row.unacceptedShifts > 0) {
    list.push(`не принято ${plural(row.unacceptedShifts, ['отчёт', 'отчёта', 'отчётов'])}`);
  }
  return list;
}

const SUMMARY_HEADER = [
  'Техника',
  'Тип',
  'Модель',
  'Владение',
  'Смен по плану',
  'Отчитались',
  'Не сдано',
  'Отчётов не принято',
  'Пробег, км',
  'Наработка, м/ч',
  'Одометр на конец, км',
  'Одометр снят',
  'Моточасы на конец',
  'Моточасы сняты',
  'Заправлено, л',
  'Расход, л',
  'Смен с остатками',
  /*
   * Сверка с нормой (план `docs/fuel-norms-plan.md`, §4.3). Колонки стоят РЯДОМ с полным расходом,
   * а не вместо него, и называются иначе не для красоты: это разные величины. «Расход, л» — всё,
   * что сожгли смены с обоими остатками, по живой координате книги; «Расход сверки» — только
   * смены, прошедшие сверку, по снимочной координате агрегата. Слить их в одну колонку значило бы
   * назвать одним словом два числа, которые у машины с переназначенным рейсом не совпадают.
   */
  'Расход сверки, л',
  'Норма, л',
  'Отклонение, %',
  'Сверено смен',
  'Разрывов ряда',
  'Аномалий',
  // Не «Водители»: по недельному ЭСМ-2 работает машинист, и колонка, названная одной из двух
  // должностей, читалась бы как отбор — будто вторых в книге нет (Р13).
  'Водители и машинисты',
  'Нарекания',
];

const SUMMARY_WIDTHS = [
  22, 18, 20, 12, 13, 12, 10, 16, 12, 14, 18, 13, 16, 14, 14, 12, 16, 12, 14, 14, 16, 13, 11, 36, 40,
];

/** Машина со своими числами: строка свода и её же итоги для листа детализации. */
interface VehicleRow {
  stats: VehicleReadingStatsRow;
  extra: VehicleExtra;
  complaints: string[];
  clean: boolean;
}

/**
 * Порядок строк (Р7): сначала машины без нареканий, внутри групп — по подписи. Книгу читают сверху
 * вниз, и «что не закрыто» — вопрос, ради которого её открывают.
 */
function orderVehicles(
  stats: readonly VehicleReadingStatsRow[],
  extras: Map<string, VehicleExtra>,
): VehicleRow[] {
  const rows = stats.map((row) => {
    const extra = extras.get(row.vehicleId) ?? NO_EXTRA;
    const list = complaints(row, extra);
    return { stats: row, extra, complaints: list, clean: list.length === 0 };
  });
  return rows.sort((a, b) => {
    if (a.clean !== b.clean) return a.clean ? -1 : 1;
    return a.stats.vehicleLabel.localeCompare(b.stats.vehicleLabel, 'ru');
  });
}

function summarySheet(
  vehicles: readonly VehicleRow[],
  period: string,
  tolerancePercent: number,
): SheetInput {
  const rows: CellInput[][] = [[`Показания автотранспорта за ${period}`], [], [...SUMMARY_HEADER]];
  const rowStyles: (RowStyle | undefined)[] = [undefined, undefined, undefined];

  for (const vehicle of vehicles) {
    const { stats, extra } = vehicle;
    rows.push([
      stats.vehicleLabel,
      stats.typeName,
      stats.modelName ?? DASH,
      vehicleOwnershipLabels[stats.ownership],
      { num: stats.shifts },
      { num: stats.shifts - stats.missingReadings },
      { num: stats.missingReadings },
      { num: stats.unacceptedShifts },
      num(stats.distanceKm),
      num(stats.engineHours, 1),
      num(stats.lastOdometer?.value ?? null),
      day(stats.lastOdometer?.measuredOn ?? null),
      num(stats.lastEngineHours?.value ?? null, 1),
      day(stats.lastEngineHours?.measuredOn ?? null),
      num(stats.fuelFilledLiters, 1),
      num(extra.fuelSpentLiters, 1),
      // Охват расхода (Р5): без него сумма по трём сменам из двадцати читалась бы как месяц.
      `${extra.shiftsWithFuel} из ${extra.shiftsWithRows}`,
      // Сверка с нормой — числа агрегата, те же, что на экране сводки. Прочерк вместо нуля: у
      // машины без сверяемых смен о расходе сказать нечего.
      stats.verifiedShifts === 0 ? DASH : num(stats.fuelSpentLiters, 1),
      stats.verifiedShifts === 0 ? DASH : num(stats.fuelNormLiters, 1),
      num(fuelDeviation(stats.fuelSpentLiters, stats.fuelNormLiters, tolerancePercent).percent, 1),
      `${stats.verifiedShifts} из ${stats.shiftsWithFuel}`,
      { num: stats.gaps },
      { num: extra.anomalies },
      extra.drivers.join(', ') || DASH,
      vehicle.complaints.join('; ') || DASH,
    ]);
    rowStyles.push(vehicle.clean ? { fill: 'green' } : undefined);
  }

  /*
   * Итог по парку — после пустой строки: попади он в диапазон автофильтра, отбор по любой колонке
   * таскал бы его вместе с данными и складывал бы отфильтрованное с общим.
   */
  const sum = (pick: (row: VehicleRow) => number | null): number =>
    round1(vehicles.reduce((total, row) => total + (pick(row) ?? 0), 0));
  rows.push([]);
  rows.push([
    `Итого по парку — ${plural(vehicles.length, ['машина', 'машины', 'машин'])}`,
    ...Array.from({ length: 7 }, () => ''),
    { num: sum((row) => row.stats.distanceKm) },
    { num: sum((row) => row.stats.engineHours), digits: 1 },
    '',
    '',
    '',
    '',
    { num: sum((row) => row.stats.fuelFilledLiters), digits: 1 },
    { num: sum((row) => row.extra.fuelSpentLiters), digits: 1 },
  ]);
  rowStyles.push(undefined, { bold: true });

  return {
    name: 'Свод',
    headerRow: 3,
    widths: SUMMARY_WIDTHS,
    rows,
    rowStyles,
  };
}

// ── Детализация ──

const DETAIL_HEADER = [
  'Дата',
  'Смена',
  'Водитель / машинист',
  'Источник',
  'Одометр, км',
  'Прирост, км',
  'Моточасы',
  'Прирост, м/ч',
  'Топливо на начало, л',
  'Заправлено, л',
  'Топливо на конец, л',
  'Расход, л',
  'Аномалии',
  'Показание',
  'Отчёт',
];

const DETAIL_WIDTHS = [12, 8, 24, 22, 14, 12, 12, 13, 19, 14, 19, 12, 30, 34, 16];

function detailRow(row: ShiftRow): CellInput[] {
  return [
    day(row.row_date),
    // Позиция смены известна только у строки заведённого отчёта: у ожидаемой смены её ещё нет.
    row.obs_shift_order === null ? DASH : { num: row.obs_shift_order },
    personLabel(row),
    sourceLabel(row),
    num(row.odometer_km),
    num(odometerDelta(row)),
    num(decimal(row.engine_hours), 1),
    num(engineHoursDelta(row), 1),
    num(decimal(row.fuel_start_liters), 1),
    num(decimal(row.fuel_filled_liters), 1),
    num(decimal(row.fuel_end_liters), 1),
    num(fuelSpent(row), 1),
    anomalyText(row),
    readingText(row),
    reportStateText(row),
  ];
}

/**
 * Лист детализации: заголовок машины, её смены, итог по ней (§3.2).
 *
 * Колонки «Техника» в строке смены нет — машина названа заголовком группы и в каждой строке не
 * повторяется. Автофильтра на листе поэтому тоже нет: он поймал бы заголовки групп и строки итогов
 * и перемешал бы их с данными. Вместо него — закреплённая шапка и группировка строк: смены каждой
 * машины сворачиваются кнопкой.
 *
 * Итог по машине берётся из свода, а не складывается по показанным строкам: сумма строк и итог
 * агрегата разошлись бы ровно там, где ряд рвался, — складывать нечего, а итог известен.
 */
function detailSheet(
  vehicles: readonly VehicleRow[],
  rowsByVehicle: Map<string, ShiftRow[]>,
  period: string,
): SheetInput {
  const rows: CellInput[][] = [[`Показания по сменам за ${period}`], [], [...DETAIL_HEADER]];
  const rowStyles: (RowStyle | undefined)[] = [undefined, undefined, undefined];
  const outline: number[] = [0, 0, 0];
  const merges: string[] = [];
  const lastColumn = 'O';

  for (const vehicle of vehicles) {
    const { stats, extra } = vehicle;
    const title =
      `${stats.vehicleLabel} — ${[stats.modelName, stats.typeName].filter(Boolean).join(', ')}` +
      ` · смен ${stats.shifts}, отчитались ${stats.shifts - stats.missingReadings}` +
      ` · ${vehicle.complaints.join('; ') || 'нареканий нет'}`;
    rows.push([title]);
    merges.push(`A${rows.length}:${lastColumn}${rows.length}`);
    rowStyles.push({ fill: vehicle.clean ? 'green' : 'grey', bold: true });
    outline.push(0);

    for (const row of rowsByVehicle.get(stats.vehicleId) ?? []) {
      rows.push(detailRow(row));
      rowStyles.push(undefined);
      outline.push(1);
    }

    rows.push([
      'Итого по машине',
      '',
      '',
      '',
      '',
      num(stats.distanceKm),
      '',
      num(stats.engineHours, 1),
      '',
      num(stats.fuelFilledLiters, 1),
      '',
      num(extra.fuelSpentLiters, 1),
    ]);
    rowStyles.push({ bold: true });
    outline.push(1);

    rows.push([]);
    rowStyles.push(undefined);
    outline.push(0);
  }

  return {
    name: 'Детализация',
    headerRow: 3,
    autoFilter: false,
    widths: DETAIL_WIDTHS,
    rows,
    rowStyles,
    merges,
    outline,
  };
}

// ── Скрытый источник сводной ──

export const SOURCE_SHEET = 'Данные';

export const SOURCE_HEADER = [
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
];

/**
 * Плоский лист-источник сводной таблицы (§3.3).
 *
 * Он повторяет строки «Детализации» — и это осознанная цена: сводная таблица требует, чтобы каждая
 * строка сама себя описывала, а в детализации машина названа заголовком группы. Условие одно и
 * жёсткое: **оба листа рисуются из одного набора строк**, полученного одной выборкой; двух
 * запросов к базе за одними и теми же сменами быть не должно, иначе листы разойдутся между собой.
 *
 * Неизвестные числа здесь — пустые ячейки, а не прочерки: прочерк сделал бы числовое поле кэша
 * смешанным, и сводная перестала бы складывать колонку.
 */
function sourceSheet(rows: readonly ShiftRow[], labels: Map<string, VehicleReadingStatsRow>) {
  return {
    name: SOURCE_SHEET,
    hidden: true,
    freezeHeader: true,
    rows: [
      [...SOURCE_HEADER],
      ...rows.map((row): CellInput[] => {
        const stats = labels.get(row.row_vehicle);
        return [
          stats?.vehicleLabel ?? labelOf(row),
          stats?.typeName ?? row.type_name,
          monthLabel(row.row_date),
          day(row.row_date),
          personLabel(row),
          raw(odometerDelta(row)),
          raw(engineHoursDelta(row), 1),
          raw(decimal(row.fuel_filled_liters), 1),
          raw(fuelSpent(row), 1),
          readingText(row),
          reportStateText(row),
        ];
      }),
    ],
  } satisfies SheetInput;
}

// ── Сводная ──

const PIVOT_SHEET = 'Сводная';
/** Сводная начинается с третьей строки: над ней тот же заголовок с периодом, что и на соседях. */
const PIVOT_START_ROW = 3;

/**
 * Разметка сводной таблицы (§3.3): техника по строкам, месяцы по колонкам, три значения под
 * машиной. Поля «Водитель», «Тип», «Показание» и «Отчёт» лежат в кэше рядом — разрез по ним
 * собирается мышью, без обращения к порталу.
 *
 * «Расход на 100 км» — **вычисляемое поле**, а не колонка источника (Р5). Разница арифметическая:
 * колонка дала бы среднее из отношений по сменам, вычисляемое поле — отношение сумм, то есть
 * настоящий расход за месяц. Среднее из отношений завышает результат на всяком коротком выезде и
 * обсуждается потом как факт.
 */
function pivot(): PivotInput {
  return {
    sheet: PIVOT_SHEET,
    source: SOURCE_SHEET,
    rowField: 'Техника',
    columnField: 'Месяц',
    startRow: PIVOT_START_ROW,
    values: [
      { field: 'Пробег, км', label: 'Пробег, км' },
      { field: 'Заправлено, л', label: 'Заправлено, л', digits: 1 },
      { field: 'Расход, л', label: 'Расход, л', digits: 1 },
    ],
    calculated: [
      {
        name: 'Расход на 100 км',
        // Деление на ноль у машины без пробега даёт не ошибку, а пусто: экскаватор считается по
        // моточасам, и `#ДЕЛ/0!` в его строке читался бы как поломка книги.
        formula: "IF('Пробег, км'>0,'Расход, л'/'Пробег, км'*100,\"\")",
      },
    ],
  };
}

function pivotSheet(period: string): SheetInput {
  return {
    name: PIVOT_SHEET,
    widths: [30, 14, 14, 14, 14, 14],
    rows: [[`Сводная по показаниям за ${period}`]],
    rowStyles: [{ bold: true }],
  };
}

// ── Параметры ──

function parametersSheet(
  request: AdminExportRequest,
  vehicles: readonly VehicleRow[],
  detailRows: number,
  season: FuelNormSeason,
): SheetInput {
  const tolerancePercent = season.tolerancePercent;
  const shifts = vehicles.reduce((total, row) => total + row.stats.shifts, 0);
  const missing = vehicles.reduce((total, row) => total + row.stats.missingReadings, 0);
  return {
    name: 'Параметры',
    widths: [28, 78],
    rows: [
      ['Показания автотранспорта — параметры выгрузки'],
      [],
      ['Период с', { date: request.from }],
      ['Период по', { date: request.to }],
      ['Выгрузил', request.actor],
      ['Выгружено', request.at],
      ['Отбор', 'техника, у которой в периоде были смены'],
      ['Машин в выгрузке', { num: vehicles.length }],
      ['Строк детализации', { num: detailRows }],
      ['Смен ожидалось', { num: shifts }],
      ['Смен отчитались', { num: shifts - missing }],
      [],
      [
        'Зелёная строка',
        'все смены закрыты числовыми показаниями, ряд не рвался, аномалий нет, отчёты приняты',
      ],
      [
        'Расход',
        'остаток на начало + заправлено − остаток на конец; считаются только смены, где известны оба остатка',
      ],
      [
        'Расход сверки',
        'расход смен, прошедших сверку с нормой: оба остатка сданы, пара снимков непрерывна, база положительна. Меньше полного расхода на смены, которые сверить нельзя',
      ],
      [
        'Норма и отклонение',
        'норма — база смены (пробег или моточасы) по ставке сезона из приказа; отклонение — расход сверки против неё, в процентах',
      ],
      ['Допуск сверки', `${tolerancePercent}% — отклонение в его пределах превышением не считается`],
      [
        'Зимний сезон',
        `с ${season.winterFromMd.replace('-', '.')} по ${season.winterToMd.replace('-', '.')}: ставка выбирается датой смены`,
      ],
      ['Прочерк «—»', 'значение неизвестно; в суммы не входит'],
      [
        'Лист «Данные»',
        'скрытый источник сводной таблицы: те же смены плоской таблицей, машина колонкой',
      ],
    ],
    rowStyles: [{ bold: true }],
  };
}

// ── Наружу ──

export interface AdminExportRequest {
  from: string;
  to: string;
  /** Кто выгружает — подписью на листе параметров (Р10, Р12). */
  actor: string;
  /** Когда выгружено, готовой строкой: время книги решает вызывающий, а не сборщик. */
  at: string;
  /** Настройки сверки — решённым значением, по той же причине, что `actor` и `at`. */
  season: FuelNormSeason;
}

export interface AdminExportResult {
  filename: string;
  bytes: Uint8Array;
}

/**
 * Книга целиком. Период приходит уже проверенным на длину (это дело ручки), а вот предел строк
 * стоит здесь и до сборки (Р11): детализация растёт со сменами, а книга собирается в памяти.
 */
export async function buildAdminReadingsExport(
  request: AdminExportRequest,
): Promise<AdminExportResult> {
  const { from, to } = request;

  /*
   * Настройки сверки читаются один раз и передаются листам значением (план, §3.1): допуск нужен
   * своду (отклонение печатается числом) и «Параметрам» (там он назван словами), а второе чтение
   * означало бы два разных допуска в одной книге.
   */
  const season = request.season;
  const [stats, shifts] = await Promise.all([loadFleetStats(from, to), loadIntakeRows(from, to)]);

  /*
   * Предел (Р11) считается по строкам, которые попадут в книгу, и потому после выборки, а не
   * счётным запросом до неё: строка книги — ожидаемая смена, а их число живёт в том же отборе,
   * что и сами строки. Отдельный счётчик был бы вторым правилом «сколько строк в книге», и
   * разойдись он с выборкой — предел срабатывал бы не на той книге, которую собирают.
   */
  if (shifts.length > READING_EXPORT_ROW_LIMIT) {
    throw err.badRequest(
      `В выгрузку попадает ${shifts.length} строк, предел — ${READING_EXPORT_ROW_LIMIT}: сузьте период`,
      { to: 'Сузьте период' },
    );
  }

  const extras = extrasByVehicle(shifts);
  const vehicles = orderVehicles(stats, extras);
  const labels = new Map(stats.map((row) => [row.vehicleId, row]));
  const ordered = orderShifts(
    shifts,
    new Map(stats.map((row) => [row.vehicleId, row.vehicleLabel])),
  );
  const rowsByVehicle = new Map<string, ShiftRow[]>();
  for (const row of ordered) {
    const list = rowsByVehicle.get(row.row_vehicle) ?? [];
    list.push(row);
    rowsByVehicle.set(row.row_vehicle, list);
  }

  const period = periodLabel(from, to);
  const sheets: SheetInput[] = [
    summarySheet(vehicles, period, season.tolerancePercent),
    detailSheet(vehicles, rowsByVehicle, period),
    pivotSheet(period),
    parametersSheet(request, vehicles, ordered.length, season),
    sourceSheet(ordered, labels),
  ];

  return {
    filename: `Показания автотранспорта ${period}.xlsx`,
    // Сводная собирается по скрытому листу-источнику, и книга без единой смены остаётся книгой:
    // источник пуст — сводная не заводится, остальные листы на месте.
    bytes: writeWorkbook(sheets, pivot()),
  };
}
