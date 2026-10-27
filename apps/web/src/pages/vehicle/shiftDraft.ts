import {
  type ApproveVehicleRequestShiftInput,
  MAX_MACHINE_HOURS,
  refuelLabel,
  type SaveVehicleRequestShiftBody,
  shiftSourceOf,
  type VehicleRequestShiftDto,
} from '@technic/contracts';

/**
 * The shift window's form of a day (readings-shifts-merge plan §6.7): what the person sees in the
 * inputs and what the window sends. Kept apart from the window so the rules of a driver day are
 * read in one place and the window stays a table.
 */

/** What the person typed and has not saved yet. */
export interface Draft {
  startedAt?: string;
  endedAt?: string;
  machineHours?: number | null;
  refuel?: string;
  comment?: string;
}

/** The day's numbers are the driver's: hours and refuelling are corrected in the garage, not here. */
export function isDriverDay(shift: VehicleRequestShiftDto): boolean {
  return shiftSourceOf(shift) === 'driver';
}

/**
 * The partial numbers of a non-clean driver day the form may start from: the site still decides
 * and must save them consciously before signing (D3). Only a sum a shift can hold is offered.
 */
export function driverPrefill(shift: VehicleRequestShiftDto): Draft | null {
  const day = shift.driverDay;
  if (shiftSourceOf(shift) !== null || !day || day.clean || day.machineHours === null) return null;
  if (day.machineHours < 0 || day.machineHours > MAX_MACHINE_HOURS) return null;
  return { machineHours: day.machineHours, refuel: refuelLabel(day.refuelLiters) };
}

/**
 * The form of a day, initialized by its source, not by `filledAt`: a driver day without a site
 * row has numbers, and an unfilled day may start from the driver's partial sum.
 */
export function draftOf(shift: VehicleRequestShiftDto): Draft {
  const filled = shiftSourceOf(shift) !== null;
  return {
    startedAt: shift.startedAt ?? undefined,
    endedAt: shift.endedAt ?? undefined,
    machineHours: filled ? shift.machineHours : null,
    refuel: shift.refuel,
    comment: shift.comment,
    ...driverPrefill(shift),
  };
}

/**
 * The save body. On a driver day the hours and refuelling are the driver's as shown, and the
 * fingerprint names them — the server writes its own numbers and refuses a stale view with 409.
 * Anywhere else no fingerprint is sent: an older server rejects the unknown key of a strict body.
 */
export function saveBody(shift: VehicleRequestShiftDto, draft: Draft): SaveVehicleRequestShiftBody {
  const driver = isDriverDay(shift) && shift.driverDay;
  return {
    startedAt: draft.startedAt ?? null,
    endedAt: draft.endedAt ?? null,
    machineHours: driver ? shift.machineHours : (draft.machineHours ?? 0),
    refuel: driver ? shift.refuel : (draft.refuel ?? ''),
    comment: draft.comment ?? '',
    ...(driver ? { expectedDriverFingerprint: driver.fingerprint } : {}),
  };
}

/** The sign-off body: a driver day is signed with the fingerprint of the numbers shown. */
export function approveBody(
  shift: VehicleRequestShiftDto,
  approved: boolean,
): ApproveVehicleRequestShiftInput {
  const driver = approved && isDriverDay(shift) && shift.driverDay;
  return driver ? { approved, expectedDriverFingerprint: driver.fingerprint } : { approved };
}
