import {
  DAY_BATCH_LIMIT,
  dayBatchPortionMessage,
  shiftDaysOf,
  type DayBatchApplyBody,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';

export interface DayBatchFormValues {
  dayBatchDriverId?: string;
  dayBatchEnabled?: boolean;
  dayBatchIssue?: boolean;
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

/** Build the second command sent after a request has successfully entered work. */
export function dayBatchBody(values: DayBatchFormValues, operationId: string): DayBatchApplyBody {
  return {
    driverPersonId: values.dayBatchDriverId!,
    // The assignment dialog means "issue 4-P"; only the standalone dialog exposes this switch.
    issueWaybills: values.dayBatchIssue ?? true,
    ...(values.dayBatchReason?.trim() ? { reason: values.dayBatchReason.trim() } : {}),
    operationId,
  };
}

/**
 * Derive all batch-day presentation facts without React state. The server still decides which
 * individual days can be planned; this model only explains the requested term and driver choice.
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
