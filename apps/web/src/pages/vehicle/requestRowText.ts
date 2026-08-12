import {
  assignmentRateLabel,
  assignmentTitle,
  completionLabel,
  routePurposeLabels,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { formatDateTimeMaybe } from '../../utils/format';
import { formatDateOnly } from '../../utils/date';

/**
 * Текст о заявке, собранный по её собственным данным: срок строкой и два перечня того, что заявка
 * потеряет — при возврате в «Новую» и при переоформлении в другой тип (ADR 0091).
 *
 * Отдельным файлом от самой вкладки: `VehicleRequestsTab` давно упёрся в бюджет длины
 * (`scripts/quality.mjs`), а эти три функции — чистые, о заявке, а не о её показе, и уезжают из
 * него, не разрывая ни одной ветки экрана. Срок едет с перечнями: переоформление называет его
 * первой же строкой, и разъедься они по файлам, одна и та же дата печаталась бы двумя способами.
 */

/** Колонка «Срок»: у спецтехники это период, у грузоперевозки — дата (и время, если задано). */
export function termLabel(r: VehicleRequestDto): string {
  if (r.requestType === 'special_equipment') {
    return r.dateTo
      ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
      : formatDateOnly(r.dateFrom);
  }
  return formatDateTimeMaybe(r.scheduledAt, r.scheduledTimeUnspecified);
}

/**
 * Что возврат в «Новую» сотрёт у этой заявки (`transitionResetsWork`) — строками, по её
 * собственным данным.
 *
 * Перечень не статический намеренно: у арендной машины рейса и перегонов не бывает — их ведёт
 * арендодатель, — у заявки отдела нет визы, а факт есть только у той, которую уже закрывали и
 * откатили назад в работу. Обещать снятие того, чего у заявки нет, — врать человеку ровно в том
 * окне, где он решает, стирать ли работу; поэтому строка появляется только под заполненное поле.
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
  // Виза (ADR 0025): её ставят только «Новой» заявке, и вернувшуюся придётся согласовывать заново.
  if (r.approvedAt) {
    items.push(
      `Виза руководителя строительства${r.approvedByName ? ` (${r.approvedByName})` : ''}`,
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
    items.push(`Срок работ (${termLabel(r)}) — у грузоперевозки вместо него момент подачи`);
  } else {
    items.push(`Место погрузки: ${r.loadingLocation}`);
    items.push(`Место разгрузки: ${r.unloadingLocation}`);
    if (r.volumeM3 != null) items.push(`Объём: ${r.volumeM3} м³`);
    if (r.weightTons != null) items.push(`Масса: ${r.weightTons} т`);
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
