import type {
  CancelWaybillInput,
  CreateDriverBody,
  CreateRelocationRouteBody,
  DriverDto,
  DriverSelectionDto,
  DriversImportBody,
  DriversImportReportDto,
  VehicleRouteDto,
  WaybillDto,
  WaybillFormCode,
  DriverLicenseBody,
  RevokeDriverLicenseInput,
  UpdateDriverInput,
  VerifyDriverLicenseBody,
  AssignVehicleBody,
  AttachVehicleTypeSpecInput,
  ChangeVehicleAssignmentBody,
  CompleteVehicleRequestInput,
  CompleteWasteRequestInput,
  ConfirmScheduleBody,
  CounterpartyDto,
  CreateCounterpartyInput,
  CreateUserInput,
  CreateVehicleCategoryInput,
  CreateVehicleInput,
  CreateVehicleRequestInput,
  CreateVehicleSpecInput,
  CreateVehicleTypeInput,
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
  UpdateUserInput,
  UpdateVehicleCategoryInput,
  UpdateVehicleInput,
  UpdateVehicleRequestInput,
  UpdateVehicleSpecInput,
  UpdateVehicleTypeInput,
  UpdateVehicleTypeSpecInput,
  UploadSessionDto,
  UserDto,
  VehicleCategoryDto,
  VehicleClassificationDto,
  VehicleDto,
  VehicleKindDto,
  VehicleModelDto,
  VehicleOnSiteListDto,
  VehicleOnSiteSummaryDto,
  VehicleRequestDto,
  VehicleRequestShiftsDto,
  VehicleRequestHistorySummaryDto,
  VehicleRequestSummaryDto,
  VehicleSpecDto,
  VehicleTypeDto,
  VehicleTypeSpecDto,
  PresentContainerGroupDto,
  WasteRequestDto,
  WasteRequestSummaryDto,
} from '@technic/contracts';
import { apiDownload, apiFetch, apiFetchBlob } from '@shared/api';

type Query = Record<string, unknown>;

export const usersApi = {
  list: (q: Query) => apiFetch<ListResult<UserDto>>('/users', { query: q }),
  create: (body: CreateUserInput) => apiFetch<UserDto>('/users', { method: 'POST', body }),
  update: (id: string, body: UpdateUserInput) =>
    apiFetch<UserDto>(`/users/${id}`, { method: 'PATCH', body }),
  setPassword: (id: string, newPassword: string) =>
    apiFetch<{ ok: boolean }>(`/users/${id}/password`, { method: 'POST', body: { newPassword } }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  /** Отказ по нерассмотренной заявке на регистрацию: причина уходит в аудит. */
  reject: (id: string, reason: string) =>
    apiFetch<{ ok: boolean }>(`/users/${id}/reject`, { method: 'POST', body: { reason } }),
  /** Возврат из архива (ADR 0063): учётка остаётся неактивной, отказ снова становится заявкой. */
  restore: (id: string) => apiFetch<UserDto>(`/users/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем (ADR 0063) — только из архива и только администратором. */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/users/${id}/purge`, { method: 'DELETE' }),
  pendingCount: () => apiFetch<{ count: number }>('/users/pending-count'),
};

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
   * Наполнение справочника кадровой выгрузкой (ADR 0047). `dryRun` — обязательный первый шаг:
   * заведение живых людей необратимо, поэтому сначала сервер отвечает отчётом, ничего не записав.
   */
  import: (body: DriversImportBody) =>
    apiFetch<DriversImportReportDto>('/drivers/import', { method: 'POST', body }),
  /** Категории ВУ для формы: справочник наполнен миграцией и на чтение. */
  licenseCategories: () =>
    apiFetch<{ id: string; code: string; name: string; description: string }[]>(
      '/drivers/license-categories',
    ),
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
   * Что у этой машины на этот день: её рейсы и графы шапки от прошлого рейса. Форма перевода в
   * работу наследует ими реквизиты выезда — прицеп, гаражный номер, вид сообщения и перевозки:
   * они описывают машину в рейсе и правятся раз в сезон, а не в каждый рейс.
   */
  suggest: (q: { vehicleId: string; date: string }) =>
    apiFetch<{ routes: VehicleRouteDto[]; trip: RouteTripFields | null }>(
      '/vehicle-routes/suggest',
      { query: q },
    ),
  create: (body: {
    vehicleId: string;
    routeDate: string;
    driverPersonId?: string | null;
    trip?: RouteTripFields;
    comment?: string;
  }) => apiFetch<VehicleRouteDto>('/vehicle-routes', { method: 'POST', body }),
  update: (
    id: string,
    body: {
      version: number;
      driverPersonId?: string | null;
      trip?: RouteTripFields;
      comment?: string;
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
  /** Новый порядок талонов — полным составом рейса. */
  order: (id: string, body: { requestIds: string[]; version: number }) =>
    apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/order`, { method: 'PUT', body }),
  issueWaybill: (id: string, version: number) =>
    apiFetch<VehicleRouteDto>(`/vehicle-routes/${id}/waybill`, {
      method: 'POST',
      body: { version },
    }),
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
  update: (id: string, body: UpdateVehicleTypeInput) =>
    apiFetch<VehicleTypeDto>(`/vehicle-types/${id}`, { method: 'PATCH', body }),
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
  update: (id: string, body: UpdateVehicleInput) =>
    apiFetch<VehicleDto>(`/vehicles/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/vehicles/${id}`, { method: 'DELETE' }),
  restore: (id: string) => apiFetch<VehicleDto>(`/vehicles/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива (ADR 0060). */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/vehicles/${id}/purge`, { method: 'DELETE' }),
};

export const vehicleRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests', { query: q }),
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
   * Перегоны заявки: доставка техники на объект и вывоз с него. Пусто — их не заводили: технику
   * могли привезти тралом, и тогда листа на перегон не бывает вовсе.
   */
  relocations: (id: string) => apiFetch<VehicleRouteDto[]>(`/vehicle-requests/${id}/relocations`),
  createRelocation: (id: string, body: CreateRelocationRouteBody) =>
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
    extra: {
      comment?: string;
      assignment?: AssignVehicleBody;
      schedule?: ConfirmScheduleBody;
      completion?: CompleteVehicleRequestInput;
    } = {},
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
      },
    }),
  /**
   * Сменить машину и ставки у заявки, которая уже в работе (ADR 0048): техника сломалась, ушла на
   * другой объект или её перепутали при переводе в работу. Статус при этом не меняется — тем и
   * отличается от повторного перевода в работу, которым назначение переписывали до сих пор.
   * Заявка переезжает в рейс новой машины той же транзакцией.
   */
  changeAssignment: (id: string, body: ChangeVehicleAssignmentBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/assignment`, { method: 'PATCH', body }),
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
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/vehicle-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/restore`, { method: 'POST' }),
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
