import {
  DAY_BATCH_LIMIT,
  dayBatchPortionMessage,
  shiftDaysOf,
  type DayBatchApplyBody,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';

/**
 * Form fields of the day-batch block. The names are shared by both dialogs on purpose: one function
 * (`dayBatchBody`) builds the batch body, and a second name for the same field would silently
 * diverge from it — the form would send the chosen driver nowhere.
 */
export interface DayBatchFormValues {
  dayBatchDriverId?: string;
  /** The checkbox of the take-into-work dialog; the batch dialog has none — there it is the whole dialog. */
  dayBatchEnabled?: boolean;
  /** Whether to issue waybills or only place days into routes (asked in the batch dialog). */
  dayBatchIssue?: boolean;
  /** Backdate reason — one for the whole batch, not one per past day. */
  dayBatchReason?: string;
}

export interface DayBatchTerm {
  dateFrom: string;
  dateTo: string | null;
}

export interface DayBatchMachinist {
  name?: string | null;
  personId?: string;
}

/**
 * The batch body. Built in exactly one place: a second builder would drift from the first on the
 * first new field, and one of the two dialogs would start sending something other than it shows.
 */
export function dayBatchBody(values: DayBatchFormValues, operationId: string): DayBatchApplyBody {
  return {
    driverPersonId: values.dayBatchDriverId!,
    /*
     * The field was not asked — so waybills are wanted. That is how the take-into-work dialog works:
     * its checkbox says "issue 4-P for the whole period", and a split "routes first, paper later"
     * contradicts it. Only the batch dialog, where missed days are collected, asks about it.
     */
    issueWaybills: values.dayBatchIssue ?? true,
    // An empty reason goes as an absent key, not an empty string: "no explanation given" and "the
    // explanation is empty" are different things, and the door schema accepts only the first.
    ...(values.dayBatchReason?.trim() ? { reason: values.dayBatchReason.trim() } : {}),
    /*
     * The replay key is fresh for every click (ADR 0207, decision 11). It is not about a double
     * click: by it the server recognises its own interrupted request and does not issue a second
     * stack of forms for the same days. The remainder collected by a repeated click is a different
     * operation, and its key is different.
     *
     * The request editor deliberately does the opposite — one backdate key per open dialog (ADR
     * 0101, R31, see `useVehicleRequestEditorState`): there a repeated click after a timeout is the
     * same edit, and a new key would burn a second strict-reporting form number.
     */
    operationId,
  };
}

/**
 * Derive all batch-day presentation facts without React state. The server still decides which
 * individual days can be planned; this model only explains the requested term and driver choice.
 *
 * - `portionHint`: a term longer than one portion is not a ban but a promise of a remainder (ADR
 *   0207 decision 11): the batch takes the first `DAY_BATCH_LIMIT` unplanned days and a repeated
 *   click collects the rest. Refusing the whole term would cut a quarter-long order off the button —
 *   the very case it was asked for. The remainder named here is an upper bound: the portal does not
 *   know how many days already sit in routes (the batch skips them and they take no place in the
 *   portion); the exact remainder comes with the answer (`remaining`) and the report repeats it in
 *   the same words.
 * - `pastDays`: the reason is asked because of them — one per batch, not per day.
 * - `defaultDriverId`: the driver defaults to the request machinist, and only into an empty field.
 *   The portal fills a person exactly here because ADR 0207 decision 6 named this concession: no
 *   waybill without a driver, and fifty empty fields is not a batch. A chosen name is never
 *   overwritten: a person's choice always outranks a portal hint. Only someone the list names is
 *   filled: a blind default would show a bare id instead of a surname, and a removed machinist card
 *   would fail the whole batch on its first day ("Driver not found") — the batch asks for the
 *   person once for the whole period, so a mistake there costs every day, not one.
 * - `machinistNote`: one line, because the case is always one of two. The machinist is not in the
 *   selection — the empty field must explain itself, otherwise it reads as "the portal knows
 *   nobody" and the dispatcher searches the directory instead of the selection date. The machinist
 *   is there but someone else drives — the dialog names the divergence (ADR 0207 decision 6) and
 *   does not forbid it: a substitute driver on Saturday is legal. Both at once would be the same
 *   news twice.
 */
export function dayBatchModel(input: {
  driverId?: string;
  driverOptions: ReadonlyArray<{ value: string }>;
  driverSelectionReady: boolean;
  machinist: DayBatchMachinist | null;
  onDate: string;
  term: DayBatchTerm;
}): {
  defaultDriverId?: string;
  days: string[];
  machinistNote: string | null;
  pastDays: string[];
  portionHint: string | null;
} {
  const days = shiftDaysOf(input.term);
  const pastDays = days.filter((date) => date < input.onDate);
  const machinistId = input.machinist?.personId;
  const machinistListed =
    !!machinistId && input.driverOptions.some((option) => option.value === machinistId);
  const machinistNote =
    input.driverSelectionReady && input.machinist?.name && machinistId && !machinistListed
      ? `Машинист заявки (${input.machinist.name}) в отборе водителей на ${formatDateOnly(input.term.dateFrom)} не значится — выберите, кто поедет`
      : input.machinist?.name && machinistId && input.driverId && input.driverId !== machinistId
        ? `Листы уйдут не на машиниста заявки (${input.machinist.name}), а на выбранного здесь человека`
        : null;
  return {
    defaultDriverId: machinistListed ? machinistId : undefined,
    days,
    machinistNote,
    pastDays,
    portionHint: days.length > DAY_BATCH_LIMIT ? dayBatchPortionMessage(days.length) : null,
  };
}
