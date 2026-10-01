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
 * Destructive confirmation text built from the request itself. Date representation comes from the
 * vehicle-request entity so confirmations and feed views cannot drift apart.
 */

/**
 * Что возврат в «Новую» сотрёт у этой заявки (`transitionResetsWork`) — строками, по её
 * собственным данным.
 *
 * Перечень не статический намеренно: у арендной машины рейса и перегонов не бывает — их ведёт
 * арендодатель, — а факт есть только у той заявки, которую уже закрывали и откатили назад в
 * работу. Обещать снятие того, чего у заявки нет, — врать человеку ровно в том окне, где он
 * решает, стирать ли работу; поэтому строка появляется только под заполненное поле.
 *
 * Визы в перечне нет вовсе (ADR 0172): возврат её не снимает, и строка о ней была бы не
 * осторожностью, а неправдой — человек отказался бы от отката, чтобы сберечь то, чему ничего не
 * грозит.
 */
export function rollbackErases(r: VehicleRequestDto, relocations: VehicleRouteDto[]): string[] {
  const items: string[] = [];
  if (r.assignment) {
    // Ставки — тем же текстом, что и в строке списка: их согласовывали под эту заявку (ADR 0027),
    // и стирается вместе с машиной именно договорённость, а не строка справочника. Без ставок у
    // арендной машины называется арендодатель: с ним и договаривались, ему и звонить об отказе.
    const detail = assignmentRateLabel(r.assignment) || r.assignment.lessorName;
    items.push(
      `Назначенная техника: ${assignmentTitle(r.assignment)}${detail ? ` — ${detail}` : ''}`,
    );
  }
  if (r.route) items.push(`Место в рейсе ${r.route.displayNumber}`);
  for (const route of relocations) {
    items.push(
      `${routePurposeLabels[route.purpose]} — рейс ${route.displayNumber} от ${formatDateOnly(route.routeDate)}`,
    );
  }
  if (r.completion) items.push(`Предъявленный факт: ${completionLabel(r.completion)}`);
  return items;
}
