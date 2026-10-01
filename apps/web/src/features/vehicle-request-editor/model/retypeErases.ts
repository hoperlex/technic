import { tripCargoLabel, type VehicleRequestDto } from '@technic/contracts';
import { vehicleRequestTermLabel } from '@entities/vehicle-request';

/** Lists only facts that actually disappear when a request is converted to the other kind. */
export function retypeErases(request: VehicleRequestDto, dropsApproval: boolean): string[] {
  const items: string[] = [];
  if (request.requestType === 'special_equipment') {
    items.push(
      `Срок работ (${vehicleRequestTermLabel(request)}) — у грузоперевозки вместо него момент подачи`,
    );
  } else {
    const [single] = request.trips;
    if (request.trips.length === 1 && single) {
      items.push(`Место погрузки: ${single.fromLocation}`);
      items.push(`Место разгрузки: ${single.toLocation}`);
      if (single.volumeM3 != null) items.push(`Объём: ${single.volumeM3} м³`);
      if (single.weightTons != null) items.push(`Масса: ${single.weightTons} т`);
    } else {
      for (const trip of request.trips) {
        const cargo = tripCargoLabel(trip);
        items.push(
          `Ездка ${trip.num}: ${trip.fromLocation} → ${trip.toLocation}${cargo ? ` · ${cargo}` : ''}`,
        );
      }
    }
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
