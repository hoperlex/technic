import dayjs from 'dayjs';
import {
  type AddressMeta,
  normalizeTimeInput,
  type VehicleRequestTripDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';

/** Pure conversions between request-trip DTOs, form rows, and API bodies. */

/**
 * One trip row in form values.
 *
 * Fields stay optional because an incomplete row is valid while the user is typing. Field-level
 * rules establish the stricter shape before a request body can be built.
 */
export interface TripFormValue {
  /**
   * Client-only stable key used by React and list editing; it is never sent to the server.
   *
   * An index is not stable enough: removing a middle row would move stateful address controls to
   * different trips.
   *
   * It is not the trip ID either because new rows do not receive one until the server creates them.
   */
  key: string;
  /** Persisted trip ID; absence marks a row that the server must create. */
  id?: string;
  fromLocation?: string;
  toLocation?: string;
  /**
   * Address metadata (ADR 0006) lives in hidden fields so resets and value replacement remain
   * atomic with the visible address string.
   *
   * `null` is meaningful for legacy backfilled trips; the form preserves it instead of inventing
   * metadata for historical data.
   */
  fromAddress?: AddressMeta | null;
  toAddress?: AddressMeta | null;
  fromResponsibleName?: string;
  fromResponsiblePhone?: string;
  toResponsibleName?: string;
  toResponsiblePhone?: string;
  volumeM3?: number | null;
  weightTons?: number | null;
  /**
   * Optional trip-specific delivery time in `HH:mm`; empty means "use the request time".
   *
   * Only wall-clock time is editable. The request owns the day (`tripsOutOfRequestDay`), so a date
   * stored on the row could become stale when the request date changes.
   */
  scheduledTime?: string;
  comment?: string;
}

/** Generate a stable client-side key for a new row. */
function tripKey(): string {
  return crypto.randomUUID();
}

/** Empty row used for a new request and the add-trip action. */
export function blankTrip(): TripFormValue {
  return { key: tripKey(), volumeM3: null, weightTons: null };
}

/**
 * Map a persisted trip without normalizing legacy unverified addresses or empty contacts; an edit
 * must not require invented historical data.
 */
export function tripToForm(t: VehicleRequestTripDto): TripFormValue {
  return {
    key: tripKey(),
    id: t.id,
    fromLocation: t.fromLocation,
    toLocation: t.toLocation,
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    fromResponsibleName: t.fromResponsibleName,
    fromResponsiblePhone: t.fromResponsiblePhone,
    toResponsibleName: t.toResponsibleName,
    toResponsiblePhone: t.toResponsiblePhone,
    volumeM3: t.volumeM3,
    weightTons: t.weightTons,
    // Convert the absolute instant to Moscow time; parsing it as Moscow wall time would discard
    // the supplied offset and display a delivery three hours early.
    scheduledTime: t.scheduledAt ? dayjs(t.scheduledAt).tz(MOSCOW_TZ).format('HH:mm') : undefined,
    comment: t.comment,
  };
}

/**
 * A trip needs the expanded list when its own time or note would be hidden by the compact editor.
 * The request card shares this rule so view and edit modes expose the same information.
 */
export function tripNeedsList(t: VehicleRequestTripDto): boolean {
  return !!t.scheduledAt || !!t.comment;
}

/**
 * Convert a persisted trip into a new row for request copying (ADR 0173).
 *
 * The ID is removed because copied trips are new records and must never refer to source rows.
 *
 * Unlike `repeatTrip`, request copying preserves the time because the source schedule is part of
 * the repeated order. The request supplies the new day separately.
 */
export function copyTrip(t: VehicleRequestTripDto): TripFormValue {
  const copy = tripToForm(t);
  delete copy.id;
  return copy;
}

/**
 * Repeat a row so a repeated route can be entered once and expanded into several trips.
 *
 * Addresses, contacts, quantities, and the note are preserved. Two values are deliberately reset:
 *
 * - the ID, because every repeated row is a new server record;
 * - the trip-specific time, because several vehicles should not be claimed to arrive together.
 *   Empty means the schedule has not yet been refined beyond the request time.
 */
export function repeatTrip(source: TripFormValue, times: number): TripFormValue[] {
  return Array.from({ length: times }, () => {
    const copy: TripFormValue = { ...source, key: tripKey() };
    delete copy.id;
    delete copy.scheduledTime;
    return copy;
  });
}

/**
 * Build a trip timestamp from its time and the request day; `null` means no override.
 *
 * The request must supply the day because `tripsOutOfRequestDay` rejects any other calendar day.
 */
function tripScheduledAt(time: string | undefined, requestDay: string): string | null {
  const normalized = normalizeTimeInput(time ?? '');
  if (normalized === undefined) return null;
  return dayjs.tz(`${requestDay} ${normalized}`, MOSCOW_TZ).format('YYYY-MM-DDTHH:mm:ssZ');
}

/**
 * Fields shared by create and edit bodies. `updateRequestTripSchema` extends the create schema,
 * so both paths must derive these values identically.
 *
 * Non-null assertions are backed by field validation, which prevents body construction while a
 * required value is missing.
 */
function tripCommonFields(v: TripFormValue, requestDay: string) {
  return {
    fromLocation: v.fromLocation!,
    toLocation: v.toLocation!,
    volumeM3: v.volumeM3 ?? null,
    weightTons: v.weightTons ?? null,
    fromResponsibleName: v.fromResponsibleName!,
    fromResponsiblePhone: v.fromResponsiblePhone!,
    toResponsibleName: v.toResponsibleName!,
    toResponsiblePhone: v.toResponsiblePhone!,
    scheduledAt: tripScheduledAt(v.scheduledTime, requestDay),
    comment: v.comment ?? '',
  };
}

/**
 * Trip body for create and conversion to freight transport (ADR 0091).
 *
 * New rows require verified address metadata (ADR 0006) and omit IDs because the server creates
 * them from scratch.
 */
export function newTripBody(v: TripFormValue, requestDay: string) {
  return {
    ...tripCommonFields(v, requestDay),
    fromAddress: v.fromAddress!,
    toAddress: v.toAddress!,
  };
}

/**
 * Edit body for full-list synchronization: rows with IDs update, rows without IDs create, and
 * omitted rows are soft-deleted.
 *
 * Preserve metadata including `null`: for a legacy row it means "unchanged historical address",
 * not "no address selected". The server requires verification only when that field changes.
 */
export function editTripBody(v: TripFormValue, requestDay: string) {
  return {
    ...tripCommonFields(v, requestDay),
    ...(v.id ? { id: v.id } : {}),
    fromAddress: v.fromAddress ?? null,
    toAddress: v.toAddress ?? null,
  };
}
