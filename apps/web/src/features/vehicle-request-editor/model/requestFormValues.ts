import dayjs, { type Dayjs } from 'dayjs';
import {
  costTargetKeyOf,
  type FreightTransportRequestDto,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
  type VehicleRequestType,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { classificationKeyOf } from '@entities/vehicle-type';
import { copyTrip, tripNeedsList, tripToForm, type TripFormValue } from './requestTripsForm';

/**
 * Vehicle request form values and the pure projections used for editing and copying.
 * Keeping the shape next to both projections makes a newly added field fail compilation until
 * both flows explicitly decide whether to preserve it.
 */

/**
 * One form for both kinds of vehicle request. The request type is chosen explicitly because it
 * controls both the visible fields and the compatible vehicle kinds: an on-site order accepts any
 * kind, freight only cargo vehicles (`isVehicleKindAllowedForRequest`). Until the type is chosen,
 * neither block of kind-specific fields (nor their labels) is shown.
 */
export interface FormValues {
  requestType: VehicleRequestType;
  /**
   * The customer is selected by an opaque `object:<id>` or `department:<id>` key (ADR 0040).
   * `customerPairOf` derives the request columns from the selected option without parsing it.
   */
  customerKey?: string;
  /** Classifier position key `type:category` (ADR 0028); the API receives the two fields. */
  classificationKey: string;
  // On-site equipment uses a date-only term and one receiving contact.
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  responsibleName?: string;
  responsiblePhone?: string;
  // Freight uses a date, an optional first-delivery time, and an explicit trip list.
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  /**
   * Request trips (R1, R2 of `docs/route-trips-plan.md`). Trip endpoints own their addresses,
   * quantities, and contacts. A request with `A -> B` and `A -> C` has no single request-level
   * destination.
   *
   * The array lives directly in form values instead of `Form.List`: address and contact controls
   * call the form by their full paths (`trips.3.fromLocation`), while `Form.List` prefixes only its
   * own `Form.Item`s. `RequestTripsBlock` maintains the list.
   */
  trips?: TripFormValue[];
  comment?: string;
  /**
   * Backdate reason (ADR 0101). A form field rather than screen state: it is shown depending on
   * the chosen date, and `resetFields` must clear it together with that date — otherwise the
   * explanation for yesterday's request would leak into the next request opened in the same dialog.
   */
  backdateReason?: string;
}

/**
 * A complete fill of the form: every field of `FormValues` is named, even when the answer is
 * "nothing". `Partial<FormValues>` let a branch forget a new field silently, and a forgotten field
 * is not an empty one only by luck of `resetFields`. Here a new field fails the build in each of the
 * four branches below until it says what an edit and a copy carry over, if anything.
 *
 * Mapped over `Required<FormValues>` rather than with `-?`: that modifier also strips the explicit
 * `| undefined`, and "this field is deliberately empty" could not be written at all.
 */
export type FormFill = { [K in keyof Required<FormValues>]: FormValues[K] | undefined };

/**
 * Whether to open the trip list expanded (§4.1). The compact view hides a trip's own delivery time
 * and note entirely, so requests with several trips, or with one trip that carries such data, open
 * as a list — otherwise the person would edit the request without seeing half of the order. The
 * request card decides with the same predicate (`tripNeedsList`) whether to show a trip as a pair
 * of fields.
 */
export function tripsNeedExpanding(r: VehicleRequestDto): boolean {
  const trips = r.requestType === 'freight_transport' ? r.trips : [];
  return trips.length > 1 || trips.some(tripNeedsList);
}

/** Freight delivery moment in Moscow time, shared by edit, copy, and copy-notice flows. */
export function scheduledMoment(
  r: VehicleRequestDto & { requestType: 'freight_transport' },
): Dayjs {
  // Convert the absolute server timestamp to Moscow time. `dayjs.tz(iso, tz)` would parse it as
  // Moscow wall time, discard the supplied offset, show the delivery three hours early and persist
  // that shift on the next edit. The waste-removal request reads its delivery the same way.
  return dayjs(r.scheduledAt).tz(MOSCOW_TZ);
}

/** Edit values preserve the request exactly, including dates in the past. */
export function editFormValues(r: VehicleRequestDto): FormFill {
  if (r.requestType === 'special_equipment') {
    return {
      requestType: r.requestType,
      // The customer key comes from the request itself (R2): exactly one half of the CHECK-bound
      // column pair is filled, and the kind is read from it, not from the editor's access axis.
      customerKey: costTargetKeyOf(r) ?? undefined,
      classificationKey: classificationKeyOf(r),
      dateFrom: dayjs(r.dateFrom),
      dateTo: r.dateTo ? dayjs(r.dateTo) : null,
      responsibleName: r.responsibleName,
      responsiblePhone: r.responsiblePhone,
      // An on-site order has a term, not a delivery moment, and no trips of its own.
      scheduledDate: undefined,
      scheduledTime: undefined,
      trips: undefined,
      comment: r.comment,
      // The reason explains one backdated save and is asked anew by the dates of this one.
      backdateReason: undefined,
    };
  }
  const at = scheduledMoment(r);
  /*
   * Freight addresses, cargo, and contacts belong to trips, so an edit submits the full list.
   *
   * Each trip is carried over as is, including an unverified address and an empty contact: rows
   * backfilled from requests older than ADR 0006 and migration 0062 have them, and the form does
   * not invent the past (R2a). Address metadata travels with the row so the address field reopens
   * in the mode the address was entered with.
   *
   * A zero-trip request should be impossible, but the editor remains tolerant of malformed
   * historical data instead of turning it into a rendering failure.
   */
  return {
    requestType: r.requestType,
    customerKey: costTargetKeyOf(r) ?? undefined,
    classificationKey: classificationKeyOf(r),
    // Freight has a delivery moment instead of a term, and its contacts live on each trip.
    dateFrom: undefined,
    dateTo: undefined,
    responsibleName: undefined,
    responsiblePhone: undefined,
    scheduledDate: at,
    // An unspecified time stays empty; midnight in `scheduledAt` is only its storage encoding.
    scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
    trips: r.trips.map(tripToForm),
    comment: r.comment,
    // Same as above: a backdate reason belongs to one save, never to the order.
    backdateReason: undefined,
  };
}

/**
 * Copy source plus the calendar snapshot taken when the dialog opens. The fields are filled once
 * on open while the notice re-renders every time; if the notice asked the calendar again, a form
 * left open across 15:00 or midnight would explain a term other than the one in its own fields.
 */
export interface CopySource {
  source: VehicleRequestDto;
  /** Earliest day accepted by the create form (`vehicleRequestDateRules`). */
  minDate: Dayjs;
  /** Current Moscow calendar day in `YYYY-MM-DD` form. */
  today: string;
}

/**
 * Term proposed for an equipment-request copy (ADR 0206). The form values and copy notice
 * (`copyNotice`) share this result so the explanation cannot drift from the dates being submitted;
 * people trust the notice and do not re-read the fields after it.
 *
 * - `ahead` — the whole term is in the future and is proposed as is;
 * - `remainder` — the order is running and not over yet: its tail is proposed, the start moves to
 *   the first available day and the end stays;
 * - `shifted` — the term has fully elapsed and moves forward **preserving its duration**: "a crane
 *   for five days" stays an order for five days.
 */
export type CopyTermKind = 'ahead' | 'remainder' | 'shifted';

export interface CopyTermPlan {
  kind: CopyTermKind;
  dateFrom: Dayjs;
  dateTo: Dayjs | null;
}

export function copyTermPlan(
  r: SpecialEquipmentRequestDto,
  minDate: Dayjs,
  today: string,
): CopyTermPlan {
  const from = dayjs(r.dateFrom);
  const to = r.dateTo ? dayjs(r.dateTo) : null;
  const floor = minDate.startOf('day');
  /*
   * The Moscow day is supplied from the dialog snapshot so form values and the notice cannot
   * select different branches after midnight.
   *
   * Whether a term has started is measured against today, never `minDate`. The latter is the
   * role's lead time (ADR 0104): after 15:00 it gives a requester the day after tomorrow. Branching
   * on it would silently turn a copy of a not-yet-started order (start tomorrow, end in a week)
   * into a remainder from the day after tomorrow, losing a day or two of work instead of honestly
   * shifting the whole term.
   *
   * Compare `YYYY-MM-DD` keys because these are date-only values; browser-zone instants would add
   * a time component that the term does not have.
   */
  const floorKey = floor.format('YYYY-MM-DD');
  // An order starting today is already running: the equipment is on site since the morning. A
  // strict "started before today" got this wrong for requesters: an order for 22.09–30.09 copied
  // after 15:00 was shifted to 24.09–02.10, two days past the original end — exactly what the
  // remainder branch exists to prevent.
  const started = r.dateFrom <= today;
  // A missing end date is a one-day term (the server reads it with the same `coalesce`); such an
  // order never reaches the remainder branch: once started, it ended the same day.
  const end = r.dateTo || r.dateFrom;
  // `floorKey > dateFrom` means "there is something to move": an order started today whose first
  // available day is also today forms no remainder and is proposed whole (`ahead`); otherwise the
  // notice would announce an untouched term as a remainder.
  if (started && end >= floorKey && floorKey > r.dateFrom) {
    // A running order keeps its original end: preserving the duration would push the end past the
    // original one and order more than requested — the copy only finishes the same days with
    // another vehicle.
    return { kind: 'remainder', dateFrom: floor, dateTo: to };
  }
  // Calendar-day arithmetic: `diff(…, 'day')` subtracts the offset difference and `add(n, 'day')`
  // moves the day number. Raw milliseconds in a zone with DST would give 2.96 days instead of three,
  // and a copy of a three-day order would become a two-day one for that browser.
  const shift = Math.max(0, floor.diff(from.startOf('day'), 'day'));
  return {
    kind: shift === 0 ? 'ahead' : 'shifted',
    dateFrom: from.add(shift, 'day'),
    dateTo: to ? to.add(shift, 'day') : null,
  };
}

/**
 * Delivery date and time proposed for a freight copy (ADR 0206). Two branches, not three: freight
 * has a delivery moment, not a term, so there is no remainder. The rule is the old one (ADR 0173)
 * and lives here for the same reason as the term: the notice names the proposed day, and computing
 * it twice would eventually disagree.
 */
export interface CopyScheduledPlan {
  kind: 'ahead' | 'shifted';
  scheduledDate: Dayjs;
  /** Delivery time `HH:mm`; `undefined` means the stored Moscow midnight is only a sentinel. */
  scheduledTime?: string;
}

export function copyScheduledPlan(
  r: FreightTransportRequestDto,
  minDate: Dayjs,
): CopyScheduledPlan {
  const at = scheduledMoment(r);
  const floor = minDate.startOf('day');
  const moved = at.isBefore(floor);
  return {
    kind: moved ? 'shifted' : 'ahead',
    scheduledDate: moved ? floor : at,
    // The copy keeps the delivery hour: "sand by eight a.m." is part of the repeated order, and the
    // source already passed the work-window check. Moving the day does not touch the time; trip
    // hours move together with it (`copyTrip`).
    scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
  };
}

/**
 * Form values for a new request copied from an existing one (ADR 0173).
 *
 * A copy is a new request, not an edit, so it intentionally differs in three ways:
 *
 * 1. The calendar is proposed again by `copyTermPlan` or `copyScheduledPlan`. Creation does not
 *    accept an unexplained past, and a copy has nothing to explain: the order is repeated, not
 *    yesterday corrected. Copies are taken from a request in any status (ADR 0206), so "move to the
 *    first available day" is no longer the only answer — for a running order it would push the end
 *    past the original one too.
 * 2. Classifier and customer are preserved only when available to the copying user. A position
 *    switched off in the directory is rejected by the server (`resolveClassification`), and a
 *    customer outside the user's picker is sent as an empty pair (K8); in both cases the field is
 *    left empty and asks, instead of showing a value that will be rejected on save.
 * 3. Trips lose their IDs (`copyTrip`) because the server must create new rows.
 *
 * Attachments are not copied: `assertFilesAttachable` permits each stored object to belong to at
 * most one request, so copying would require creating new storage objects.
 */
export function copyFormValues(
  r: VehicleRequestDto,
  options: {
    /** Earliest day accepted by the create form (`vehicleRequestDateRules`). */
    minDate: Dayjs;
    /** Moscow calendar day used to choose the copy-calendar branch. */
    today: string;
    /** Whether the source classifier position is still active. */
    hasClassification: boolean;
    /** Whether the source customer is available to the copying user. */
    hasCustomer: boolean;
  },
): FormFill {
  const { minDate, today, hasClassification, hasCustomer } = options;
  const common = {
    requestType: r.requestType,
    customerKey: hasCustomer ? (costTargetKeyOf(r) ?? undefined) : undefined,
    classificationKey: hasClassification ? classificationKeyOf(r) : '',
    comment: r.comment,
    // A copy is proposed inside the allowed window (`copyTermPlan`, `copyScheduledPlan`), so there
    // is no past to explain; moved back by hand, it is asked for a reason of the person copying.
    backdateReason: undefined,
  };
  if (r.requestType === 'special_equipment') {
    const term = copyTermPlan(r, minDate, today);
    return {
      ...common,
      dateFrom: term.dateFrom,
      dateTo: term.dateTo,
      responsibleName: r.responsibleName,
      responsiblePhone: r.responsiblePhone,
      // An on-site order has a term, not a delivery moment, and no trips of its own.
      scheduledDate: undefined,
      scheduledTime: undefined,
      trips: undefined,
    };
  }
  const plan = copyScheduledPlan(r, minDate);
  return {
    ...common,
    // Freight has a delivery moment instead of a term, and its contacts live on each trip.
    dateFrom: undefined,
    dateTo: undefined,
    responsibleName: undefined,
    responsiblePhone: undefined,
    scheduledDate: plan.scheduledDate,
    scheduledTime: plan.scheduledTime,
    trips: r.trips.map(copyTrip),
  };
}
