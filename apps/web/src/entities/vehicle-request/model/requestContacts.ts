import type { VehicleRequestDto, VehicleRequestTripDto } from '@technic/contracts';

export interface RequestContact {
  role: string;
  name: string;
  phone: string;
  /** The location this person is responsible for; null is valid for old/on-site requests. */
  address: string | null;
}

/** Russian count label shared by the request card, route hint and trip editor. */
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
 * Freight contacts belong to trips, not the request: A→B and A→C have different receivers. The
 * list previews the first trip and names its position when more exist; the full card owns the rest.
 */
function tripContacts(trips: readonly VehicleRequestTripDto[]): RequestContact[] {
  const trip = trips[0];
  // Legacy/corrupt empty trips must render an empty cell instead of taking the whole feed down.
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
 * Special equipment has one on-site contact; freight has one contact per end of the first trip.
 * Empty legacy contacts are removed because a role followed by dashes conveys no useful answer.
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
  return contacts.filter((contact) => contact.name || contact.phone || contact.address);
}
