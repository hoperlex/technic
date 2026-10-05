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
   * Not the index: rows are removed from the middle, and neighbours would shift together with the
   * state of their fields — the address field remembers whether it was typed with suggestions or
   * picked from the directory, so after removing the second trip the sixth would open in another
   * row's mode.
   *
   * Not the trip ID either: a new row has none — the server assigns the number (R13a).
   */
  key: string;
  /** Persisted trip ID (R2a); absence marks a row that the server must create. */
  id?: string;
  fromLocation?: string;
  toLocation?: string;
  /**
   * Address metadata (ADR 0006) lives in hidden fields so resets and value replacement remain
   * atomic with the visible address string.
   *
   * `null` means no metadata: that is how a trip backfilled from a request older than ADR 0006
   * arrives. The form does not invent it and sends it back as is (R2a).
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
   * Optional trip-specific delivery time in `HH:mm` (R3); empty means "use the request time".
   *
   * A time, not a moment: the trip day is the request day and must stay so
   * (`tripsOutOfRequestDay`). If the form asked for a date, the first edit of the request delivery
   * would leave the trips in yesterday, and the server would answer 422 on a field nobody touched.
   */
  scheduledTime?: string;
  comment?: string;
}

/** Stable client-side key for a new row (same generator as the backdate operation key). */
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
 *
 * They cannot be hidden — "what time exactly for this one" and "sand, call an hour ahead" are the
 * reason they were filled in; showing them for every request would complicate input for those
 * with a single trip (§4.1). The request card shares this rule to decide whether to show a trip as
 * a pair of fields: if the two diverged, the same request would look simple in the card and as a
 * list in the editor.
 */
export function tripNeedsList(t: VehicleRequestTripDto): boolean {
  return !!t.scheduledAt || !!t.comment;
}

/**
 * Convert a persisted trip into a new row for request copying (ADR 0173).
 *
 * The only difference from `tripToForm` is the removed `id`: copied trips are new records and the
 * server numbers them. An `id` in the create body would be rejected by the `.strict()` schema, and
 * if it passed, the request would refer to another request's rows.
 *
 * Unlike `repeatTrip`, the delivery time is **kept** — they answer different questions. There one
 * trip becomes six, and six vehicles in a shift follow a schedule rather than arriving together;
 * here the same order is repeated on another day, and "first at 8:00, second at 14:00" is exactly
 * what is copied. The day is not part of `scheduledTime` (hours and minutes only), so moving the
 * copy's delivery carries the time along and cannot break the day boundary
 * (`tripsOutOfRequestDay`).
 */
export function copyTrip(t: VehicleRequestTripDto): TripFormValue {
  const copy = tripToForm(t);
  delete copy.id;
  return copy;
}

/**
 * Repeat a row ("repeat N times", §4.1): "six times from the quarry to the site" is entered once.
 *
 * Addresses with metadata, contacts, quantities, and the note are preserved. Two values are
 * deliberately reset:
 *
 * - the `id` — every repeated row is a new trip numbered by the server (R13a); six rows sharing one
 *   `id` would mean six overwrites of the same trip;
 * - the trip-specific time — six trips in a shift follow a schedule, not one moment (R3), and one
 *   shared hour would claim the opposite on the requester's behalf. Empty reads as "same as the
 *   request", i.e. "not refined yet", which is the truth right after copying.
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
 * Build a trip timestamp from its time and the request day; `null` means no override (R3).
 *
 * The day comes from the request, not the trip: the trip time must lie in the delivery calendar
 * day (R18, `tripsOutOfRequestDay`), and assembling the moment from anything else could build one
 * the server rejects.
 */
function tripScheduledAt(time: string | undefined, requestDay: string): string | null {
  const normalized = normalizeTimeInput(time ?? '');
  if (normalized === undefined) return null;
  return dayjs.tz(`${requestDay} ${normalized}`, MOSCOW_TZ).format('YYYY-MM-DDTHH:mm:ssZ');
}

/**
 * Fields shared by create and edit bodies. Lengths, quantity precision and the work window are the
 * same in both schemas (`updateRequestTripSchema` extends `requestTripSchema`), so a second
 * assembly of the same fields would drift from the first on the next change.
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
 * Edit body for full-list synchronization (§7): rows with IDs update, rows without IDs create, and
 * omitted rows are soft-deleted (R13a).
 *
 * Metadata is sent **as is**, including `null`: a trip from a request older than ADR 0006 has none,
 * and `null` here means "address unchanged", not "no address selected". Substituting something
 * plausible would make an edit of the comment rewrite the request address with a source it never
 * had. The server demands verification only for a field that actually changed (R2a).
 */
export function editTripBody(v: TripFormValue, requestDay: string) {
  return {
    ...tripCommonFields(v, requestDay),
    ...(v.id ? { id: v.id } : {}),
    fromAddress: v.fromAddress ?? null,
    toAddress: v.toAddress ?? null,
  };
}
