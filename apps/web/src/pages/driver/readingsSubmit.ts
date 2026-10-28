import {
  driverReadingCompletenessIssues,
  lineRequiresDriverTimes,
  readingInputSchema,
  type DriverAssignmentEntry,
  type DriverPreviousReading,
  type DriverReportDto,
  type ReadingInput,
  type ReportItemDto,
  type ReportItemSubmit,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';
import { parseReadingNumber } from '@entities/vehicle-reading';
import type { DraftItem } from './api';
import { blockChecks, numberOrNull, previousOfItem, readingNumbers } from './readingChecks';
import { emptyItem, savedItem, sourceKey } from './readingsDraft';
import { parseTime, stopPointTimes, stopsOf, type ShownStop } from './readingStops';
import { buildTimes, timeFields } from './readingsTimes';

/**
 * Тело отправки показаний: что уходит на сервер и что вместо этого показывается отказом на блоке
 * (ADR 0103; план кабинета водителя, Р6).
 *
 * Отдельным модулем от страницы по той же причине, что и `readingsDraft`: вместе они переваливают
 * за 400 строк — порог бюджета качества (`scripts/quality.mjs`). Граница честная: здесь чистая
 * проверка введённого, там — запись черновика, сеть и порядок шагов при отказе.
 */

/**
 * Что вышло из блока: строка отправки, отказы по полям или «эта строка отправке не подлежит».
 *
 * У пропуска два разных повода, и различать их обязан не только автор кода: `closed` — строку
 * закрыл персонал, водителю сдавать по ней нечего; `blank` — сдавать было что, но человек ничего
 * не ввёл. День, состоящий из одних `closed`, и день из одних `blank` дают одинаково пустое тело и
 * совершенно разные новости человеку (Р6).
 */
type BuiltItem =
  | { submit: ReportItemSubmit; notes: string[] }
  | { errors: Record<string, string> }
  | { skip: 'closed' | 'blank' };

/**
 * Сообщения схемы — по именам полей блока: их и подсвечивает форма. A refusal about the stop set
 * as a whole stands under the route block: no single field is named by it.
 */
function issueMessages(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const result: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? 'form');
    result[key === 'points' ? timeFields.route : key] = issue.message;
  }
  return result;
}

/**
 * A submit row: the reading, the files newly uploaded and the driver's confirmation of the
 * discrepancies shown for it.
 *
 * One flag for both counters on purpose: what is confirmed is the shown warning as a whole, not
 * "odometer" and "engine hours" apart — and the server applies a confirmation only where an anomaly
 * really exists. The flag is not read from the draft: it follows the submit window's answer
 * (ADR 0237), so a confirmation typed earlier can never stand in for the question asked now.
 */
function submitItem(itemId: string, reading: ReadingInput, value: DraftItem, confirm: boolean) {
  const row: ReportItemSubmit = {
    itemId,
    reading,
    fileIds: value.files.map((file) => file.id),
    confirmOdometerAnomaly: confirm,
    confirmEngineHoursAnomaly: confirm,
  };
  return row;
}

/**
 * Builds the submit row or the refusals of a block. The number format is the contract schema's,
 * plausibility is the input warnings' (Р6), and since ADR 0237 completeness is the contract's
 * `driverReadingCompletenessIssues`. A `no_data` kind is not built here: staff alone close a row
 * without readings (Р4), and the server refuses a driver's submit of that kind.
 *
 * **An empty block is skipped only for a NEW row, and it is not an optimisation but two different
 * events in the ledger** (Р6). A row without a saved reading means "nobody has looked at this
 * vehicle yet": a day with two vehicles, one filled, must go — the other shift is sent when it ends.
 * The same emptiness over an existing `values` reading means the opposite: the person ERASED the
 * last number, which is a command, not silence. Skip it and the body leaves without the row, the
 * server keeps the old value and the portal shows a success — the erasure would vanish quietly. An
 * emptied `values` therefore goes on and is refused as incomplete.
 *
 * **A block the driver started is whole or it does not go** (ADR 0237): both fuel levels, one of the
 * two counters, and every time the shift needs. All refusals of a block stand at once, each under
 * its field, so a person fixing one does not learn about the next only on the next tap. A block
 * resent unchanged is not judged again (`changed`): a staff entry or a morning part saved by an older
 * build must not hold the day.
 */
function buildItem(
  item: ReportItemDto,
  value: DraftItem,
  previous: DriverPreviousReading | null,
  stops: readonly ShownStop[],
  changed: boolean,
  timesRequired: boolean,
): BuiltItem {
  const numbers = readingNumbers(value);
  // Time refusals stand next to the number refusals, not after them: a driver fixing an odometer
  // typo should not learn only on the next tap that the end time is missing too (ADR 0234, D11).
  const times = buildTimes({ item, value, stops, required: timesRequired, numbers });
  const broken = Object.entries(numbers).filter(([, v]) => v === 'invalid');
  if (broken.length > 0) {
    const refused = Object.fromEntries(broken.map(([field]) => [field, 'Введите число']));
    return { errors: { ...times.errors, ...refused } };
  }

  /*
   * "No numbers at all" is not the same as "the block is empty": a comment and a file do not count
   * as emptiness, on purpose (Р6). A person who attached a photo of the dashboard or wrote "the
   * odometer is broken" expects it to go; skip such a block and the attachment and the text would
   * vanish without a word. The completeness refusal answers it, and it stands on this block.
   */
  const noNumbers =
    !value.odometerKm &&
    !value.engineHours &&
    !value.fuelStartLiters &&
    !value.fuelFilledLiters &&
    !value.fuelEndLiters;

  // A row staff closed as `no_data` is the first branch and never reaches the general emptiness
  // rule: its saved comment arrives in the fields with the reading, and by the general rule it would
  // stop counting as empty — one foreign block would again hold the whole day. The driver does not
  // edit this row; a number typed into it goes as an ordinary reading.
  if (item.reading?.kind === 'no_data' && noNumbers && !times.typed) return { skip: 'closed' };

  // A new row with nothing touched is "not reached yet", not a command. The condition checks the
  // absence of a saved reading, not its emptiness: a saved `values` erased on screen looks the same
  // from here and must reach the refusals (see the header). A typed time is input too: alone it
  // does not make a reading (ADR 0234), so it is refused as incomplete instead of vanishing.
  const untouched = noNumbers && !times.typed && !value.comment.trim() && value.files.length === 0;
  if (!item.reading && untouched) return { skip: 'blank' };

  const { hard, notes } = blockChecks(item, value, previous, changed);
  // A gross error is never let through: confirming a typo in a digit is pointless, it would be
  // confirmed as it was typed. A soft one is confirmed in the submit window (ADR 0237).
  const refused: Record<string, string> = { ...times.errors };
  for (const warning of hard) refused[warning.field] ??= warning.text;
  if (changed) {
    const incomplete = driverReadingCompletenessIssues({
      odometerKm: numberOrNull(numbers.odometerKm),
      engineHours: numberOrNull(numbers.engineHours),
      fuelStartLiters: numberOrNull(numbers.fuelStartLiters),
      fuelEndLiters: numberOrNull(numbers.fuelEndLiters),
    });
    for (const [field, text] of Object.entries(incomplete)) refused[field] ??= text;
  }
  if (Object.keys(refused).length > 0) return { errors: refused };

  const parsed = readingInputSchema.safeParse({
    kind: 'values',
    ...numbers,
    ...times.keys,
    comment: value.comment,
  });
  if (!parsed.success) return { errors: issueMessages(parsed.error.issues) };
  return { submit: submitItem(item.id, parsed.data, value, notes.length > 0), notes };
}

const NUMBER_FIELDS = [
  'odometerKm',
  'engineHours',
  'fuelStartLiters',
  'fuelFilledLiters',
  'fuelEndLiters',
] as const;

/**
 * Whether the block says something other than its saved reading — the cabinet's preview of the
 * readings service's content comparison, which decides whether the driver's time rule judges the
 * line at all (`lineRequiresDriverTimes`). A staff entry without times resent untouched must not
 * hold the day here either, or the phone would refuse what the server accepts.
 *
 * Read as the server stores it: numbers to the column's tenth, times and stops as the rules read
 * them, the comment trimmed as the schema trims it. Files never count — they move no content
 * version (Р22). A block without a saved reading, or over a staff `no_data` one, is always the
 * driver's word.
 */
export function blockChanged(
  item: ReportItemDto,
  value: DraftItem,
  stops: readonly ShownStop[],
): boolean {
  const saved = savedItem(item);
  if (!saved || item.reading?.kind !== 'values') return true;
  const tenths = (raw: string) => {
    const number = parseReadingNumber(raw);
    return typeof number === 'number' ? Math.round(number * 10) : number;
  };
  if (NUMBER_FIELDS.some((field) => tenths(value[field]) !== tenths(saved[field]))) return true;
  if (value.comment.trim() !== saved.comment.trim()) return true;
  if (item.sourceKind === 'esm2') {
    return (
      parseTime(value.startedAt) !== parseTime(saved.startedAt) ||
      parseTime(value.endedAt) !== parseTime(saved.endedAt)
    );
  }
  const typed = stopPointTimes(stops, value.stops);
  return JSON.stringify(typed) !== JSON.stringify(stopPointTimes(stops, saved.stops));
}

/**
 * What a block says about its own input that the driver must confirm before it leaves (ADR 0237):
 * the discrepancies with the previous shift and the anomalies nobody confirmed. `label` names the
 * block the way the form does — vehicle first, source after — so two shifts of one vehicle in the
 * list are told apart.
 */
export interface SubmitDiscrepancy {
  itemId: string;
  label: string;
  notes: string[];
}

/**
 * The submit body for every row of the report — and the refusals by block if any did not pass. The
 * refusals come together with the rows, not instead of them: the page highlights the block and leads
 * to the first wrong one rather than showing one message for the whole day (ADR 0094).
 *
 * Values are addressed by source, the same key as the draft (Р11): a row's `itemId` lives only in
 * the report and does not survive everything.
 */
export interface SubmitBody {
  items: ReportItemSubmit[];
  errors: Record<string, Record<string, string>>;
  /**
   * The body is empty although there was something to fill: at least one open row was skipped as
   * untouched (Р6). The flag is computed here, not guessed by the page again: only the build knows
   * why no rows are left — "staff closed the whole day" and "the day is simply not filled" look the
   * same as an empty body, and they are two different pieces of news for a person.
   *
   * Field refusals outrank the flag: if any block refused, the page shows them and never reaches the
   * footer.
   */
  emptyOpenDay: boolean;
  /**
   * The blocks whose rows carry a confirmation flag. Not empty — the page asks the driver before
   * the day leaves, and a refusal there sends nothing. The flags are already set in `items`: they
   * are part of the body's fingerprint, so a retry after a lost answer repeats the same body.
   */
  discrepancies: SubmitDiscrepancy[];
}

/** «А123ВС 77 · Р-142»: the vehicle first, then the source that tells its shifts apart. */
const blockLabel = (item: ReportItemDto) =>
  [item.vehicleLabel, item.sourceLabel].filter(Boolean).join(' · ');

export function buildSubmitBody(
  report: DriverReportDto,
  values: Record<string, DraftItem>,
  entryOf: (item: ReportItemDto) => DriverAssignmentEntry | null,
): SubmitBody {
  const items: ReportItemSubmit[] = [];
  const errors: Record<string, Record<string, string>> = {};
  const discrepancies: SubmitDiscrepancy[] = [];
  let blank = false;
  for (const item of report.items) {
    const entry = entryOf(item);
    const value = values[sourceKey(item)] ?? emptyItem();
    const stops = stopsOf(item, entry);
    const changed = blockChanged(item, value, stops);
    // The rule follows the report's stored format, not this build (ADR 0234, decision 6), and
    // judges only the lines the driver changes.
    const timesRequired = lineRequiresDriverTimes(report.draftFormat, changed);
    const previous = previousOfItem(item, report, values, entry);
    const built = buildItem(item, value, previous, stops, changed, timesRequired);
    if ('submit' in built) {
      items.push(built.submit);
      if (built.notes.length > 0) {
        discrepancies.push({ itemId: item.id, label: blockLabel(item), notes: built.notes });
      }
    } else if ('errors' in built) errors[item.id] = built.errors;
    else if (built.skip === 'blank') blank = true;
  }
  return { items, errors, emptyOpenDay: items.length === 0 && blank, discrepancies };
}

/** Что делать с неудачной отправкой: сказать словами, закрывать ли попытку и перечитывать ли день. */
export interface SubmitFailure {
  message: string;
  /** Исход назван сервером — попытка закрывается, следующая отправка получит свой ключ (Р12а). */
  settled: boolean;
  /** Строки разошлись с сервером: их надо перечитать, иначе следующая отправка даст тот же 409. */
  stale: boolean;
}

/**
 * Р12а различает «сервер сказал об исходе» и «ответа не было», и различие это не про вежливость: у
 * попытки, оставшейся `pending`, повтор уходит ТЕМ ЖЕ ключом и той же версией — иначе он станет
 * второй отправкой того же дня.
 *
 * Ответом самого API считается только отказ с кодом и статусом ниже 500: проверка, конфликт версий,
 * занятый ключ. Всё остальное исхода не называет — 502, 503 и 504 приходят от шлюза, за которым
 * транзакция API могла и закоммититься, а обрыв связи не приходит вовсе. Пятисотка самого API
 * читается тем же обрывом: отличить её от шлюзовой нечем, а размен очевиден — лишний повтор
 * идемпотентного ключа не стоит ничего, сервер отвечает на него текущим состоянием.
 */
export function submitFailure(e: unknown): SubmitFailure {
  const answered = isApiError(e) && e.status < 500 ? e : null;
  return {
    message: errorMessage(e),
    settled: answered !== null,
    // 409 — либо расхождение версий (состав дня успели изменить), либо тот же ключ с другим телом;
    // и то, и другое лечится одним: перечитать строки.
    stale: answered?.status === 409,
  };
}
