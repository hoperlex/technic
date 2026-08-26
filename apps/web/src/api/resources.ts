import type {
  CancelWaybillInput,
  CreateDriverBody,
  CreateRequestRelocationBody,
  CredentialTypeCode,
  DriverDto,
  DriverJobTitleDto,
  DriverSelectionDto,
  MergePointsBody,
  PointOrderBody,
  PointRoleOrderBody,
  RoutePointBody,
  SplitPointBody,
  VehicleRouteDto,
  VehicleRouteSuggestDto,
  WaybillDto,
  WaybillFormCode,
  DriverLicenseBody,
  RevokeDriverLicenseInput,
  UpdateDriverInput,
  VerifyDriverLicenseBody,
  AssignmentCommandBody,
  AssignmentPreviewDto,
  RepairBody,
  RepairPreviewDto,
  RepairResultDto,
  AssignVehicleBody,
  AttachVehicleTypeSpecInput,
  ChangeVehicleAssignmentBody,
  ChangeVehicleRequestTypeBody,
  CompleteVehicleRequestInput,
  CompleteWasteRequestInput,
  ConfirmScheduleBody,
  IssueRequestEsm2Body,
  PlanVehicleRequestDayBody,
  VehicleRequestDaysDto,
  CounterpartyDto,
  CreateCounterpartyInput,
  CreateVehicleCategoryInput,
  CreateVehicleInput,
  CreateVehicleRequestInput,
  CreateVehicleSpecInput,
  CreateVehicleTypeInput,
  DeleteVehicleResult,
  DirectoryImportBody,
  DirectoryImportReportDto,
  DirectoryInfoDto,
  DirectoryKey,
  DownloadUrlDto,
  FileDisposition,
  FileDto,
  ListResult,
  RequestHistoryEntryDto,
  RequestStatus,
  RequestVehicleEarlyEndInput,
  RequestType,
  RequestWaybillDto,
  RouteTripFields,
  SaveVehicleRequestShiftBody,
  UpdateCounterpartyInput,
  UpdateVehicleCategoryInput,
  UpdateVehicleInput,
  UpdateVehicleRequestInput,
  UpdateVehicleResult,
  UpdateVehicleSpecInput,
  UpdateVehicleTypeInput,
  UpdateVehicleTypeResult,
  UpdateVehicleTypeSpecInput,
  UploadSessionDto,
  VehicleCategoryDto,
  VehicleClassificationDto,
  VehicleDto,
  VehicleKindDto,
  VehicleModelDto,
  VehicleOnSiteListDto,
  VehicleOnSiteSummaryDto,
  VehicleFeedListDto,
  PeriodApplyBody,
  PeriodCommand,
  PeriodPreviewDto,
  RequestAssignmentHistoryDto,
  VehicleRequestDto,
  VehicleRequestDriverDto,
  VehicleRequestShiftsDto,
  VehicleRequestHistorySummaryDto,
  VehicleRequestSummaryDto,
  VehicleRequestStatusPreviewDto,
  VehicleSpecDto,
  VehicleTypeDto,
  VehicleTypeLinearSwitchPreviewDto,
  VehicleTypeLinearSwitchResultDto,
  VehicleTypeSpecDto,
  SwitchVehicleTypeLinearInput,
  PresentContainerGroupDto,
  WasteRequestDto,
  WasteRequestHistorySummaryDto,
  WasteRequestSummaryDto,
  ApproveWeeklyRequestBody,
  CreateWeeklyRequestBody,
  UpdateWeeklyRequestBody,
  WeeklyApplyResultDto,
  WeeklyCorrectionPreviewDto,
  WeeklyRequestDocumentsDto,
  WeeklyRequestStatus,
  WeeklyRequestStatusBody,
  WeeklySuggestionDto,
  WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { apiDownload, apiFetch, apiFetchBlob } from '@shared/api';

type Query = Record<string, unknown>;

/**
 * Учётки и журнал действий с ними, назначаемые полномочия и почтовый контур переехали в соседние
 * файлы: каждый из этих доменов описывает не столько ручки, сколько правила обращения с ними
 * (отпечаток последствий у полномочий, тела запроса у учёток, портальные типы ответов у рассылок),
 * и объяснять их посреди справочников техники — значит прятать объяснение.
 *
 * Реэкспорт, а не переезд импортов: адрес `api/resources` знают три десятка экранов, и менять их
 * все ради разреза реестра — правка, которую невозможно проверить глазами. Новые ручки этих
 * доменов добавляются в свой файл, а не сюда.
 */
export { auditApi, usersApi } from './users';
export type {
  DriverPersonBody,
  PersonCandidateDto,
  PersonCandidateMatch,
  RestoreUserBody,
  UserAccountDto,
  UserAccountMutationResult,
  UserPersonRefDto,
} from './users';
export { grantFormApi, grantKeys, grantsApi, userGrantsApi, type GrantCatalog } from './grants';
export { mailingsApi } from './mailings';
export type {
  MailDigestSampleUser,
  MailingRunStats,
  MailTestDriver,
  MailTestRecipient,
} from './mailings';

/**
 * Отделы переехали в `@entities/department`. Реэкспорт держится до конца этапа 2 на тех же
 * условиях, что у объектов: новые ручки добавляются в слайс, а не сюда.
 */
export { departmentsApi } from '@entities/department';

/**
 * Объекты переехали в `@entities/object`. Реэкспорт держится до конца этапа 2: по этому пути
 * импортируют ещё не переведённые экраны, а параллельная работа пишет новый код. Новые ручки
 * добавляются в слайс, а не сюда, — иначе правка встретится с разрезом конфликтом.
 */
export { objectsApi } from '@entities/object';

/**
 * Справочник водителей (ADR 0037). Отдельно от справочников не только маршрутом, но и правом:
 * в карточке персональные данные, и открыта она не всем, кому доступен список типов ТС.
 */
export const driversApi = {
  list: (q: Query) => apiFetch<ListResult<DriverDto>>('/drivers', { query: q }),
  get: (id: string) => apiFetch<DriverDto>(`/drivers/${id}`),
  create: (body: CreateDriverBody) => apiFetch<DriverDto>('/drivers', { method: 'POST', body }),
  update: (id: string, body: UpdateDriverInput) =>
    apiFetch<DriverDto>(`/drivers/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<void>(`/drivers/${id}`, { method: 'DELETE' }),
  /** Удаление насовсем из архива (ADR 0060): вместе с человеком уходят его документы и сканы. */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/drivers/${id}/purge`, { method: 'DELETE' }),
  addLicense: (id: string, body: DriverLicenseBody) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses`, { method: 'POST', body }),
  verifyLicense: (id: string, licenseId: string, body: VerifyDriverLicenseBody) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}/verify`, { method: 'POST', body }),
  revokeLicense: (id: string, licenseId: string, body: RevokeDriverLicenseInput) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}/revoke`, { method: 'POST', body }),
  /**
   * Убрать документ из карточки (право `records.purge`): не учётное действие, а исправление —
   * аннулирование для «перестал действовать», это для «его тут быть не должно».
   */
  deleteLicense: (id: string, licenseId: string) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}`, { method: 'DELETE' }),
  /**
   * Категории одного вида документа для формы: справочник наполнен миграцией и на чтение. Вид —
   * обязательным параметром (ADR 0095): «C» водительского и «C» тракториста это разные машины, и
   * общий список молча предложил бы приписать документу чужую букву.
   */
  licenseCategories: (type: CredentialTypeCode) =>
    apiFetch<{ id: string; code: string; name: string; description: string }[]>(
      '/drivers/license-categories',
      { query: { type } },
    ),
  /**
   * Должности справочника с числом людей — значения фильтра. Списком с сервера, а не константой:
   * должность приходит из кадров свободным текстом, и перечислить её наперёд портал не может.
   */
  jobTitles: () => apiFetch<DriverJobTitleDto[]>('/drivers/job-titles'),
  /** Кто может сесть за эту машину в эту дату — список выбора при переводе заявки в работу. */
  available: (q: { vehicleId: string; on: string; withTrailer?: boolean }) =>
    apiFetch<DriverSelectionDto>('/drivers/available', {
      query: { ...q, withTrailer: q.withTrailer ? 'true' : undefined },
    }),
};

/**
 * Журнал учёта путевых листов (ADR 0037). Выдачи здесь нет: лист рождается переводом заявки в
 * работу, и отдельной ручки «выписать» не существует — иначе появился бы лист без рейса.
 */
export const waybillsApi = {
  list: (q: Query) => apiFetch<ListResult<WaybillDto>>('/waybills', { query: q }),
  get: (id: string) => apiFetch<WaybillDto>(`/waybills/${id}`),
  cancel: (id: string, body: CancelWaybillInput) =>
    apiFetch<WaybillDto>(`/waybills/${id}/cancel`, { method: 'POST', body }),
  /**
   * Выгрузка бланка файлом. Раньше стояла ссылкой на адрес API — и не работала ни разу: маршрут
   * закрыт `app.authenticate`, а переход по `href` браузер делает без заголовка `Authorization`,
   * и вместо xlsx открывалась вкладка с 401 «Требуется авторизация». Вложения заявок так качать
   * можно (там presigned-ссылка на S3), бланк — нет: он собирается на лету.
   */
  exportFile: (id: string, number: string) =>
    apiDownload(`/waybills/${id}/export`, `Путевой лист ${number}.xlsx`),
  /**
   * Бланк, готовый к печати (ADR 0041): PDF показывается фреймом и печатается диалогом браузера,
   * не оседая файлом на машине. Не ссылкой, а телом ответа — фрейму его отдают из памяти вкладки.
   */
  printPdf: (id: string) => apiFetchBlob(`/waybills/${id}/print`),
  /**
   * Пачка листов одним документом: сервер собирает бланки подряд в один PDF, и диалог печати
   * остаётся один на всю пачку. Порядок листов задаёт портал — тот же, в каком их видно в журнале.
   */
  printBatch: (ids: string[]) =>
    apiFetchBlob('/waybills/print-batch', { method: 'POST', body: { ids } }),
  /**
   * Вложения к бланку: скан заполненного заказчиком оборота ЭСМ-2, отметки 4-П, акт. Файл сначала
   * уезжает в хранилище (`filesApi.upload`), сюда приходит только его идентификатор — тем же
   * порядком, что у вложений заявок.
   */
  attachFiles: (id: string, addFileIds: string[]) =>
    apiFetch<FileDto[]>(`/waybills/${id}/files`, { method: 'POST', body: { addFileIds } }),
  detachFile: (id: string, fileId: string) =>
    apiFetch<FileDto[]>(`/waybills/${id}/files/${fileId}`, { method: 'DELETE' }),
};

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
   * Новый порядок строк **состава** — полным списком заявок.
   *
   * Порядком печати он больше не распоряжается: строки задания печатаются в порядке **точек**
   * (Р11), и карточка переставляет точки (`points.order`). Ручка остаётся входом коррекции
   * (`requestOrder`) и мостом Р14а — тем самым, который выводит порядок точек из порядка заявок,
   * пока карточка на точки не переведена. Портал этой дверью порядок больше не двигает.
   */
  order: (id: string, body: { requestIds: string[]; version: number }) =>
    apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/order`, { method: 'PUT', body }),
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

export const counterpartiesApi = {
  list: (q: Query) => apiFetch<ListResult<CounterpartyDto>>('/counterparties', { query: q }),
  create: (body: CreateCounterpartyInput) =>
    apiFetch<CounterpartyDto>('/counterparties', { method: 'POST', body }),
  update: (id: string, body: UpdateCounterpartyInput) =>
    apiFetch<CounterpartyDto>(`/counterparties/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/counterparties/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<CounterpartyDto>(`/counterparties/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива (ADR 0060). */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/counterparties/${id}/purge`, { method: 'DELETE' }),
};

/**
 * Склады поставщиков переехали в `@entities/warehouse`. Реэкспорт держится до конца этапа 2 на тех
 * же условиях, что у объектов: новые ручки добавляются в слайс, а не сюда.
 */
export { warehousesApi } from '@entities/warehouse';

/**
 * Типы контейнеров переехали в `@entities/container-type`; реэкспорт держится до конца этапа 2 тем
 * же порядком, что у объектов. Новые ручки добавляются в слайс, а не сюда.
 */
export { containerTypesApi } from '@entities/container-type';

export const vehicleKindsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleKindDto>>('/vehicle-kinds', { query: q }),
};

export const vehicleTypesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleTypeDto>>('/vehicle-types', { query: q }),
  create: (body: CreateVehicleTypeInput) =>
    apiFetch<VehicleTypeDto>('/vehicle-types', { method: 'POST', body }),
  // Только описательные поля (типа) + isActive (подтипа). Структурные поля неизменяемы.
  // Признака линейности здесь нет: у переключения свой протокол (см. ниже), а этой ручке сервер
  // отвечает на него 422 — иначе подтверждение обходилось бы вкладкой, открытой со вчера.
  // Ответ — обёртка `{ type, unhitchedTrailers, unhitchedVehicles }`, а не карточка: перевод типа
  // на бланк «форма № 3» снимает привязки прицепов у всех машин типа разом (план §4.2.3).
  update: (id: string, body: UpdateVehicleTypeInput) =>
    apiFetch<UpdateVehicleTypeResult>(`/vehicle-types/${id}`, { method: 'PATCH', body }),
  /**
   * Что случится, если признак линейности переключить: сколько заявок останется на прежнем режиме,
   * какие именно и сколько из них лежит в архиве. Ничего не пишет — это чтение для диалога.
   *
   * `fingerprint` из ответа предъявляется переключению: между «показали номера» и «нажали» состав
   * заявок меняется, и подтверждали тогда не то, что записывается.
   */
  linearSwitchPreview: (id: string, isLinear: boolean) =>
    apiFetch<VehicleTypeLinearSwitchPreviewDto>(`/vehicle-types/${id}/linear-switch-preview`, {
      query: { isLinear },
    }),
  /**
   * Переключить признак линейности. Заявки в работе не отменяются и не переводятся: каждая
   * запоминает режим, которым её завели, и дорабатывает по нему — их номера приходят в ответе.
   *
   * Без `fingerprint` при непустом множестве сервер отвечает 422 «нужно подтверждение», при
   * разошедшемся — 409: ни то, ни другое ничего не записывает.
   */
  switchLinear: (id: string, body: SwitchVehicleTypeLinearInput) =>
    apiFetch<VehicleTypeLinearSwitchResultDto>(`/vehicle-types/${id}/linear`, {
      method: 'POST',
      body,
    }),
  // ТТХ типа (ADR 0016): привязка означает обязательность значения у каждой категории типа,
  // поэтому все четыре ручки возвращают актуальный набор ТТХ целиком.
  specs: (id: string) => apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs`),
  attachSpec: (id: string, body: AttachVehicleTypeSpecInput) =>
    apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs`, { method: 'POST', body }),
  updateSpec: (id: string, specId: string, body: UpdateVehicleTypeSpecInput) =>
    apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs/${specId}`, {
      method: 'PATCH',
      body,
    }),
  detachSpec: (id: string, specId: string) =>
    apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs/${specId}`, { method: 'DELETE' }),
  /** Удаление насовсем (ADR 0060): категории и привязки ТТХ уходят вместе с типом. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-types/${id}/purge`, { method: 'DELETE' }),
};

// ── ТТХ и категории типов ТС (ADR 0016) ──
export const vehicleSpecsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleSpecDto>>('/vehicle-specs', { query: q }),
  create: (body: CreateVehicleSpecInput) =>
    apiFetch<VehicleSpecDto>('/vehicle-specs', { method: 'POST', body }),
  // `code` неизменяем; `unit`/`decimals` сервер запретит менять, как только ТТХ привязан к типам.
  update: (id: string, body: UpdateVehicleSpecInput) =>
    apiFetch<VehicleSpecDto>(`/vehicle-specs/${id}`, { method: 'PATCH', body }),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-specs/${id}/purge`, { method: 'DELETE' }),
};

export const vehicleCategoriesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleCategoryDto>>('/vehicle-categories', { query: q }),
  create: (body: CreateVehicleCategoryInput) =>
    apiFetch<VehicleCategoryDto>('/vehicle-categories', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleCategoryInput) =>
    apiFetch<VehicleCategoryDto>(`/vehicle-categories/${id}`, { method: 'PATCH', body }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-categories/${id}`, { method: 'DELETE' }),
};

/**
 * Классификатор ТС одним списком (ADR 0028): тип с категориями раскрыт в категории, тип без
 * категорий — сам собой. Им заполняются все места, где выбирают «что заказываем» и «что это за
 * машина»: правило «общий тип при наличии категорий не выводится» одно на портал.
 */
export const vehicleClassificationsApi = {
  list: (q: Query) =>
    apiFetch<ListResult<VehicleClassificationDto>>('/vehicle-classifications', { query: q }),
};

export const vehicleModelsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleModelDto>>('/vehicle-models', { query: q }),
};

export const vehiclesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleDto>>('/vehicles', { query: q }),
  create: (body: CreateVehicleInput) => apiFetch<VehicleDto>('/vehicles', { method: 'POST', body }),
  /**
   * Ответы правки и архивации — обёртки с числом снятых привязок, а не карточка и не голое `{ ok }`:
   * обе двери снимают привязки прицепов (списание машины, перевод её типа на «форму № 3», уход в
   * архив), и о втором изменении в базе портал обязан сказать (`docs/vehicle-trailers-plan.md`, §4.2.3).
   */
  update: (id: string, body: UpdateVehicleInput) =>
    apiFetch<UpdateVehicleResult>(`/vehicles/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<DeleteVehicleResult>(`/vehicles/${id}`, { method: 'DELETE' }),
  restore: (id: string) => apiFetch<VehicleDto>(`/vehicles/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива (ADR 0060). */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/vehicles/${id}/purge`, { method: 'DELETE' }),
};

/**
 * Ответ двери срока: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Описан здесь, а не в контрактах, по той же причине, что и прочие ответы ручек: пакет контрактов
 * держит тела запросов и общие DTO, а этот тип живёт ровно между сервером и порталом. Повтор по
 * тому же ключу операции отвечает то же самое — по нему и видно, что работы не было (`repeated`).
 */
export interface VehicleRequestPeriodResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  dateFrom: string;
  dateTo: string | null;
  /** Что переписала сверка ЭСМ-2: сгоревшие и выписанные номера. */
  esm2: { cancelled: string[]; issued: string[] };
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  /** Ключ операции журнала; `null` — исход `none`, объяснять нечего (Р32). */
  operationId: string | null;
  history: RequestAssignmentHistoryDto;
}

/**
 * Ответ двери машиниста: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Пересобирается из **текущего** состояния, поэтому повтор по тому же ключу операции отвечает то
 * же, что ответил бы обычный запрос, — по нему и видно, что работы не было (`repeated`).
 * Переписанная бумага стоит рядом с историей намеренно: окно, сделавшее смену, обязано узнать и
 * то, чем продолжать (версия), и то, что случилось с номерами бланков.
 */
export interface AssignmentCommandResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  /** Что переписала сверка ЭСМ-2: сгоревшие и выписанные номера. */
  esm2: { cancelled: string[]; issued: string[] };
  history: RequestAssignmentHistoryDto;
}

/**
 * Что предъявляется вместе со статусом заявки. Тип один на смену статуса и её предпросмотр
 * намеренно: предпросмотр обязан считать последствия по тем же входам, по которым их потом
 * исполнит боевая ручка, — разойдись эти тела, диалог начал бы обещать не то.
 */
interface VehicleRequestStatusExtra {
  comment?: string;
  /** Техника и ставки при переводе в работу (ADR 0027). */
  assignment?: AssignVehicleBody;
  /** Фактический срок, о котором договорились при том же переводе. */
  schedule?: ConfirmScheduleBody;
  /** Отработанное время и стоимость при выполнении (ADR 0029). */
  completion?: CompleteVehicleRequestInput;
  /**
   * Отпечаток последствий, показанных предпросмотром. Обязателен на одном переходе — откате
   * «Выполнена» → «В работе» у заказа техники на объект, — и спрашивает его сервер: только он
   * знает, чем эта заявка пойдёт дальше.
   */
  previewFingerprint?: string;
}

export const vehicleRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests', { query: q }),
  /**
   * Лента раздела: заказы ТС и недельные заявки одним списком (ADR 0085 переехал в общий список).
   *
   * Отдельный маршрут, а не флаг у `list`: тем списком пользуются архив и подбор заявок в рейс, и
   * подмешивать туда документы, которые в рейс не ставятся, нельзя. Строка ленты размечена видом,
   * поэтому таблица разбирает её ветками, а не гадает по пустым полям.
   */
  feed: (q: Query) => apiFetch<VehicleFeedListDto>('/vehicle-requests/feed', { query: q }),
  /** Контакт водителя защищён правом на путевые листы и поэтому не входит в основной DTO. */
  driver: (id: string) =>
    apiFetch<VehicleRequestDriverDto | null>(`/vehicle-requests/${id}/driver`),
  /**
   * Что портал знает о рейсе до перевода заявки в работу: ведётся ли он, на какую дату, какие
   * рейсы на неё уже заведены и чем были заполнены графы шапки в прошлый раз. Форма либо кладёт
   * заявку в готовый рейс, либо заводит новый.
   *
   * Без `vehicleId` подсказываются рейсы того же типа ТС, что заказан в заявке: день планируют с
   * вопроса «каким рейсом заявка поедет», а машину задаёт сам рейс. С машиной — её рейсы и графы
   * шапки от её прошлого рейса (наследовать их без машины неоткуда).
   *
   * `date` передаётся, когда подачу правят прямо в форме: рейс печатает задание на день, и
   * подсказка обязана относиться к тому дню, который уедет на сервер.
   */
  routePrefill: (id: string, params: { vehicleId?: string; date?: string } = {}) =>
    apiFetch<{
      required: boolean;
      /** Бланк, по которому пойдёт лист; `null` — рейс этой заявке не ведётся. */
      formCode: WaybillFormCode | null;
      formLabel: string | null;
      reason: string | null;
      tripDate: string;
      routes: VehicleRouteDto[];
      trip: RouteTripFields | null;
    }>(`/vehicle-requests/${id}/route-prefill`, { query: { ...params } }),
  /**
   * Листы, выписанные по заявке (ADR 0041) — их печатают из карточки, не уходя в журнал. Пусто
   * там, где листов нет: аренда, заявка не в работе, тип без бланка.
   *
   * Список, а не один: у грузоперевозки лист по-прежнему один — рейс один, — а у заказа техники
   * на объект их столько, сколько недель в сроке (ЭСМ-2, миграция 0087).
   */
  waybills: (id: string) => apiFetch<RequestWaybillDto[]>(`/vehicle-requests/${id}/waybills`),
  /**
   * Выписать недельный ЭСМ-2 по требованию (ADR 0100 решение 6) — у линейного заказа портал
   * листов сам не выписывает, и это единственная дверь, через которую бланк рождается.
   *
   * `weekOf` — любой день нужной недели: границы листа считает сервер, пересекая календарную
   * неделю со сроком заявки, — тем же правилом, каким режет срок автоматическая выписка. Машина и
   * машинист приходят выбранными: за неделю на объекте могли отработать две единицы, а водитель у
   * каждого дня свой. В ответе — заявка целиком: у неё меняется версия, и список листов вместе с
   * ней.
   */
  issueEsm2: (id: string, body: IssueRequestEsm2Body) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/esm2`, { method: 'POST', body }),
  /**
   * Перегоны заявки: доставка техники на объект и вывоз с него. Пусто — их не заводили: технику
   * могли привезти тралом, и тогда листа на перегон не бывает вовсе.
   */
  relocations: (id: string) => apiFetch<VehicleRouteDto[]>(`/vehicle-requests/${id}/relocations`),
  createRelocation: (id: string, body: CreateRequestRelocationBody) =>
    apiFetch<VehicleRouteDto>(`/vehicle-requests/${id}/relocations`, { method: 'POST', body }),
  /** Счётчики заявок по статусам — сводка над списком; сужается объектом и типом заявки. */
  summary: (q: Query) =>
    apiFetch<VehicleRequestSummaryDto>('/vehicle-requests/summary', { query: q }),
  /**
   * Журнал закрытых заявок — вкладка «История» (ADR 0029): «Выполнена» и «Отменена» с фактом
   * выполнения. Отдельный маршрут: свой фильтр по арендодателю и свой порядок (по сроку работ).
   */
  historyList: (q: Query) =>
    apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests/history', { query: q }),
  /** Итог журнала по тем же фильтрам: сколько закрыто, чем закончилось и на какую сумму. */
  historySummary: (q: Query) =>
    apiFetch<VehicleRequestHistorySummaryDto>('/vehicle-requests/history/summary', { query: q }),
  /**
   * Техника на объектах прямо сейчас — вкладка «На объекте» (ADR 0036). День среза считает сервер
   * и возвращает в `onDate`: от него, а не от часов браузера, считаются подписи присутствия.
   */
  onSite: (q: Query) => apiFetch<VehicleOnSiteListDto>('/vehicle-requests/on-site', { query: q }),
  /** Итог среза по тем же фильтрам: сколько машин, на скольких объектах, кто вышел и кто уезжает. */
  onSiteSummary: (q: Query) =>
    apiFetch<VehicleOnSiteSummaryDto>('/vehicle-requests/on-site/summary', { query: q }),
  get: (id: string) => apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0015). */
  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`/vehicle-requests/${id}/history`),
  create: (body: CreateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>('/vehicle-requests', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`, { method: 'PATCH', body }),
  /**
   * Переоформить заявку в другой тип (ADR 0091): заказ завели работой на объекте, а нужен рейс —
   * или наоборот. Номер, вложения и история остаются за заявкой; тело — полный состав нового типа,
   * потому что деталь прежнего снимается целиком, а взять её значения новому типу неоткуда.
   */
  changeRequestType: (id: string, body: ChangeVehicleRequestTypeBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/request-type`, { method: 'PATCH', body }),
  /**
   * `comment` уходит в историю статусов; при отмене это обязательная причина. Остальное
   * предъявляется вместе со статусом и потому собрано в объект: `assignment` — техника и ставки
   * при переводе в работу (ADR 0027), `schedule` — фактический срок, о котором договорились при
   * том же переводе, `completion` — отработанное время и стоимость при выполнении (ADR 0029).
   * Всё это проводится тем же запросом, что и смена статуса: заявка не бывает «в работе» ни на
   * чём, взятой на одно время с листом на другое и «выполненной» без факта.
   */
  changeStatus: (
    id: string,
    status: RequestStatus,
    version: number,
    extra: VehicleRequestStatusExtra = {},
  ) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/status`, {
      method: 'PATCH',
      body: {
        status,
        comment: extra.comment ?? '',
        version,
        ...(extra.assignment ? { assignment: extra.assignment } : {}),
        ...(extra.schedule ? { schedule: extra.schedule } : {}),
        ...(extra.completion ? { completion: extra.completion } : {}),
        ...(extra.previewFingerprint ? { previewFingerprint: extra.previewFingerprint } : {}),
      },
    }),
  /**
   * Последствия перехода до его совершения: каким режимом заявка пойдёт дальше, что сделает сверка
   * ЭСМ-2 и как будет считаться занятость машины. Ничего не пишет.
   *
   * Тело — то же самое, что у смены статуса: план считается по машине, машинисту и сроку, которые
   * приходят из окна назначения, и своя схема разошлась бы с боевой на первом же новом поле.
   * Заведён под откат «Выполнена» → «В работе» — на прочих переходах сервер отвечает 422.
   */
  statusPreview: (
    id: string,
    body: VehicleRequestStatusExtra & { status: RequestStatus; version: number },
  ) =>
    apiFetch<VehicleRequestStatusPreviewDto>(`/vehicle-requests/${id}/status/preview`, {
      method: 'POST',
      body: { ...body, comment: body.comment ?? '' },
    }),
  /**
   * Сменить машину и ставки у заявки, которая уже в работе (ADR 0048): техника сломалась, ушла на
   * другой объект или её перепутали при переводе в работу. Статус при этом не меняется — тем и
   * отличается от повторного перевода в работу, которым назначение переписывали до сих пор.
   * Заявка переезжает в рейс новой машины той же транзакцией.
   */
  changeAssignment: (id: string, body: ChangeVehicleAssignmentBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/assignment`, { method: 'PATCH', body }),
  /**
   * Последствия смены техники до её совершения (волна 4a плана `docs/assignment-periods-plan.md`,
   * §7): какие номера ЭСМ-2 сгорят и какие выпишутся, какие подписи объекта слетят, каких дней не
   * хватает машинисту. Ничего не пишет.
   *
   * Тело — то же самое, что у боевой ручки, и это существенно: план считается по машине, машинисту
   * и коррекционному блоку из окна, а своя схема разошлась бы с боевой на первом же новом поле — и
   * вместе с ней разошёлся бы отпечаток, которым сервер сверяет обещанное.
   *
   * Отпечаток сюда не передаётся никогда: предпросмотр его выдаёт, а не спрашивает.
   */
  assignmentPreview: (id: string, body: ChangeVehicleAssignmentBody) =>
    apiFetch<AssignmentPreviewDto>(`/vehicle-requests/${id}/assignment/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Последствия правки срока до её совершения (волна 4a плана `docs/assignment-periods-plan.md`,
   * Ж4, З5, Л1): какие бланки ЭСМ-2 сгорят и какие выпишутся, какие решения о технике погасит
   * сокращение (Д2), какие отработанные листы придётся переоформить и нужна ли причина. Ничего
   * не пишет.
   *
   * Тело у предпросмотра — семантическая половина боевого (Л1): отпечатка, исхода и ключей листов
   * он ещё не знает — он их и вычисляет. Отпечаток сюда не передаётся никогда.
   */
  periodPreview: (id: string, body: PeriodCommand) =>
    apiFetch<PeriodPreviewDto>(`/vehicle-requests/${id}/period/preview`, { method: 'POST', body }),
  /**
   * Правка срока работ — своя дверь, а не поля широкого `PATCH /:id` (Ж4, З5).
   *
   * Узкое тело «продлить до 31 августа» в широкий маршрут не легло бы: там строгий union с
   * обязательными типом заявки, техникой, заказчиком, контактами и файлами. Но главное не форма
   * тела, а рукопожатия: сокращение способно **погасить решения о технике** за новым концом срока
   * (Д2), и портал обязан показать перечень и вернуть подтверждение — иначе сервер отвечает 422.
   *
   * Что уезжает подтверждениями: `previewFingerprint` — последствия, которые человек видел;
   * `cancelGroupsFingerprint` — перечень гасимых решений; `unlockFingerprint` — отработанные
   * листы, которые переоформит операция (присутствие поля задаёт исход, а не желание клиента);
   * `operation` — причина и ключ идемпотентности там, где нужна запись в журнале коррекций.
   *
   * Широкий маршрут при этом продолжает принимать даты (И5): выкат не одномоментный, и старый
   * путь остаётся рабочим до cutover.
   */
  changePeriod: (id: string, body: PeriodApplyBody) =>
    apiFetch<VehicleRequestPeriodResultDto>(`/vehicle-requests/${id}/period`, {
      method: 'PATCH',
      body,
    }),
  /**
   * История назначения заявки — то, из чего портал строит «Состав по датам» (этап 6 плана
   * `docs/assignment-periods-plan.md`, §9): с какого числа какая машина и какой машинист.
   *
   * Погашенные строки приходят наравне с актуальными: журнал заявки читают, чтобы понять, **что**
   * правили, а не только чем дело кончилось. Состояние готовности отдаётся той же ручкой (Р26) —
   * окно обязано отличить «истории нет» от «история есть, но неполна», и второй запрос за этим
   * означал бы, что между ними состояние успевает измениться.
   */
  assignmentHistory: (id: string) =>
    apiFetch<RequestAssignmentHistoryDto>(`/vehicle-requests/${id}/assignment-changes`),
  /**
   * Последствия команды машиниста до её совершения (§8). Ничего не пишет.
   *
   * Двухфазный (Р16): первый вызов идёт без якорей и возвращает `requiredAnchors` — границы, на
   * которых свёртка осталась бы без человека; второй, с названными именами, отдаёт окончательный
   * план и отпечаток, который и принимает боевая ручка. Одной фазы не хватает: пока люди не
   * названы, набор последствий ещё неизвестен, и подтверждать нечего.
   *
   * Тело — то же самое, что у боевой ручки (§8): расчёт обязан идти по тем входам, по которым его
   * потом исполнит команда, иначе окно начнёт обещать не то. Отпечаток сюда не передаётся никогда:
   * предпросмотр его выдаёт, а не спрашивает.
   */
  assignmentChangePreview: (id: string, body: AssignmentCommandBody) =>
    apiFetch<AssignmentPreviewDto>(`/vehicle-requests/${id}/assignment-changes/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Команда машиниста: `set` — назначить человека с даты, `cancel` — снять запланированное
   * решение (Р13).
   *
   * Ответ — состояние заявки после команды, а не отчёт о ней (Р9): версия, переписанные номера
   * ЭСМ-2 и вся история заново. Повтор по тому же ключу операции отвечает то же самое — по нему и
   * видно, что работы не было (`repeated`).
   */
  changeAssignmentMachinist: (id: string, body: AssignmentCommandBody) =>
    apiFetch<AssignmentCommandResultDto>(`/vehicle-requests/${id}/assignment-changes`, {
      method: 'POST',
      body,
    }),
  /**
   * Осмотр истории: что в ней чинить (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29).
   *
   * Первый запрос окна «Починка истории». Своя ручка, а не предпросмотр с пустым телом: тело
   * предпросмотра нарочно одно с боевым, а спросить «что чинить» окно обязано **до** того, как
   * назовёт работу. Главное в ответе — `fillableGaps`: какие `unknown`-промежутки заблокированы и
   * потому адресуются заполнением, а какие правятся якорями, знает только сервер — это зависит от
   * отменяемости бумаги. Ничего не пишет.
   */
  repairState: (id: string) =>
    apiFetch<RepairPreviewDto>(`/vehicle-requests/${id}/assignment-changes/repair/state`),
  /**
   * Последствия ремонта до его совершения (Р29): какие бланки сгорят, какие выпишутся задним
   * числом, какие отработанные листы придётся переоформить и станет ли история полной.
   *
   * Тело — то же самое, что у боевой ручки (§8). Отпечаток сюда не передаётся никогда:
   * предпросмотр его выдаёт, а не спрашивает.
   */
  repairPreview: (id: string, body: RepairBody) =>
    apiFetch<RepairPreviewDto>(`/vehicle-requests/${id}/assignment-changes/repair/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Ремонт истории: якоря на пробелах машиниста, заполнение `unknown` известным человеком,
   * решение о машине после конца срока и отмена заполнения (Р29, Р31).
   *
   * Заполнение выписывает недостающие бланки **задним числом** — расход строгой отчётности
   * реальный, и окно обязано показать номера до нажатия.
   */
  repairAssignmentHistory: (id: string, body: RepairBody) =>
    apiFetch<RepairResultDto>(`/vehicle-requests/${id}/assignment-changes/repair`, {
      method: 'POST',
      body,
    }),
  /** Виза руководителя строительства: `approved: false` — отзыв (ADR 0025). */
  setApproval: (id: string, approved: boolean, version: number) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/approval`, {
      method: 'PATCH',
      body: { approved, version },
    }),
  /**
   * Досрочное завершение заказа спецтехники (ADR 0044): техника освободилась раньше срока.
   * Запрос уходит на визу руководителя строительства; его собственный сервер применяет сразу.
   */
  requestEarlyEnd: (id: string, body: RequestVehicleEarlyEndInput) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/early-end`, { method: 'POST', body }),
  /** Решение по запросу: `approved: false` — отказ, и тогда причина обязательна. */
  decideEarlyEnd: (id: string, approved: boolean, version: number, comment = '') =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/early-end`, {
      method: 'PATCH',
      body: { approved, comment, version },
    }),
  /** Отозвать запрос, пока он ждёт визы: «отбой, техника нужна». */
  cancelEarlyEnd: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/early-end`, { method: 'DELETE' }),
  /**
   * Смены заказа спецтехники: дни заказа целиком, включая незаполненные. День среза (`onDate`)
   * считает сервер — по нему таблица решает, какая строка ещё в будущем и потому неактивна.
   */
  shifts: (id: string) => apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts`),
  /** Записать смену дня: время, машиночасы, заправку и комментарий. */
  saveShift: (id: string, date: string, body: SaveVehicleRequestShiftBody) =>
    apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts/${date}`, {
      method: 'PUT',
      body,
    }),
  /** Убрать ошибочно заведённый день — пока он не подтверждён. */
  deleteShift: (id: string, date: string) =>
    apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts/${date}`, {
      method: 'DELETE',
    }),
  /** Подпись объекта под днём работы и её снятие — одним маршрутом, как виза заявки. */
  approveShift: (id: string, date: string, approved: boolean) =>
    apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts/${date}/approval`, {
      method: 'POST',
      body: { approved },
    }),
  /**
   * Дни линейного заказа (ADR 0100): дни срока целиком — с рейсом дня, его машиной, водителем,
   * листом и часами смены. День среза (`onDate`) считает сервер, как и у смен.
   *
   * `blocker` приходит вместе с таблицей, а не вместо неё: у арендного заказа дней не бывает
   * вовсе, и блок обязан объяснить это словами — теми же, которыми откажет ручка планирования.
   */
  days: (id: string) => apiFetch<VehicleRequestDaysDto>(`/vehicle-requests/${id}/days`),
  /**
   * Поставить день заказа в рейс: в уже заведённый рейс машины на этот день (`routeId`) либо в
   * новый, заводимый тут же (`newRoute`). Ровно одно из двух — «и то, и другое» означало бы два
   * разных ответа на вопрос, куда едет день.
   *
   * День — часть адреса, а не тела: второй ответ на «за какой это день» разошёлся бы с первым,
   * тем же порядком устроены смены. В ответе — таблица дней целиком: изменился не только этот
   * день, но и перечень свободных рейсов у соседних.
   */
  planDay: (id: string, date: string, body: PlanVehicleRequestDayBody) =>
    apiFetch<VehicleRequestDaysDto>(`/vehicle-requests/${id}/days/${date}/route`, {
      method: 'POST',
      body,
    }),
  /**
   * Снять день с рейса. Сам рейс остаётся: он мог собираться из нескольких заявок, и пустой
   * маршрут диспетчер убирает своим действием.
   */
  unplanDay: (id: string, date: string) =>
    apiFetch<VehicleRequestDaysDto>(`/vehicle-requests/${id}/days/${date}/route`, {
      method: 'DELETE',
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/vehicle-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем (ADR 0070) — только из архива и только администратором. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-requests/${id}/purge`, { method: 'DELETE' }),
};

/** Событие истории недельной заявки: и переход статуса, и правка состава (Р17). */
export type WeeklyRequestHistoryEvent = 'status' | 'items_changed' | 'item_dropped';

/**
 * Строка истории недельной заявки. Своя, а не общая `RequestHistoryEntryDto`: у недельной заявки
 * события шире статусов — состав меняется и без перехода (правкой черновика, уборкой строк при
 * `purge`), и такое событие обязано пережить сбой записи аудита (Р17).
 */
export interface WeeklyRequestHistoryEntryDto {
  id: string;
  event: WeeklyRequestHistoryEvent;
  fromStatus: WeeklyRequestStatus | null;
  toStatus: WeeklyRequestStatus | null;
  /** Что именно изменилось: снятые строки с номерами заказов, состав до и после. */
  payload: Record<string, unknown>;
  changedByName: string;
  changedAt: string;
  comment: string;
}

/**
 * Ответ решения — визы, отказа, подачи и снятия: заявка после него и итог применения, если оно
 * состоялось. Двумя половинами, а не одной: виза применяет заявку той же транзакцией (Р6), а
 * подача заявки тем, кто её и визирует, применяет её сразу же (Р8) — и «сколько строк прошло»
 * отвечает только применение. У отказа и снятия итога нет вовсе, поэтому `apply` бывает `null`.
 */
export interface WeeklyDecisionResultDto {
  request: WeeklyVehicleRequestDto;
  apply: WeeklyApplyResultDto | null;
}

/**
 * Недельная заявка на технику (ADR 0085) — документ-основание **над** заказами ТС: площадка
 * заказывает не машину на срок, а неделю целиком, а виза руководителя строительства продлевает
 * сроки и порождает обычные заказы той же транзакцией (Р1, Р6).
 *
 * Состав правится целиком (`items` переписывается массивом), а не операциями «добавить строку»:
 * две одновременные правки иначе собрали бы дубли. `version` в теле — токен оптимистичной
 * блокировки: сервер сверяет его с текущей версией и присваивает колонке своё значение.
 */
export const weeklyRequestsApi = {
  /**
   * Предложение состава на пару «объект + неделя» (Р4): что продлевать, что уезжает, что заказано
   * дольше недели и что в состав не годится — с причинами. Здесь же приходит `existingRequestId`:
   * заявка на эту неделю уже собирается, и кнопка обязана открыть её, а не заводить вторую (Р3).
   */
  suggestion: (q: { objectId: string; weekStart: string }) =>
    apiFetch<WeeklySuggestionDto>('/weekly-vehicle-requests/suggestion', { query: q }),
  create: (body: CreateWeeklyRequestBody) =>
    apiFetch<WeeklyVehicleRequestDto>('/weekly-vehicle-requests', { method: 'POST', body }),
  get: (id: string) => apiFetch<WeeklyVehicleRequestDto>(`/weekly-vehicle-requests/${id}`),
  update: (id: string, body: UpdateWeeklyRequestBody) =>
    apiFetch<WeeklyVehicleRequestDto>(`/weekly-vehicle-requests/${id}`, {
      method: 'PATCH',
      body,
    }),
  /**
   * Переходы составителя: подать и снять с причиной. Визы здесь нет — она отдельным решением; но
   * подача руководителем строительства своей площадки применяет заявку тем же запросом (Р8),
   * поэтому ответ тот же, что и у визы.
   */
  changeStatus: (id: string, body: WeeklyRequestStatusBody) =>
    apiFetch<WeeklyDecisionResultDto>(`/weekly-vehicle-requests/${id}/status`, {
      method: 'POST',
      body,
    }),
  /**
   * Виза либо отказ. Виза применяет заявку сразу: отдельного «применить» не существует (Р6).
   *
   * Этим же вызовом идёт проведение просроченной недели задним числом (ADR 0101): у неё в теле
   * обязателен блок `correction` — ключ операции, причина и названные к перевыписке листы ЭСМ-2.
   * Второй ручки под проведение нет намеренно: решение человека одно — «завизировать и провести», —
   * и разведи его портал по двум вызовам, на экране появились бы две кнопки на одно действие.
   *
   * Повтор с тем же `operationId` — не ошибка, а ответ на обрыв связи: сервер возвращает 200 и
   * `apply: null`, ничего не двигая второй раз. Поэтому ключ придумывает окно **до** отправки и
   * держит его неизменным, а повторная попытка обязана уйти тем же телом целиком (отпечаток
   * команды считается со всей команды, включая версию).
   */
  approval: (id: string, body: ApproveWeeklyRequestBody) =>
    apiFetch<WeeklyDecisionResultDto>(`/weekly-vehicle-requests/${id}/approval`, {
      method: 'POST',
      body,
    }),
  /**
   * Что проведение этой недели тронет в прошлом (ADR 0101): какие номера ЭСМ-2 можно назвать к
   * перевыписке, за какие прошедшие недели выпишется бумага, какая у операции эффективная дата и
   * докуда достаёт глубина права.
   *
   * Считает это сервер тем же кодом, которым будет исполнять, — как и у коррекции рейса: второй
   * расчёт в портале разошёлся бы с первым, и окно обещало бы не то, что произойдёт. Здесь же
   * приходят `allowed` и `blockedReason` — почему провести нельзя, если нельзя: ручка отвечает на
   * этот вопрос и тому, кто проводить не вправе, потому что 403 объяснил бы отсутствие права, но
   * не выход из положения.
   */
  correctionPreview: (id: string) =>
    apiFetch<WeeklyCorrectionPreviewDto>(`/weekly-vehicle-requests/${id}/correction`),
  /** Чек-лист готовности недели (§5 шаг 6) — экран, ради которого модуль и делается. */
  documents: (id: string) =>
    apiFetch<WeeklyRequestDocumentsDto>(`/weekly-vehicle-requests/${id}/documents`),
  history: (id: string) =>
    apiFetch<WeeklyRequestHistoryEntryDto[]>(`/weekly-vehicle-requests/${id}/history`),
};

export interface WasteRequestPayload {
  objectId: string;
  requestType: RequestType;
  containerTypeId?: string;
  /** Чей контейнер снимаем/меняем и сколько единиц (ADR 0054); только у замены и снятия. */
  containerOwnerCounterpartyId?: string;
  containersCount?: number;
  /** Подтверждение вывоза чужого контейнера — причиной. */
  ownerMismatchReason?: string;
  wasteTypeId?: string;
  volumeM3?: number;
  /** Контрагент-оператор вывоза; можно назначить позже (ADR 0010). */
  operatorCounterpartyId?: string;
  deliveryAt: string;
  /** Кто принимает машину на площадке (миграция 0062); при заведении заявки обязателен. */
  responsibleName: string;
  responsiblePhone: string;
  comment?: string;
  fileIds?: string[];
}

export interface WasteRequestUpdatePayload {
  objectId?: string;
  requestType?: RequestType;
  containerTypeId?: string | null;
  containerOwnerCounterpartyId?: string | null;
  containersCount?: number;
  ownerMismatchReason?: string;
  wasteTypeId?: string | null;
  volumeM3?: number | null;
  operatorCounterpartyId?: string | null;
  // Факта выполнения здесь нет: он предъявляется закрытием заявки и правится повторным
  // закрытием (ADR 0035).
  deliveryAt?: string;
  // Не переданный контакт означает «не трогали»; пустым сервер его оставить не даст.
  responsibleName?: string;
  responsiblePhone?: string;
  comment?: string;
  addFileIds?: string[];
  removeFileIds?: string[];
  version: number;
}

/**
 * Типы мусора и прайс вывоза переехали в `@entities/waste-type` и `@entities/waste-tariff`. Слайса
 * два, а не один общий: тип мусора спрашивают и там, где прайса нет вовсе (форма заявки), — и
 * тянуть за ним весь прайс незачем. Связь между ними односторонняя и живёт в ручках прайса: тип
 * заводится вместе с первой ценой (ADR 0017).
 */
export { wasteTypesApi } from '@entities/waste-type';
export { wasteTariffsApi } from '@entities/waste-tariff';

export const wasteRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteRequestDto>>('/waste-requests', { query: q }),
  /** Наличие контейнеров на площадках (присутствующие заявки установки). */
  present: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/present', { query: q }),
  /**
   * Группы присутствия на объекте: что и чьё там стоит, сколько штук (ADR 0054). Одна выборка на
   * выбор контейнера в заявке, потолок количества и подсказку «кого звать на этот объект».
   */
  presentGroups: (objectId: string) =>
    apiFetch<PresentContainerGroupDto[]>('/waste-requests/present-groups', {
      query: { objectId },
    }),
  /** Счётчики заявок по статусам — сводка над списком; сужается только фильтром по объекту. */
  summary: (q: Query) => apiFetch<WasteRequestSummaryDto>('/waste-requests/summary', { query: q }),
  /**
   * Журнал закрытых заявок — вкладка «История» (ADR 0135): завершённые и отменённые. Своя ручка,
   * а не список с фильтром: в списке закрытых заявок нет вовсе, и вопросы к журналу другие.
   */
  historyList: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/history', { query: q }),
  /** Итог журнала по тем же фильтрам: сколько закрыто, чем закончилось, что вывезли. */
  historySummary: (q: Query) =>
    apiFetch<WasteRequestHistorySummaryDto>('/waste-requests/history/summary', { query: q }),
  get: (id: string) => apiFetch<WasteRequestDto>(`/waste-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0012). */
  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`/waste-requests/${id}/history`),
  create: (body: WasteRequestPayload) =>
    apiFetch<WasteRequestDto>('/waste-requests', { method: 'POST', body }),
  update: (id: string, body: WasteRequestUpdatePayload) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, { method: 'PATCH', body }),
  /**
   * Назначение/снятие оператора вывоза; предмет заявки и тариф не пересчитываются (ADR 0010).
   * `ownerMismatchReason` — подтверждение вывоза чужого контейнера: назначение и есть тот момент,
   * когда расхождение возникает (ADR 0054).
   */
  assignOperator: (
    id: string,
    operatorCounterpartyId: string | null,
    version: number,
    ownerMismatchReason?: string,
  ) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/operator`, {
      method: 'PATCH',
      body: { operatorCounterpartyId, version, ownerMismatchReason },
    }),
  /**
   * Примечание исполнителя — вторая строка комментария заявки (ADR 0053). Отдельной ручкой:
   * оператор заявку не редактирует, а общий PATCH пересчитывает её предмет и тариф.
   */
  setOperatorComment: (id: string, operatorComment: string, version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/comment`, {
      method: 'PATCH',
      body: { operatorComment, version },
    }),
  /**
   * `comment` уходит в историю статусов; при отмене это обязательная причина.
   * `completion` принимается только при закрытии заявки — факт вывоза фиксируется тем же
   * запросом, что и статус (ADR 0035).
   */
  changeStatus: (
    id: string,
    status: RequestStatus,
    version: number,
    // Что предъявляется вместе со статусом, зависит от типа заявки, поэтому необязательные
    // части собраны в объект: позиционным списком из пяти аргументов вызов стал бы нечитаемым.
    extra: {
      comment?: string;
      /** Факт вывоза: фактический объём и стоимость — только вывоз мусора (ADR 0035). */
      completion?: CompleteWasteRequestInput;
      /** Талоны закрытия — общий пул заявки у любого типа (ADR 0013, ADR 0024). */
      ticketFileIds?: string[];
    } = {},
  ) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/status`, {
      method: 'PATCH',
      body: {
        status,
        version,
        comment: extra.comment ?? '',
        ...(extra.completion ? { completion: extra.completion } : {}),
        ticketFileIds: extra.ticketFileIds ?? [],
      },
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/waste-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем (ADR 0070) — только из архива и только администратором. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${id}/purge`, { method: 'DELETE' }),
};

export const filesApi = {
  createUploadSession: (filename: string, contentType: string, size: number) =>
    apiFetch<UploadSessionDto>('/files/upload-session', {
      method: 'POST',
      body: { filename, contentType, size },
    }),
  complete: (id: string) => apiFetch<FileDto>(`/files/${id}/complete`, { method: 'POST' }),
  downloadUrl: (id: string, disposition: FileDisposition = 'attachment') =>
    apiFetch<DownloadUrlDto>(`/files/${id}/download`, { query: { disposition } }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/files/${id}`, { method: 'DELETE' }),

  /** Полный цикл загрузки: session → PUT в S3 → complete. */
  async upload(file: File): Promise<FileDto> {
    const contentType = file.type || 'application/octet-stream';
    const session = await filesApi.createUploadSession(file.name, contentType, file.size);
    const put = await fetch(session.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    });
    if (!put.ok) throw new Error(`Ошибка загрузки в хранилище (${put.status})`);
    return filesApi.complete(session.fileId);
  },

  /**
   * Скачивание. Ссылка ведёт на ответ с `Content-Disposition: attachment`, поэтому переход
   * по ней сохраняет файл и не уводит со страницы — новая вкладка для этого не нужна.
   */
  async download(id: string): Promise<void> {
    const { url } = await filesApi.downloadUrl(id, 'attachment');
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  },
};

/**
 * Обмен справочниками через файл Excel (ADR 0073). Ручки общие на все справочники: какой именно
 * выгружается и загружается, задаёт ключ в адресе. Восемнадцать одноимённых ресурсов означали бы
 * восемнадцать мест, где один и тот же запрос назван по-своему.
 */
export const directoriesApi = {
  /** Список со счётчиками строк — им вкладка обмена и рисуется. */
  list: () => apiFetch<{ items: DirectoryInfoDto[] }>('/directories'),
  /**
   * Выгрузка книгой. Тем же порядком, что бланк путевого листа: маршрут закрыт `app.authenticate`,
   * а переход по `href` браузер делает без заголовка `Authorization` — вместо файла открылась бы
   * вкладка с 401. Имя файла портал не придумывает: сервер ставит в него дату выгрузки, а запасное
   * нужно ровно на случай, когда заголовок не доехал.
   */
  exportFile: (key: DirectoryKey, title: string) =>
    apiDownload(`/directories/${key}/export`, `${title}.xlsx`),
  /**
   * Загрузка правленого файла. `dryRun` — обязательный первый шаг: одно нажатие меняет сотни
   * строк справочника, и сначала сервер отвечает отчётом, не записав ничего.
   */
  import: (key: DirectoryKey, body: DirectoryImportBody) =>
    apiFetch<DirectoryImportReportDto>(`/directories/${key}/import`, { method: 'POST', body }),
};
