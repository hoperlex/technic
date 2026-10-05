import type { VehicleRequestDto, VehicleRequestTripDto } from '@technic/contracts';

/**
 * Request contacts and the trip count: everything a list row uses to answer "whom to go to and how
 * many times". Contacts follow different rules per request type (freight takes them from trips,
 * special equipment from the object or department), so the rule lives with the entity.
 */

/** A request contact: whose role it is, who holds it, where to go and which number to call. */
export interface RequestContact {
  role: string;
  name: string;
  phone: string;
  /** The location this person is responsible for; null is valid for old/on-site requests. */
  address: string | null;
}

/**
 * "6 ездок": the trip count with Russian declension. A function rather than an inline string: the
 * count stands in the request card next to the cargo total ("60 м³ · 6 ездок",
 * docs/route-trips-plan.md §9) and in the route composition hint, where it explains the consumed
 * form capacity (Р11). If the two drifted, "6 ездки" in one place and "6 ездок" in another would
 * read as two quantities. Declension matches calendarDaysLabel: 1 ездка, 2–4 ездки, 5–20 ездок,
 * 11–14 always ездок.
 */
export function tripsCountLabel(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'ездок'
      : last === 1
        ? 'ездка'
        : last >= 2 && last <= 4
          ? 'ездки'
          : 'ездок';
  return `${count} ${form}`;
}

/**
 * Freight contacts belong to trips (docs/route-trips-plan.md, Р2), not the request: with trips A→B
 * and A→C "the request's unloading responsible" does not exist. The list previews the first trip,
 * the same choice by which the row shows its addresses (§9); the card owns the rest. The trip count
 * is put into the role itself: without it the list would silently pass one trip's contact off as
 * the whole request's, and the call would go to the wrong person.
 */
function tripContacts(trips: readonly VehicleRequestTripDto[]): RequestContact[] {
  const trip = trips[0];
  // A freight request never has zero trips (FreightTransportRequestDto.trips), but a list row is
  // not the place to assert that with an exception: an empty list renders a dash instead of taking
  // the whole table down.
  if (!trip) return [];
  const suffix = trips.length > 1 ? ` · ездка 1 из ${trips.length}` : '';
  return [
    {
      role: `Отв. за погрузку${suffix}`,
      name: trip.fromResponsibleName,
      phone: trip.fromResponsiblePhone,
      address: trip.fromLocation,
    },
    {
      role: `Отв. за разгрузку${suffix}`,
      name: trip.toResponsibleName,
      phone: trip.toResponsiblePhone,
      address: trip.toLocation,
    },
  ];
}

/**
 * Contacts per work place. Special equipment has one, whoever meets the equipment on site, with
 * the object address; freight has two, one per route end, each with its own address, because
 * loading and receiving are done by different people in different places.
 *
 * The role is inseparable from the name on purpose: "Иванов" without a role means nothing in the
 * list, and the caller would not know which route end to ask about.
 */
export function requestContacts(request: VehicleRequestDto): RequestContact[] {
  const contacts: RequestContact[] =
    request.requestType === 'special_equipment'
      ? [
          {
            role: 'Отв. на объекте',
            name: request.responsibleName,
            phone: request.responsiblePhone,
            address: request.objectAddress,
          },
        ]
      : tripContacts(request.trips);
  // An empty contact takes no line: requests created before migration 0062 have none, and
  // "Отв. за погрузку —" would say nothing while stealing a visible line from the next contact.
  return contacts.filter((contact) => contact.name || contact.phone || contact.address);
}
