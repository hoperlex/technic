import type { VehicleRequestDto } from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { formatDateTimeMaybe } from '@entities/request';

/**
 * The request term has two domain shapes: a work period for special equipment and a dispatch
 * moment for freight. Keeping the label with the entity prevents list, card and confirmation
 * views from inventing different representations of the same dates.
 */
export function vehicleRequestTermLabel(request: VehicleRequestDto): string {
  if (request.requestType === 'special_equipment') {
    return request.dateTo
      ? `${formatDateOnly(request.dateFrom)} – ${formatDateOnly(request.dateTo)}`
      : formatDateOnly(request.dateFrom);
  }
  return formatDateTimeMaybe(request.scheduledAt, request.scheduledTimeUnspecified);
}
