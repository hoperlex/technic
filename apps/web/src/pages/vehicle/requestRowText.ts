import {
  assignmentRateLabel,
  assignmentTitle,
  completionLabel,
  routePurposeLabels,
  tripCargoLabel,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { vehicleRequestTermLabel } from '@entities/vehicle-request';

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

/**
 * Что заявка теряет при переоформлении в другой тип (ADR 0091) — строками, по её собственным
 * данным. Тем же приёмом, что и `rollbackErases`: перечень собирается под заполненное поле, а не
 * пишется заранее — обещать пропажу того, чего у заявки нет, значит врать ровно в том окне, где
 * человек решает, переоформлять ли.
 *
 * Контакта на месте в перечне нет намеренно: он не теряется, а переезжает в поле нового типа
 * (`handleRequestTypeChange`), и человек видит его в форме перед сохранением.
 */
export function retypeErases(r: VehicleRequestDto, dropsApproval: boolean): string[] {
  const items: string[] = [];
  if (r.requestType === 'special_equipment') {
    items.push(
      `Срок работ (${vehicleRequestTermLabel(r)}) — у грузоперевозки вместо него момент подачи`,
    );
  } else {
    // Ездки (Р2 плана `docs/route-trips-plan.md`): адреса, количество и контакты лежат у них, а
    // переоформление сносит деталь грузоперевозки целиком — значит и все ездки разом.
    //
    // Одна ездка называется теми же двумя строками, что и до плана: заявка с одной ездкой и есть
    // вчерашняя заявка (Р24), и человеку в окне подтверждения незачем узнавать про новую сущность
    // ради того, что он и так видел в карточке. Несколько перечисляются построчно: решают здесь,
    // что именно перестанет существовать, а «ездок: 6» об этом не говорит ничего.
    const [single] = r.trips;
    if (r.trips.length === 1 && single) {
      items.push(`Место погрузки: ${single.fromLocation}`);
      items.push(`Место разгрузки: ${single.toLocation}`);
      if (single.volumeM3 != null) items.push(`Объём: ${single.volumeM3} м³`);
      if (single.weightTons != null) items.push(`Масса: ${single.weightTons} т`);
    } else {
      for (const trip of r.trips) {
        // Номер ездки в начале строки не только называет её, но и различает строки перечня: у
        // размноженных «повторить N раз» (§4.1) адреса и груз совпадают до знака, а перечень
        // выводится списком с ключом по самой строке.
        const cargo = tripCargoLabel(trip);
        items.push(
          `Ездка ${trip.num}: ${trip.fromLocation} → ${trip.toLocation}${cargo ? ` · ${cargo}` : ''}`,
        );
      }
    }
    // Заказчик-отдел (ADR 0040): спецтехника выходит на площадку, и заказать её отдел не может —
    // заявка переезжает на объект, выбранный в форме.
    if (r.departmentName) {
      items.push(`Заказчик-отдел (${r.departmentName}) — заказ техники на объект ведёт площадка`);
    }
  }
  if (dropsApproval) {
    items.push(
      `Виза руководителя строительства${r.approvedByName ? ` (${r.approvedByName})` : ''}`,
    );
  }
  return items;
}
