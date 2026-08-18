import {
  vehicleRequestPath,
  vehicleRequestTab,
  vehicleRequestViewPath,
  vehicleRoutePath,
  waybillPath,
  type Permission,
  type RequestStatus,
} from '@technic/contracts';

/**
 * Право на переход по номеру записи, названному в чужом списке.
 *
 * Переход состоит из двух половин, и врозь они расходятся: адрес («какой список показать» или
 * «какое окно открыть») и право на него («показывать ли ссылку вообще»). Здесь осталась вторая:
 * сами адреса переехали в контракты (`packages/contracts/src/links.ts`), потому что спрашивают их
 * двое — портал и почта, печатающая номер заявки в сводке. Разойдись эти два места, ссылка из
 * письма привела бы на список, в котором записи нет.
 *
 * Прав контракты не знают намеренно: у портала это `can`, у письма — область видимости
 * получателя. Каждая функция здесь возвращает `null`, если цель этой роли не положена: место
 * вызова тогда рисует прежний текст. Ссылка, ведущая туда, куда роль не пускают, кончается пустым
 * экраном, редиректом или сообщением «не найдена» — это хуже, чем номер обычным текстом, каким он
 * и был.
 */

type Can = (permission: Permission) => boolean;

/**
 * Рейс собственной машины — карточкой и списком (ADR 0120, окна поверх экрана). Спрашиваются оба
 * права, которыми закрыты ручки рейсов: `waybills.read` — потому что в рейсе виден водитель
 * (ADR 0037 п. 13), `vehicleRequests.status` — потому что рейс ведёт тот же, кто двигает заявки.
 *
 * Условие то же, что было у вкладки «Маршруты», — изменилось только место, куда ведёт номер. Его
 * же спрашивает держатель адреса окон (`pages/vehicle/routeModal`): и ссылка, и параметр адреса
 * закрыты одним правилом, иначе прямой ссылкой открывалось бы то, чего в интерфейсе не показывают.
 */
export const canOpenRoute = (can: Can): boolean =>
  can('waybills.read') && can('vehicleRequests.status');

/** Архив удалённых записей (ADR 0070, ADR 0063) — по матрице прав это администратор. */
export const canSeeArchiveTab = (can: Can): boolean => can('archive.read');

/** Заявка на технику: вкладка по её состоянию плюс просьба открыть карточку. */
export function vehicleRequestLink(
  can: Can,
  request: { id: string; status: RequestStatus; deleted?: boolean },
): string | null {
  if (!can('vehicleRequests.read')) return null;
  // Вкладка спрашивается тем же правилом, каким её выберет адрес: удалённая заявка живёт в
  // архиве, и без этой проверки ссылка на неё показалась бы роли, которой архив не положен.
  if (vehicleRequestTab(request.status, request.deleted) === 'archive' && !canSeeArchiveTab(can))
    return null;
  return vehicleRequestPath(request);
}

/** Рейс: окно карточки поверх той страницы, где номер и увидели. */
export function vehicleRouteLink(can: Can, routeId: string): string | null {
  if (!canOpenRoute(can)) return null;
  return vehicleRoutePath(routeId);
}

/**
 * Заявка окном на чтение — статус для этого не нужен: адрес один на любое её состояние.
 * Спрашивают состав рейса, задание путевого листа, талоны журнала и занятость гаража, где статуса
 * заявки нет вовсе.
 *
 * Право здесь — не формальность, а тот самый барьер, который держит `vehicleRequestLink`. У
 * механика и главного механика есть и журнал листов, и гараж (`waybills.read`, `garage.read`), а
 * `vehicleRequests.read` нет вовсе (`packages/contracts/src/permissions.ts` — `mechanic`): без
 * проверки номера талонов в обоих разделах стали бы для них ссылками, кончающимися сообщением
 * «Заявка не найдена или недоступна». Сейчас они видят там обычный текст, и так и должно
 * остаться. Прав контракты не знают намеренно (шапка `packages/contracts/src/links.ts`), поэтому
 * `vehicleRequestViewPath` из мест вызова не зовётся напрямую — только отсюда.
 */
export function vehicleRequestViewLink(can: Can, requestId: string): string | null {
  if (!can('vehicleRequests.read')) return null;
  return vehicleRequestViewPath(requestId);
}

/**
 * Заявка на вывоз мусора: список заявок либо архив, если её удалили. Адрес остаётся здесь —
 * в письмах заявки на мусор не печатаются, и второго спрашивающего у него нет.
 */
export function wasteRequestLink(
  can: Can,
  request: { id: string; deleted?: boolean },
): string | null {
  if (!can('wasteRequests.read')) return null;
  if (request.deleted && !canSeeArchiveTab(can)) return null;
  return `/waste?tab=${request.deleted ? 'archive' : 'requests'}&open=${request.id}`;
}

/** Путевой лист: журнал учёта с поиском по номеру. */
export function waybillLink(can: Can, number: string): string | null {
  if (!can('waybills.read')) return null;
  return waybillPath(number);
}
