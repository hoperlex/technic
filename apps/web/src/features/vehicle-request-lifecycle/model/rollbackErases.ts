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
 * Describe only the work data a rollback to `new` actually removes. Approval is deliberately
 * absent because ADR 0172 keeps it, while optional assignment, route, relocation and completion
 * lines are included only when the request owns them.
 */
export function rollbackErases(
  request: VehicleRequestDto,
  relocations: VehicleRouteDto[],
): string[] {
  const items: string[] = [];
  if (request.assignment) {
    // Rates describe the commercial agreement being removed; a rental without rates names the
    // lessor instead so the confirmation still identifies the affected agreement.
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
