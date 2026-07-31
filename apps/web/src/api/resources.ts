import type {
  CancelWaybillInput,
  CreateDriverBody,
  DriverDto,
  DriverSelectionDto,
  WaybillDto,
  DriverLicenseBody,
  RevokeDriverLicenseInput,
  UpdateDriverInput,
  VerifyDriverLicenseBody,
  AssignVehicleBody,
  AttachVehicleTypeSpecInput,
  CompleteVehicleRequestInput,
  CompleteWasteRequestInput,
  ConfirmScheduleBody,
  ContainerKind,
  ContainerTypeDto,
  CounterpartyDto,
  CreateContainerTypeInput,
  CreateCounterpartyInput,
  CreateDepartmentInput,
  CreateObjectInput,
  CreateUserInput,
  CreateVehicleCategoryInput,
  CreateVehicleInput,
  CreateVehicleRequestInput,
  CreateVehicleSpecInput,
  CreateVehicleTypeInput,
  CreateWasteTariffInput,
  DownloadUrlDto,
  FileDisposition,
  FileDto,
  ListResult,
  DepartmentDto,
  ObjectDto,
  RequestHistoryEntryDto,
  RequestStatus,
  RequestType,
  RequestWaybillDto,
  UpdateContainerTypeInput,
  UpdateCounterpartyInput,
  UpdateDepartmentInput,
  UpdateObjectInput,
  UpdateUserInput,
  UpdateVehicleCategoryInput,
  UpdateVehicleInput,
  UpdateVehicleRequestInput,
  UpdateVehicleSpecInput,
  UpdateVehicleTypeInput,
  UpdateVehicleTypeSpecInput,
  UpdateWasteTariffInput,
  UpdateWasteTypeInput,
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
  VehicleRequestHistorySummaryDto,
  VehicleRequestSummaryDto,
  VehicleSpecDto,
  VehicleTypeDto,
  VehicleTypeSpecDto,
  WasteRequestDto,
  WasteRequestSummaryDto,
  WasteTariffDto,
  WasteTypeDto,
  ResolveWasteTariffResultDto,
} from '@technic/contracts';
import { API_BASE, apiFetch, apiFetchBlob } from './client';

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
  pendingCount: () => apiFetch<{ count: number }>('/users/pending-count'),
};

/** Справочник отделов (ADR 0040) — вторая ось области, тот же набор операций, что у объектов. */
export const departmentsApi = {
  list: (q: Query) => apiFetch<ListResult<DepartmentDto>>('/departments', { query: q }),
  create: (body: CreateDepartmentInput) =>
    apiFetch<DepartmentDto>('/departments', { method: 'POST', body }),
  update: (id: string, body: UpdateDepartmentInput) =>
    apiFetch<DepartmentDto>(`/departments/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<DepartmentDto>(`/departments/${id}`, { method: 'DELETE' }),
};

export const objectsApi = {
  list: (q: Query) => apiFetch<ListResult<ObjectDto>>('/objects', { query: q }),
  create: (body: CreateObjectInput) => apiFetch<ObjectDto>('/objects', { method: 'POST', body }),
  update: (id: string, body: UpdateObjectInput) =>
    apiFetch<ObjectDto>(`/objects/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<ObjectDto>(`/objects/${id}`, { method: 'DELETE' }),
};

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
  addLicense: (id: string, body: DriverLicenseBody) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses`, { method: 'POST', body }),
  verifyLicense: (id: string, licenseId: string, body: VerifyDriverLicenseBody) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}/verify`, { method: 'POST', body }),
  revokeLicense: (id: string, licenseId: string, body: RevokeDriverLicenseInput) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}/revoke`, { method: 'POST', body }),
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
   * Выгрузка бланка. Переход по ссылке, а не fetch с blob: ответ приходит с
   * `Content-Disposition: attachment`, браузер сохраняет файл сам и со страницы не уводит —
   * тем же приёмом скачиваются вложения заявок.
   */
  exportUrl: (id: string) => `${API_BASE}/waybills/${id}/export`,
  /**
   * Бланк, готовый к печати (ADR 0041): PDF показывается фреймом и печатается диалогом браузера,
   * не оседая файлом на машине. Не ссылкой, а телом ответа — фрейму его отдают из памяти вкладки.
   */
  printPdf: (id: string) => apiFetchBlob(`/waybills/${id}/print`),
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
};

export const containerTypesApi = {
  list: (q: Query) => apiFetch<ListResult<ContainerTypeDto>>('/container-types', { query: q }),
  create: (body: CreateContainerTypeInput) =>
    apiFetch<ContainerTypeDto>('/container-types', { method: 'POST', body }),
  // Удаления нет: деактивация через update({ isActive: false }).
  update: (id: string, body: UpdateContainerTypeInput) =>
    apiFetch<ContainerTypeDto>(`/container-types/${id}`, { method: 'PATCH', body }),
};

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
};

// ── ТТХ и категории типов ТС (ADR 0016) ──
export const vehicleSpecsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleSpecDto>>('/vehicle-specs', { query: q }),
  create: (body: CreateVehicleSpecInput) =>
    apiFetch<VehicleSpecDto>('/vehicle-specs', { method: 'POST', body }),
  // `code` неизменяем; `unit`/`decimals` сервер запретит менять, как только ТТХ привязан к типам.
  update: (id: string, body: UpdateVehicleSpecInput) =>
    apiFetch<VehicleSpecDto>(`/vehicle-specs/${id}`, { method: 'PATCH', body }),
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
};

export const vehicleRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests', { query: q }),
  /**
   * Что портал знает о будущем путевом листе до перевода заявки в работу (ADR 0037): выписывается
   * ли он на выбранную машину, на какую дату и чем заполнить графы шапки — их наследуют от
   * прошлого листа этой машины.
   */
  waybillPrefill: (id: string, vehicleId: string) =>
    apiFetch<{
      required: boolean;
      formLabel: string | null;
      reason: string | null;
      tripDate: string;
      fields: {
        withTrailer: boolean;
        trailer1Model: string;
        trailer1RegNumber: string;
        trailer2Model: string;
        trailer2RegNumber: string;
        garageNumber: string;
        communicationKind: string;
        transportationKind: string;
      } | null;
    }>(`/vehicle-requests/${id}/waybill-prefill`, { query: { vehicleId } }),
  /**
   * Лист, выписанный по заявке (ADR 0041) — его печатают из карточки, не уходя в журнал. `null`
   * приходит там, где листа нет: аренда, заказ техники на объект, заявка не в работе.
   */
  waybill: (id: string) => apiFetch<RequestWaybillDto | null>(`/vehicle-requests/${id}/waybill`),
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
  /** Виза руководителя строительства: `approved: false` — отзыв (ADR 0025). */
  setApproval: (id: string, approved: boolean, version: number) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/approval`, {
      method: 'PATCH',
      body: { approved, version },
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

// Заведения типа здесь нет: тип появляется вместе с первой ценой (wasteTariffsApi.create,
// ADR 0017). Удаления тоже нет — деактивация через update({ isActive: false }).
export const wasteTypesApi = {
  list: (q: Query) => apiFetch<ListResult<WasteTypeDto>>('/waste-types', { query: q }),
  update: (id: string, body: UpdateWasteTypeInput) =>
    apiFetch<WasteTypeDto>(`/waste-types/${id}`, { method: 'PATCH', body }),
};

export const wasteTariffsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteTariffDto>>('/waste-tariffs', { query: q }),
  /**
   * Тариф под пару «тип мусора × техника» — предпросмотр цены в форме заявки. Цель подбора —
   * либо конкретный тип из справочника, либо вид техники целиком: вывоз мусора заказывает объём
   * и машину не называет (ADR 0022). Оператор задан — цена его прайса; не задан — минимальная
   * среди операторов с пометкой `isMinimum` (цена «от», ADR 0026). Незаданный прайс приходит как
   * `{ tariff: null }`, а не ошибкой: сбой запроса форма показывает иначе, чем отсутствие цены.
   */
  resolve: (
    wasteTypeId: string,
    target: { containerTypeId: string } | { containerKind: ContainerKind },
    operatorCounterpartyId?: string | null,
  ) =>
    apiFetch<ResolveWasteTariffResultDto>('/waste-tariffs/resolve', {
      query: {
        wasteTypeId,
        ...target,
        ...(operatorCounterpartyId ? { operatorCounterpartyId } : {}),
      },
    }),
  create: (body: CreateWasteTariffInput) =>
    apiFetch<WasteTariffDto>('/waste-tariffs', { method: 'POST', body }),
  /** Правка цены не переписывает суммы оформленных заявок: в них снимок тарифа (ADR 0009). */
  update: (id: string, body: UpdateWasteTariffInput) =>
    apiFetch<WasteTariffDto>(`/waste-tariffs/${id}`, { method: 'PATCH', body }),
};

export const wasteRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteRequestDto>>('/waste-requests', { query: q }),
  /** Наличие контейнеров на площадках (присутствующие заявки установки). */
  present: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/present', { query: q }),
  /** Счётчики заявок по статусам — сводка над списком; сужается только фильтром по объекту. */
  summary: (q: Query) => apiFetch<WasteRequestSummaryDto>('/waste-requests/summary', { query: q }),
  get: (id: string) => apiFetch<WasteRequestDto>(`/waste-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0012). */
  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`/waste-requests/${id}/history`),
  create: (body: WasteRequestPayload) =>
    apiFetch<WasteRequestDto>('/waste-requests', { method: 'POST', body }),
  update: (id: string, body: WasteRequestUpdatePayload) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, { method: 'PATCH', body }),
  /** Назначение/снятие оператора вывоза; предмет заявки и тариф не пересчитываются (ADR 0010). */
  assignOperator: (id: string, operatorCounterpartyId: string | null, version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/operator`, {
      method: 'PATCH',
      body: { operatorCounterpartyId, version },
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
