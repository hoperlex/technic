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
 * The request type controls both the visible fields and the compatible vehicle kinds
 * (`isVehicleKindAllowedForRequest`).
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
   * Trip endpoints own their addresses, quantities, and contacts. A request with `A -> B` and
   * `A -> C` has no single request-level destination.
   *
   * The array lives directly in form values instead of `Form.List`: address and contact controls
   * call the form by their full paths, while `Form.List` prefixes only its own `Form.Item`s.
   */
  trips?: TripFormValue[];
  comment?: string;
  /**
   * Backdate reason (ADR 0101). It belongs to the form so `resetFields` cannot leak a reason into
   * the next request opened in the same dialog.
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
 * Expand trips when the compact editor would hide meaningful data: multiple trips or a single
 * trip with its own delivery time or note. The request card uses the same predicate.
 */
export function tripsNeedExpanding(r: VehicleRequestDto): boolean {
  const trips = r.requestType === 'freight_transport' ? r.trips : [];
  return trips.length > 1 || trips.some(tripNeedsList);
}

/** Freight delivery moment in Moscow time, shared by edit, copy, and copy-notice flows. */
export function scheduledMoment(
  r: VehicleRequestDto & { requestType: 'freight_transport' },
): Dayjs {
  // Convert the absolute server timestamp to Moscow time. Parsing it as Moscow wall time would
  // discard the supplied offset and persist a three-hour shift on the next edit.
  return dayjs(r.scheduledAt).tz(MOSCOW_TZ);
}

/** Edit values preserve the request exactly, including dates in the past. */
export function editFormValues(r: VehicleRequestDto): FormFill {
  if (r.requestType === 'special_equipment') {
    return {
      requestType: r.requestType,
      // The request columns are authoritative; the editor's access axis may be different.
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
   * Legacy backfilled trips may have unverified addresses or empty contacts. Preserve those
   * values and their metadata instead of inventing historical data (ADR 0006).
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
 * Copy source plus the calendar snapshot taken when the dialog opens. Values and explanatory
 * text must share this snapshot so crossing a cutoff or midnight cannot make them disagree.
 */
export interface CopySource {
  source: VehicleRequestDto;
  /** Earliest day accepted by the create form (`vehicleRequestDateRules`). */
  minDate: Dayjs;
  /** Current Moscow calendar day in `YYYY-MM-DD` form. */
  today: string;
}

/**
 * Term proposed for an equipment-request copy (ADR 0206). The form values and copy notice share
 * this result so the explanation cannot drift from the dates being submitted.
 *
 * `ahead` preserves a future term, `remainder` keeps the unelapsed tail of an active term, and
 * `shifted` moves an elapsed term forward while preserving its duration.
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
   * Whether a term has started is measured against today, not `minDate`. The latter includes the
   * role-specific lead time (ADR 0104) and could otherwise truncate a future request.
   *
   * Compare `YYYY-MM-DD` keys because these are date-only values; browser-zone instants would add
   * a time component that the term does not have.
   */
  const floorKey = floor.format('YYYY-MM-DD');
  // A request starting today is already active; after the cutoff its copy should keep the
  // remaining end date instead of shifting the entire term past the original end.
  const started = r.dateFrom <= today;
  // A missing end date is a one-day term, matching the server's `coalesce` interpretation.
  const end = r.dateTo || r.dateFrom;
  // `floorKey > dateFrom` ensures an unchanged term is described as `ahead`, not a remainder.
  if (started && end >= floorKey && floorKey > r.dateFrom) {
    // An active request keeps its original end: extending it would order more work than requested.
    return { kind: 'remainder', dateFrom: floor, dateTo: to };
  }
  // Calendar-day arithmetic preserves duration across daylight-saving transitions; raw
  // milliseconds could turn a three-day term into two days in another browser time zone.
  const shift = Math.max(0, floor.diff(from.startOf('day'), 'day'));
  return {
    kind: shift === 0 ? 'ahead' : 'shifted',
    dateFrom: from.add(shift, 'day'),
    dateTo: to ? to.add(shift, 'day') : null,
  };
}

/**
 * Delivery date and time proposed for a freight copy (ADR 0206). A point-in-time request has no
 * remainder branch, but still shares one calculation with its explanatory notice.
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
    // Delivery time is part of the repeated order and remains valid when only its day moves.
    scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
  };
}

/**
 * Form values for a new request copied from an existing one (ADR 0173).
 *
 * A copy is a new request, not an edit, so it intentionally differs in three ways:
 *
 * 1. The calendar is proposed again by `copyTermPlan` or `copyScheduledPlan`; a copy never
 *    silently inherits an unexplained past date.
 * 2. Classifier and customer are preserved only when available to the copying user; otherwise
 *    the form asks for an accepted value instead of submitting one the server will reject.
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
