import { tripCargoLabel, type VehicleRequestDto } from '@technic/contracts';
import { vehicleRequestTermLabel } from '@entities/vehicle-request';

/**
 * What a request loses when converted to the other type (ADR 0091), as lines built from its own
 * data — the same technique as `rollbackErases`: the list is assembled per filled field, not
 * written up front. Promising the loss of something the request does not have would be a lie in
 * exactly the window where the person decides whether to convert.
 *
 * The on-site contact is deliberately absent: it is not lost but moves into the new type's field
 * (`handleRequestTypeChange`), and the person sees it in the form before saving.
 */
export function retypeErases(request: VehicleRequestDto, dropsApproval: boolean): string[] {
  const items: string[] = [];
  if (request.requestType === 'special_equipment') {
    items.push(
      `Срок работ (${vehicleRequestTermLabel(request)}) — у грузоперевозки вместо него момент подачи`,
    );
  } else {
    // Trips (R2 of `docs/route-trips-plan.md`) own addresses, quantities and contacts, and the
    // conversion drops the whole freight detail — all trips at once.
    //
    // A single trip is named with the same two lines as before the plan: a one-trip request is
    // yesterday's request (R24), and the person need not learn a new entity in the confirmation.
    // Several trips are listed one by one: "trips: 6" says nothing about what will disappear.
    const [single] = request.trips;
    if (request.trips.length === 1 && single) {
      items.push(`Место погрузки: ${single.fromLocation}`);
      items.push(`Место разгрузки: ${single.toLocation}`);
      if (single.volumeM3 != null) items.push(`Объём: ${single.volumeM3} м³`);
      if (single.weightTons != null) items.push(`Масса: ${single.weightTons} т`);
    } else {
      for (const trip of request.trips) {
        // The trip number both names the trip and keeps lines distinct: rows produced by "repeat
        // N times" (§4.1) share addresses and cargo to the character, and the list is keyed by line.
        const cargo = tripCargoLabel(trip);
        items.push(
          `Ездка ${trip.num}: ${trip.fromLocation} → ${trip.toLocation}${cargo ? ` · ${cargo}` : ''}`,
        );
      }
    }
    // A department customer (ADR 0040) cannot order on-site equipment, which works at a site: the
    // request moves to the object chosen in the form.
    if (request.departmentName) {
      items.push(
        `Заказчик-отдел (${request.departmentName}) — заказ техники на объект ведёт площадка`,
      );
    }
  }
  if (dropsApproval) {
    items.push(
      `Виза руководителя строительства${request.approvedByName ? ` (${request.approvedByName})` : ''}`,
    );
  }
  return items;
}
