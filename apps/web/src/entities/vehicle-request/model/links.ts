import {
  vehicleRequestPath,
  vehicleRequestTab,
  vehicleRequestViewPath,
  type Permission,
  type RequestStatus,
} from '@technic/contracts';
import { canSeeArchiveTab } from '@entities/request';

/**
 * Право на переход к заявке на технику по её номеру, названному в чужом списке.
 *
 * Переход состоит из двух половин, и врозь они расходятся: адрес («какое окно открыть») и право на
 * него («показывать ли ссылку вообще»). Здесь вторая: сами адреса живут в контрактах
 * (`packages/contracts/src/links.ts`), потому что спрашивают их двое — портал и почта, печатающая
 * номер заявки в сводке. Разойдись эти два места, ссылка из письма привела бы на список, в котором
 * записи нет.
 *
 * Обёртка возвращает `null`, если цель этой роли не положена: место вызова тогда рисует прежний
 * текст. Ссылка, ведущая туда, куда роль не пускают, кончается пустым экраном, редиректом или
 * сообщением «не найдена» — это хуже, чем номер обычным текстом, каким он и был.
 *
 * THE OTHER HALF OF THIS PAIR IS NOT HERE YET. `vehicleRequestLink` picks the tab by the state of
 * the request, and for the archive tab it asks the same predicate the waste request asks
 * (`canSeeArchiveTab`) — one rule shared by three modules, whose home is `entities/request`. Until
 * that slice has a public entry, the tab-choosing wrapper stays in `apps/web/src/utils/links.ts`:
 * an entity may not reach into an unlayered directory, and a second copy of the archive predicate
 * would let the link and the tab it leads to disagree about who may see deleted records.
 */

type Can = (permission: Permission) => boolean;

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
 * Заявка на технику: вкладка по её состоянию плюс просьба открыть карточку.
 *
 * Право на архив спрашивается у слайса заявки (`@entities/request`) — единственного, читать который
 * этому слайсу разрешено матрицей границ. Своя копия предиката разошлась бы с той, которой
 * пользуется сам список: ссылка предложилась бы роли, у которой архив не открывается.
 */
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
