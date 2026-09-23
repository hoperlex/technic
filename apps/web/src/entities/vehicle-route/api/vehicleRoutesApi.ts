import type {
  ListResult,
  MergePointsBody,
  PointOrderBody,
  PointRoleOrderBody,
  RequestStatus,
  RoutePointBody,
  RouteTripFields,
  SplitPointBody,
  VehicleRouteDto,
  VehicleRouteSuggestDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Маршруты — рейс машины на дату (план `docs/vehicle-routes-plan.md`). Заявку кладут в рейс
 * переводом в работу либо здесь; лист выписывается с рейса, когда состав собран.
 *
 * Версия рейса уходит в каждое изменение состава и в выписку: рейс правят несколько диспетчеров
 * сразу, и «кто последний, тот и прав» означало бы лист не на тот состав.
 */
export const vehicleRoutesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleRouteDto>>('/vehicle-routes', { query: q }),
  get: (id: string) => apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}`),
  /**
   * Что портал знает об этой машине на этот день: её рейсы, графы шапки прошлого рейса (ими окна
   * наследуют реквизиты выезда — их правят раз в сезон) и закреплённые за ней прицепы, которые
   * приходят отдельным полем и читаются своим правилом (`docs/vehicle-trailers-plan.md`, §4.2.2).
   *
   * Тип ответа — из контрактов, а не инлайном: повтор знал два поля из трёх, третьего не заметив.
   */
  suggest: (q: { vehicleId: string; date: string }) =>
    apiFetch<VehicleRouteSuggestDto>('/vehicle-routes/suggest', { query: q }),
  create: (body: {
    vehicleId: string;
    routeDate: string;
    driverPersonId?: string | null;
    trip?: RouteTripFields;
    comment?: string;
    /**
     * Причина заведения задним числом (ADR 0101, дыра 1): обязательна на сервере ровно тогда,
     * когда `routeDate` уже прошла, — решает это `backdateGuard`, который знает права субъекта.
     */
    reason?: string;
  }) => apiFetch<VehicleRouteDto>('/vehicle-routes', { method: 'POST', body }),
  update: (
    id: string,
    body: {
      version: number;
      /** День рейса: сервер переносит вместе с ним и подачу заявок состава. */
      routeDate?: string;
      driverPersonId?: string | null;
      trip?: RouteTripFields;
      comment?: string;
      /** Задание перегона; у грузового рейса сервер их не примет. */
      moveFrom?: string;
      moveTo?: string;
    },
  ) => apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/vehicle-routes/${id}`, { method: 'DELETE' }),
  /** Положить заявку в рейс или перенести её из другого — тогда `source` обязателен. */
  attach: (
    id: string,
    body: { requestId: string; version: number; source?: { routeId: string; version: number } },
  ) => apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/requests`, { method: 'POST', body }),
  detach: (id: string, requestId: string, version: number) =>
    apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/requests/${requestId}`, {
      method: 'DELETE',
      query: { version: String(version) },
    }),
  /**
   * Порядок объезда: точки маршрута (§7 плана `docs/route-trips-plan.md`).
   *
   * Все двери отвечают рейсом целиком, а не одной точкой: правка точки уплотняет позиции соседей,
   * совмещение убирает лишние остановки, разнесение заводит новую — и версия рейса поднимается у
   * каждой (Р16). Ответ куском ставил бы карточку перед задачей сшить его с тем, что у неё уже
   * есть, а сшивать тут нечего: состояние маршрута одно и приходит целиком.
   *
   * Заведения и удаления точки здесь нет намеренно, хотя ручки такие есть. Точка без ролей не
   * заводится и не остаётся (Р13): пустая остановка в порядке объезда — не то, что человек может
   * захотеть, а сбой; заводит и убирает точки сам сервер — укладкой заявки, совмещением,
   * разнесением и чисткой опустевших. Дверь «завести точку» в карточке потребовала бы спросить
   * роли, а это ровно «разнести».
   */
  points: {
    /** Адрес, время, комментарий и состав ролей **целиком** (роли идут прежними, если их не меняют). */
    update: (id: string, pointId: string, body: RoutePointBody) =>
      apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/points/${pointId}`, {
        method: 'PATCH',
        body,
      }),
    /** Новый порядок объезда полным списком точек (Р14): сервер переписывает позиции целиком. */
    order: (id: string, body: PointOrderBody) =>
      apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/points/order`, {
        method: 'PUT',
        body,
      }),
    /**
     * Новый порядок работ внутри одной точки — полным списком её ролей.
     *
     * Им переставляются строки задания, которые порядок объезда не различает: две строки, стоящие
     * на одной и той же паре точек (Р8 переиспользует точку), — «какую из ездок грузим первой».
     */
    rolesOrder: (id: string, pointId: string, body: PointRoleOrderBody) =>
      apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/points/${pointId}/roles/order`, {
        method: 'PUT',
        body,
      }),
    /** Совместить точки одного адреса: роли переезжают в первую по позиции (Р9а). */
    merge: (id: string, body: MergePointsBody) =>
      apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/points/merge`, {
        method: 'POST',
        body,
      }),
    /** Разнести точку надвое: названные роли уходят в новую точку сразу за исходной (Р9а). */
    split: (id: string, pointId: string, body: SplitPointBody) =>
      apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/points/${pointId}/split`, {
        method: 'POST',
        body,
      }),
  },
  /**
   * Выписать лист по рейсу. `reason` и `operationId` нужны выписке на **прошедший** день (ADR 0101,
   * дыра 1): такой лист рождается операцией коррекции, а ключ спасает от второго сгоревшего номера
   * после обрыва связи (Р31). Обычная дневная выписка ни того, ни другого не передаёт — сервер их и
   * не спрашивает.
   */
  issueWaybill: (
    id: string,
    body: {
      version: number;
      reason?: string;
      operationId?: string;
      /**
       * Отпечаток предупреждений, которые человек прочитал в окне (Р21). Присылается только вторым
       * запросом — после 409 `waybill_ack_required`: считает набор сервер, и первый запрос идёт без
       * подтверждения именно потому, что подтверждать до ответа нечего.
       */
      acknowledge?: { fingerprint: string };
    },
  ) => apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/waybill`, { method: 'POST', body }),
  /**
   * Что будет, если рейс исправить (ADR 0101, Р36): цена операции и её блокировки — до нажатия.
   *
   * Считает их сервер тем же кодом, которым будет исполнять: второй расчёт в портале разошёлся бы
   * с первым, и окно обещало бы не то, что произойдёт. Отметки печати и подшитые файлы сюда не
   * входят — они у карточки листа (`waybillsApi.get`), и спрашивать их дважды незачем.
   */
  correctionPreview: (id: string) =>
    apiFetch<{
      routeDate: string;
      today: string;
      /** Что мешает коррекции здесь и сейчас; `null` — ничего (Р3, Р13, Р37). */
      blocking: { reason: string; requests: string[] } | null;
      /** Номер, который сгорит; `null` — действующего листа у рейса нет. */
      waybill: { id: string; number: string; status: string; issuedForDate: string } | null;
      requests: {
        requestId: string;
        displayNumber: string;
        position: number;
        /** День линейного заказа: его назначение коррекция не трогает (ADR 0100 п. 4). */
        workDate: string | null;
        status: RequestStatus;
        assignedVehicleId: string | null;
      }[];
      /** Подписи объекта, которые снимет коррекция (Р5). */
      shifts: {
        requestId: string;
        displayNumber: string;
        date: string;
        approvedByName: string;
        approvedAt: string;
      }[];
    }>(`/vehicle-routes/${id}/correction`),
  /**
   * Исправить исполнение прошедшего рейса (ADR 0101, Р2). `operationId` придумывает клиент до
   * отправки: повтор после обрыва связи обязан вернуть прежний результат, а не сжечь второй номер
   * бланка, — и повторяться должно **всё тело целиком**, вместе с версией рейса (Р31).
   */
  correct: (
    id: string,
    body: {
      operationId: string;
      version: number;
      vehicleId?: string;
      driverPersonId?: string;
      trip?: RouteTripFields;
      requestOrder?: string[];
      reason: string;
    },
  ) => apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/correction`, { method: 'POST', body }),
  /**
   * Перенести заявку между рейсами прошедших дней (ADR 0101, Р30): `id` — рейс-**приёмник**,
   * `source` — источник со своей версией.
   *
   * Обе версии обязательны, потому что операция трогает оба рейса и жжёт **два** номера: одной
   * версии хватило бы ровно до первой встречной правки чужого рейса. Ответ несёт обе стороны —
   * у источника после переноса другой номер листа (или ни одного, если он опустел, Р22), и
   * показать один значило бы оставить второй устаревшим на экране.
   */
  transferCorrection: (
    id: string,
    body: {
      operationId: string;
      version: number;
      source: { routeId: string; version: number };
      requestId: string;
      position?: number;
      reason: string;
    },
  ) =>
    apiFetch<{ target: VehicleRouteDto; source: VehicleRouteDto }>(
      `/vehicle-routes/${id}/correction/transfer`,
      { method: 'POST', body },
    ),
};
