import type { RequestStatus } from './enums';
import { isClosedRequestStatus } from './vehicle-requests';

/**
 * Адреса записей портала: куда ведёт номер, названный не на своём экране.
 *
 * Здесь, а не во фронте, потому что спрашивают их двое. Портал — когда рисует номер чужой записи
 * ссылкой (`apps/web/src/utils/links.ts`), и почта — когда печатает номер заявки в сводке
 * (`services/mailings/digest-waybills.ts`). Ответ обязан быть один: разойдись эти два места, и
 * ссылка из письма привела бы на список, в котором заявки нет, а карточка открылась бы поверх
 * чужих строк — или не открылась вовсе.
 *
 * Прав функции не знают и не проверяют: право — вопрос вызывающего. У портала это `can`, у письма
 * — область видимости получателя, которой заявка уже отобрана. Смешать их здесь значило бы завести
 * третий способ спрашивать разрешение.
 */

/** Ключи вкладок раздела «Заказ автотехники» — те же, что читает `VehicleRequestsPage`. */
export type VehicleTab = 'requests' | 'on-site' | 'routes' | 'history' | 'archive';

/**
 * Вкладка, на которой заявку на технику показывают сейчас: пока её ведут — в списке, закрытую —
 * в журнале (ADR 0029), удалённую — в архиве (ADR 0070).
 */
export function vehicleRequestTab(status: RequestStatus, deleted = false): VehicleTab {
  if (deleted) return 'archive';
  return isClosedRequestStatus(status) ? 'history' : 'requests';
}

/**
 * Путь к карточке заявки на технику. Параметр `open` читает `useOpenedRecord` — тот же механизм,
 * которым карточку открывают ссылки внутри портала.
 */
export function vehicleRequestPath(request: {
  id: string;
  status: RequestStatus;
  deleted?: boolean;
}): string {
  return `/vehicle-requests?tab=${vehicleRequestTab(request.status, request.deleted)}&open=${request.id}`;
}

/** Путь к карточке рейса: вкладка «Маршруты» с открытой карточкой. */
export function vehicleRoutePath(routeId: string): string {
  return `/vehicle-requests?tab=routes&open=${routeId}`;
}

/**
 * Путь к путевому листу: журнал учёта с поиском по номеру. Карточки у листа нет — журнал и есть
 * карточка: строка отвечает, на какую машину лист выписан, что с ним стало и чем подшит (ADR 0037).
 */
export function waybillPath(number: string): string {
  return `/waybills?number=${encodeURIComponent(number)}`;
}

/** Вкладка «На объекте»: техника, стоящая на площадках, — полный список строк сводки ЭСМ-2. */
export const VEHICLE_ON_SITE_PATH = '/vehicle-requests?tab=on-site';

/** Вкладка «Маршруты»: полный список рейсов — куда ведёт счётчик обрезанной таблицы перевозок. */
export const VEHICLE_ROUTES_PATH = '/vehicle-requests?tab=routes';
