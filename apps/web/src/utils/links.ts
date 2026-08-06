import { isClosedRequestStatus, type Permission, type RequestStatus } from '@technic/contracts';

/**
 * Адреса записей портала: куда ведёт номер, названный в чужом списке.
 *
 * Одним местом, потому что переход состоит из двух половин, и врозь они расходятся: адрес вкладки
 * («какой список показать») и право на неё («показывать ли ссылку вообще»). Ссылка, ведущая туда,
 * куда роль не пускают, кончается пустым экраном или редиректом — это хуже, чем номер обычным
 * текстом, каким он и был.
 *
 * Каждая функция возвращает `null`, если целевая вкладка этой роли не положена: место вызова
 * тогда рисует прежний текст.
 */

type Can = (permission: Permission) => boolean;

/** Ключи вкладок раздела «Заказ автотехники» — те же, что читает `VehicleRequestsPage`. */
export type VehicleTab = 'requests' | 'on-site' | 'routes' | 'history' | 'archive';

/**
 * «Маршруты» — рейсы собственных машин. Спрашиваются оба права, которыми закрыты ручки рейсов:
 * `waybills.read` — потому что в рейсе виден водитель (ADR 0037 п. 13), `vehicleRequests.status` —
 * потому что рейс ведёт тот же, кто двигает заявки.
 */
export const canSeeRoutesTab = (can: Can): boolean =>
  can('waybills.read') && can('vehicleRequests.status');

/** Архив удалённых записей (ADR 0070, ADR 0063) — по матрице прав это администратор. */
export const canSeeArchiveTab = (can: Can): boolean => can('archive.read');

/**
 * Вкладка, на которой заявку на технику показывают сейчас: пока её ведут — в списке, закрытую —
 * в журнале (ADR 0029), удалённую — в архиве (ADR 0070). Без этого выбора ссылка приводила бы на
 * список, в котором закрытой заявки нет, и карточка открывалась бы поверх чужих строк.
 */
export function vehicleRequestTab(status: RequestStatus, deleted = false): VehicleTab {
  if (deleted) return 'archive';
  return isClosedRequestStatus(status) ? 'history' : 'requests';
}

/** Заявка на технику: вкладка по её состоянию плюс просьба открыть карточку. */
export function vehicleRequestLink(
  can: Can,
  request: { id: string; status: RequestStatus; deleted?: boolean },
): string | null {
  if (!can('vehicleRequests.read')) return null;
  const tab = vehicleRequestTab(request.status, request.deleted);
  if (tab === 'archive' && !canSeeArchiveTab(can)) return null;
  return `/vehicle-requests?tab=${tab}&open=${request.id}`;
}

/** Рейс: вкладка «Маршруты» с открытой карточкой рейса. */
export function vehicleRouteLink(can: Can, routeId: string): string | null {
  if (!canSeeRoutesTab(can)) return null;
  return `/vehicle-requests?tab=routes&open=${routeId}`;
}

/** Заявка на вывоз мусора: список заявок либо архив, если её удалили. */
export function wasteRequestLink(
  can: Can,
  request: { id: string; deleted?: boolean },
): string | null {
  if (!can('wasteRequests.read')) return null;
  if (request.deleted && !canSeeArchiveTab(can)) return null;
  return `/waste?tab=${request.deleted ? 'archive' : 'requests'}&open=${request.id}`;
}

/**
 * Путевой лист: журнал учёта с поиском по номеру. Карточки у листа нет — журнал и есть карточка:
 * строка отвечает, на какую машину лист выписан, что с ним стало и чем подшит (ADR 0037).
 */
export function waybillLink(can: Can, number: string): string | null {
  if (!can('waybills.read')) return null;
  return `/waybills?number=${encodeURIComponent(number)}`;
}
