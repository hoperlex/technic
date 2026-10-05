import {
  assignmentRateLabel,
  assignmentTitle,
  completionLabel,
  routePurposeLabels,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';

/**
 * What a return to "new" erases from this request (`transitionResetsWork`), as lines built from its
 * own data.
 *
 * The list is not static on purpose: a rented vehicle has no route and no relocations — the lessor
 * runs them — and a fact exists only on a request that was closed and rolled back into work.
 * Promising to remove what the request does not have would lie to the person exactly in the dialog
 * where they decide whether to erase the work; so a line appears only for a filled field.
 *
 * The approval is absent entirely (ADR 0172): the rollback keeps it, and a line about it would not
 * be caution but an untruth — the person would refuse the rollback to protect what is not at risk.
 */
export function rollbackErases(
  request: VehicleRequestDto,
  relocations: VehicleRouteDto[],
): string[] {
  const items: string[] = [];
  if (request.assignment) {
    // Rates in the same text as the list row: they were agreed for this request (ADR 0027), and
    // what is erased with the vehicle is the agreement, not a directory row. A rented vehicle
    // without rates names the lessor: the agreement was with them, and they are the one to call.
    const detail = assignmentRateLabel(request.assignment) || request.assignment.lessorName;
    items.push(
      `Назначенная техника: ${assignmentTitle(request.assignment)}${detail ? ` — ${detail}` : ''}`,
    );
  }
  if (request.route) items.push(`Место в рейсе ${request.route.displayNumber}`);
  for (const route of relocations) {
    items.push(
      `${routePurposeLabels[route.purpose]} — рейс ${route.displayNumber} от ${formatDateOnly(route.routeDate)}`,
    );
  }
  if (request.completion) {
    items.push(`Предъявленный факт: ${completionLabel(request.completion)}`);
  }
  return items;
}
